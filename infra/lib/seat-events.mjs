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
export function doingFromEvents(text) {
  let doing = null;
  for (const event of events(text)) {
    const name = canonicalEvent(event.hook_event_name ?? event.hookEventName);
    if (name !== 'PreToolUse' && name !== 'PostToolUse') continue;
    const tool = event.tool_name ?? event.toolName;
    if (typeof tool !== 'string' || tool.length === 0) continue;
    const input = event.tool_input ?? event.toolInput ?? {};
    const target = [input.file_path, input.command, input.pattern, input.skill, input.url]
      .find((value) => typeof value === 'string' && value.length > 0);
    doing = target == null ? tool : `${tool} ${target.replace(/\s+/g, ' ').slice(0, 80)}`;
  }
  return doing;
}

// The seat's activity as anyone may read it: the state and the doing line
// from its events file, and when that file last changed. Null when no
// session has written yet.
export function seatActivity(slug, id, environment = process.env) {
  const file = seatEventsPath(slug, id, environment);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const state = stateFromEvents(text);
  const doing = doingFromEvents(text);
  if (state == null && doing == null) return null;
  return { state, doing, changed_at: statSync(file).mtime.toISOString(), events: file };
}
