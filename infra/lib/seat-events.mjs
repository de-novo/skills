// A seat's session events: the file the agent tools' hooks append to, and
// what is read from it. One place, so Dryad (which owns the seat), Forester
// serve (which may hold the session), Canopy, and Understory all read the
// same state and the same "doing" line whoever launched the tool.
//
//   <state>/dryads/events/<slug>/<id>.events            one JSON object per hook event
//   <state>/dryads/events/<slug>/<id>.claude-settings.json   hooks for a Claude Code session
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { dryadStateDirectory } from './dryad.mjs';

export function seatEventsDirectory(slug, environment = process.env) {
  return path.join(dryadStateDirectory(environment), 'events', slug);
}

export function seatEventsPath(slug, id, environment = process.env) {
  return path.join(seatEventsDirectory(slug, environment), `${id}.events`);
}

export function seatSettingsPath(slug, id, environment = process.env) {
  return path.join(seatEventsDirectory(slug, environment), `${id}.claude-settings.json`);
}

function shellSingle(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Hook commands append the hook's own JSON payload, one line each, to the
// seat's events file. The payload names the event, so the file is the
// session's history and its last line is its state. Claude Code takes
// these through --settings, so nothing is written into the worktree or
// the person's own settings.
export function claudeSettings(eventsFile) {
  const command = `cat >> ${shellSingle(eventsFile)} && printf '\\n' >> ${shellSingle(eventsFile)}`;
  const hook = [{ hooks: [{ type: 'command', command }] }];
  // PreToolUse is what turns needs-input back into running once a person
  // has answered a permission prompt.
  return { hooks: { UserPromptSubmit: hook, PreToolUse: hook, PostToolUse: hook, Stop: hook, StopFailure: hook, SessionEnd: hook, Notification: hook } };
}

const EVENT_NAMES = new Map(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'PermissionRequest', 'Notification'].map((name) => [name.toLowerCase(), name]));

// Claude, Codex, and OpenCode name the event UserPromptSubmit; Grok writes
// user_prompt_submit under a camelCase key. Compare on letters.
export function canonicalEvent(raw) {
  if (typeof raw !== 'string') return null;
  return EVENT_NAMES.get(raw.replace(/[_-]/g, '').toLowerCase()) ?? raw;
}

export const EVENT_STATES = Object.freeze({
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  Stop: 'idle',
  StopFailure: 'idle',
  SessionEnd: 'exited',
  PermissionRequest: 'needs-input',
});

function* events(text) {
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A torn line is not an event.
    }
  }
}

export function stateFromEvents(text) {
  let state = null;
  for (const event of events(text)) {
    const name = canonicalEvent(event.hook_event_name ?? event.hookEventName);
    if (name === 'Notification') {
      const kind = event.notification_type ?? event.notificationType ?? event.matcher ?? event.reason;
      if (kind === 'idle_prompt' || kind === 'permission_prompt' || kind === 'elicitation_dialog') state = 'needs-input';
      continue;
    }
    if (EVENT_STATES[name] != null) state = EVENT_STATES[name];
  }
  return state;
}

// What the session is doing right now, read from the last tool event the
// hooks wrote: the tool's name and its target (a path, a command, a
// pattern), never the worker's own account of itself. Null until a tool
// has been used. The payload keys are Claude Code's; Codex and OpenCode
// send the same names, Cursor's hook maps to them.
export function doingFromEvents(text, { base = null } = {}) {
  let doing = null;
  for (const event of events(text)) {
    const name = canonicalEvent(event.hook_event_name ?? event.hookEventName);
    if (name !== 'PreToolUse' && name !== 'PostToolUse') continue;
    const tool = event.tool_name ?? event.toolName;
    if (typeof tool !== 'string' || tool.length === 0) continue;
    const input = event.tool_input ?? event.toolInput ?? {};
    const target = [input.file_path, input.command, input.pattern, input.skill, input.url]
      .find((value) => typeof value === 'string' && value.length > 0);
    // A tool names files by their whole path; a reader wants them from the worktree.
    const shown = target == null ? null : (base ? target.split(`${base}/`).join('') : target).replace(/\s+/g, ' ').slice(0, 80);
    doing = shown == null ? tool : `${tool} ${shown}`;
  }
  return doing;
}

// Where the session's own transcript lives, when the tool says so. Claude
// Code puts transcript_path and session_id in every hook payload; a tool
// that does not is simply a session with no transcript to show.
export function transcriptFromEvents(text) {
  let found = null;
  for (const event of events(text)) {
    const file = event.transcript_path ?? event.transcriptPath;
    if (typeof file === 'string' && file.length > 0) found = { transcript: file, session_id: event.session_id ?? event.sessionId ?? null };
  }
  return found;
}

// The seat's activity as anyone may read it: the state and the doing line
// from its events file, when that file last changed, and the transcript
// the tool named. Null when no session has written yet.
export function seatActivity(slug, id, environment = process.env, { worktree = null } = {}) {
  const file = seatEventsPath(slug, id, environment);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const state = stateFromEvents(text);
  const doing = doingFromEvents(text, { base: worktree });
  if (state == null && doing == null) return null;
  const where = transcriptFromEvents(text);
  return { state, doing, changed_at: statSync(file).mtime.toISOString(), events: file, transcript: where?.transcript ?? null, session_id: where?.session_id ?? null };
}

// A Claude Code transcript as turns a person reads like a chat: what the
// person typed, what the agent said, and each tool call folded to one
// line with its input and result behind it. Records that are not part of
// the conversation (snapshots, titles, modes) are skipped. Nothing is
// copied or rewritten; the file is read where the tool left it.
export function readTranscript(file, { limit = 400, base = null } = {}) {
  if (!existsSync(file)) return null;
  const turns = [];
  const pending = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const at = record.timestamp ?? null;
    const content = record.message?.content;
    if (record.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) turns.push({ role: 'user', at, text: content });
        continue;
      }
      for (const part of content ?? []) {
        if (part.type === 'text' && part.text?.trim()) turns.push({ role: 'user', at, text: part.text });
        if (part.type === 'tool_result') {
          const call = pending.get(part.tool_use_id);
          const result = typeof part.content === 'string' ? part.content : (part.content ?? []).map((c) => c.text ?? '').join('\n');
          if (call) call.result = result.slice(0, 4000);
          else turns.push({ role: 'tool', at, name: 'result', input: '', result: result.slice(0, 4000) });
        }
      }
      continue;
    }
    for (const part of content ?? []) {
      if (part.type === 'text' && part.text?.trim()) turns.push({ role: 'assistant', at, text: part.text });
      if (part.type === 'tool_use') {
        const input = part.input ?? {};
        const target = [input.file_path, input.command, input.pattern, input.skill, input.url, input.prompt].find((v) => typeof v === 'string' && v.length > 0);
        const shown = target == null ? '' : (base ? target.split(`${base}/`).join('') : target).replace(/\s+/g, ' ').slice(0, 120);
        const turn = { role: 'tool', at, name: part.name, target: shown, input: JSON.stringify(input).slice(0, 4000), result: null };
        pending.set(part.id, turn);
        turns.push(turn);
      }
    }
  }
  return turns.length > limit ? turns.slice(turns.length - limit) : turns;
}
