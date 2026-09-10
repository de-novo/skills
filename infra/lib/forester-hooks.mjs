// Forester's hook installer: one marked entry in each tool's own hook store,
// so a session serve holds reports running / idle / needs-input the same
// way for every tool, not only Claude Code. Claude Code needs none of this:
// serve hands it a per-session --settings file. The other stores are global
// to the person's account, so every entry written here is gated on
// FORESTER_EVENTS, which only a serve session carries; a session started any
// other way runs the hook and it does nothing. Entries carry a marker so
// `hooks --remove` takes back exactly what `hooks --apply` wrote.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const HOOK_MARKER = 'de-novo forester hook';
export const TRUST_MARKER = 'de-novo forester hook trust';

function fail(message) {
  throw new Error(`forester: ${message}`);
}

function homeOf(environment) {
  return environment.HOME || homedir();
}

// Every command is the same shape: with FORESTER_EVENTS naming a file
// under Forester's own state directory, append one JSON line naming the
// event; otherwise consume stdin and do nothing. The directory test is
// what keeps a global hook from being an append-anywhere primitive: a
// process that sets FORESTER_EVENTS to some other path gets nothing.
// `payload` tools already send a JSON object that names the event, so it is
// appended as is; the others get a line written here.
function hookCommand(event, { payload }) {
  // The seat's file (DRYAD_EVENTS) is the address whoever launched the
  // tool; FORESTER_EVENTS is serve's older name for the same file.
  const target = 'E="${DRYAD_EVENTS:-$FORESTER_EVENTS}"';
  const append = payload
    ? 'cat >> "$E" && printf \'\\n\' >> "$E"'
    : `printf '{"hook_event_name":"${event}"}\\n' >> "$E"`;
  const inside = 'case "$E" in "${GROVE_STATE_DIR:-$HOME/.dev-infra}"/dryads/events/*|"${GROVE_STATE_DIR:-$HOME/.dev-infra}"/foresters/*) true ;; *) false ;; esac';
  return `# ${HOOK_MARKER}\n${target}; if [ -n "$E" ] && ${inside}; then ${append}; else cat >/dev/null 2>&1 || :; fi`;
}

const CLAUDE_LIKE_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'Notification'];
const CODEX_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'];
// Cursor's store names events in camelCase and its payload does not name
// the event, so each entry writes the Claude-style name it maps to.
const CURSOR_EVENTS = [
  ['beforeSubmitPrompt', 'UserPromptSubmit'],
  ['preToolUse', 'PreToolUse'],
  ['postToolUse', 'PostToolUse'],
  ['stop', 'Stop'],
];

// The OpenCode plugin. Both plugin generations discover the same file:
// OpenCode 1 calls server(), OpenCode 2 calls setup(). Events are mapped to
// the same names the hooks use, so serve reads one format.
export const OPENCODE_PLUGIN_SOURCE = `// ${HOOK_MARKER}
import { appendFileSync } from "node:fs";
const V1 = { busy: "UserPromptSubmit", idle: "Stop" };
const V2 = {
  "session.execution.started": "UserPromptSubmit",
  "session.execution.succeeded": "Stop",
  "session.execution.failed": "Stop",
  "session.execution.interrupted": "Stop",
  "permission.asked": "permission",
  "permission.replied": "PreToolUse",
};
function report(name) {
  const file = process.env.FORESTER_EVENTS;
  if (!file || !name) return;
  const line = name === "permission"
    ? { hook_event_name: "Notification", notification_type: "permission_prompt" }
    : { hook_event_name: name };
  try { appendFileSync(file, JSON.stringify(line) + "\\n"); } catch {}
}
function v1(event) {
  if (event.type === "permission.asked") return "permission";
  if (event.type === "permission.replied") return "PreToolUse";
  if (event.type !== "session.status") return null;
  return V1[event.properties?.status?.type] ?? null;
}
export default {
  id: "de-novo-forester",
  server() { return { event: async ({ event }) => report(v1(event)) }; },
  setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) report(V2[event.type]);
    })().catch(() => {});
    return () => controller.abort();
  },
};
`;

// ------------------------------------------------------------- codex trust

// Codex runs a user-level hook only after a person has trusted that exact
// handler: it keeps `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]
// trusted_hash = "sha256:…"` in config.toml and skips a handler whose hash
// is missing or differs (codex-rs/hooks/src/engine/discovery.rs,
// hook_hash; codex-rs/config/src/fingerprint.rs, version_for_toml). The
// hash is over the normalized identity {event_name, hooks:[handler]} as
// canonical JSON, which this reproduces; it matched four handlers Codex
// itself had trusted on the machine it was written on (2026-09-10).
// hooks --apply records trust for exactly the entries it installed, and
// --remove takes those records back; a table a person wrote is never
// touched, and a key that already has one is left alone.
const CODEX_EVENT_LABELS = Object.freeze({
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SessionEnd: 'session_end',
});

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

// The trust hash for one command handler, normalized the way Codex does
// before hashing: timeout as given (default 600, or 1 for SessionEnd),
// async false, no matcher.
export function codexHookHash(event, handler) {
  const label = CODEX_EVENT_LABELS[event];
  if (label == null) fail(`no Codex event label for ${event}.`);
  const timeout = handler.timeout ?? (event === 'SessionEnd' ? 1 : 600);
  const identity = { event_name: label, hooks: [{ type: 'command', command: handler.command, timeout, async: false }] };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalJson(identity))).digest('hex')}`;
}

// The trust records the rendered store needs: one per handler of ours.
export function codexTrustRecords(store, renderedText) {
  const doc = parseJson(renderedText, store.file);
  const records = [];
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(groups) || CODEX_EVENT_LABELS[event] == null) continue;
    groups.forEach((group, groupIndex) => {
      (group.hooks ?? []).forEach((handler, handlerIndex) => {
        if (!isOurs(handler)) return;
        records.push({ key: `${store.file}:${CODEX_EVENT_LABELS[event]}:${groupIndex}:${handlerIndex}`, hash: codexHookHash(event, handler) });
      });
    });
  }
  return records;
}

function tomlKey(key) {
  return `[hooks.state.${JSON.stringify(key)}]`;
}

// config.toml with our trust tables replaced: every block we marked is
// dropped, then, unless removing, one block per record is appended for a
// key the file does not already hold. Textual on purpose: the rest of the
// file is a person's and is copied byte for byte.
const TRUST_BLOCK = new RegExp(`\\n# ${TRUST_MARKER}\\n\\[hooks\\.state\\."[^"\\n]*"\\]\\ntrusted_hash = "[^"\\n]*"\\n`, 'g');

export function renderCodexTrust(currentText, records, { remove = false } = {}) {
  // Every block of ours is one leading newline and three lines, so taking
  // them back returns the file to its bytes. A file that did not end in a
  // newline gets one before the first block and keeps it after removal.
  let text = (currentText ?? '').replace(TRUST_BLOCK, '');
  if (remove) return text;
  const additions = records.filter((record) => !text.includes(tomlKey(record.key)));
  if (additions.length === 0) return text;
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  for (const record of additions) {
    text += `\n# ${TRUST_MARKER}\n${tomlKey(record.key)}\ntrusted_hash = ${JSON.stringify(record.hash)}\n`;
  }
  return text;
}

function codexConfigFile(store) {
  return path.join(path.dirname(store.file), 'config.toml');
}

// ------------------------------------------------------------------ stores

export function hookStores(environment = process.env) {
  const home = homeOf(environment);
  const xdg = environment.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    {
      tool: 'codex',
      file: path.join(environment.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
      present: existsSync(environment.CODEX_HOME || path.join(home, '.codex')),
      kind: 'claude-like',
      events: CODEX_EVENTS,
      payload: true,
    },
    {
      tool: 'grok',
      file: path.join(home, '.grok', 'hooks', 'de-novo-forester.json'),
      present: existsSync(path.join(home, '.grok')),
      kind: 'claude-like',
      events: CLAUDE_LIKE_EVENTS,
      payload: true,
      own: true,
    },
    {
      tool: 'cursor-agent',
      file: path.join(home, '.cursor', 'hooks.json'),
      present: existsSync(path.join(home, '.cursor')),
      kind: 'cursor',
      events: CURSOR_EVENTS,
      payload: false,
    },
    {
      tool: 'opencode',
      file: path.join(environment.OPENCODE_CONFIG_DIR || path.join(xdg, 'opencode'), 'plugins', 'de-novo-forester.js'),
      present: existsSync(environment.OPENCODE_CONFIG_DIR || path.join(xdg, 'opencode')),
      kind: 'plugin',
      own: true,
    },
  ];
}

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text, file) {
  if (text.trim().length === 0) return {};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    fail(`${file}: not JSON (${error.message}); fix or move it before hooks --apply.`);
  }
  if (!isMap(doc)) fail(`${file}: must hold a JSON object.`);
  return doc;
}

function isOurs(entry) {
  return JSON.stringify(entry).includes(HOOK_MARKER);
}

// Claude-like stores: hooks.<Event> is a list of matcher groups, each with
// a hooks list of commands. Ours is one group per event, appended after the
// person's own groups and replaced in place on a re-apply.
function renderClaudeLike(text, store, { remove }) {
  const doc = parseJson(text, store.file);
  const hooks = isMap(doc.hooks) ? { ...doc.hooks } : {};
  for (const event of store.events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].filter((group) => !isOurs(group)) : [];
    if (!remove) {
      groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(event, store), timeout: 10 }] });
    }
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  return JSON.stringify({ ...doc, hooks }, null, 2) + '\n';
}

// Cursor: hooks.<event> is a flat list of { command, timeout }.
function renderCursor(text, store, { remove }) {
  const doc = parseJson(text, store.file);
  const hooks = isMap(doc.hooks) ? { ...doc.hooks } : {};
  for (const [event, mapped] of store.events) {
    const entries = Array.isArray(hooks[event]) ? hooks[event].filter((entry) => !isOurs(entry)) : [];
    if (!remove) entries.push({ command: hookCommand(mapped, store), timeout: 10 });
    if (entries.length === 0) delete hooks[event];
    else hooks[event] = entries;
  }
  return JSON.stringify({ ...doc, hooks }, null, 2) + '\n';
}

// What the store would hold after apply or remove. `null` means the file
// should not exist (a store Forester owns outright, after remove).
export function renderStore(store, currentText, { remove = false } = {}) {
  if (store.kind === 'plugin') return remove ? null : OPENCODE_PLUGIN_SOURCE;
  if (store.own) {
    if (remove) return null;
    return renderClaudeLike('', store, { remove: false });
  }
  if (store.kind === 'cursor') return renderCursor(currentText ?? '', store, { remove });
  return renderClaudeLike(currentText ?? '', store, { remove });
}

export function storeState(store) {
  if (!existsSync(store.file)) return 'absent';
  const text = readFileSync(store.file, 'utf8');
  return text.includes(HOOK_MARKER) ? 'installed' : 'present';
}

function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, file);
}

// One row per tool: what is there, what would happen, what happened.
export function applyHooks({ environment = process.env, apply = false, remove = false } = {}) {
  const rows = [];
  for (const store of hookStores(environment)) {
    const before = storeState(store);
    const row = { tool: store.tool, file: store.file, before, action: 'none', after: before };
    if (!store.present) {
      row.action = 'skip: tool not installed';
      rows.push(row);
      continue;
    }
    const current = existsSync(store.file) ? readFileSync(store.file, 'utf8') : '';
    const next = renderStore(store, current, { remove });
    // Codex: the trust records for our entries live in config.toml beside
    // the store; they change with the store and are reported with it.
    let trust = null;
    if (store.tool === 'codex') {
      const configFile = codexConfigFile(store);
      const configText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
      const records = remove ? [] : codexTrustRecords(store, next ?? '');
      const configNext = renderCodexTrust(configText, records, { remove });
      trust = { file: configFile, records: records.length, changed: configNext !== configText, next: configNext };
      row.trust = `${remove ? 'trust records removed from' : `${records.length} trust record${records.length === 1 ? '' : 's'} in`} ${configFile}`;
    }
    const unchanged = (next == null ? !existsSync(store.file) : existsSync(store.file) && current === next) && !(trust?.changed);
    if (unchanged) {
      row.action = remove ? 'nothing to remove' : 'already installed';
      rows.push(row);
      continue;
    }
    row.action = remove ? (apply ? 'removed' : 'would remove') : (apply ? (before === 'installed' ? 'updated' : 'installed') : 'would install');
    if (apply) {
      if (next == null) unlinkSync(store.file);
      else atomicWrite(store.file, next);
      if (trust?.changed) atomicWrite(trust.file, trust.next);
      row.after = storeState(store);
    }
    rows.push(row);
  }
  return rows;
}

export function formatHooksReport(rows, { apply, remove }) {
  const width = Math.max(...rows.map((row) => row.tool.length));
  const lines = [`■ forester hooks${remove ? ' --remove' : ''}${apply ? ' --apply' : ''}`];
  for (const row of rows) {
    lines.push(`  ${row.tool.padEnd(width)}  ${row.before.padEnd(9)}  ${row.action.padEnd(22)}  ${row.file}`);
    if (row.trust) lines.push(`  ${' '.repeat(width)}  ${row.trust}`);
  }
  const acted = rows.filter((row) => ['installed', 'updated', 'removed'].includes(row.action)).length;
  const would = rows.filter((row) => row.action.startsWith('would')).length;
  lines.push(apply ? `  ${remove ? 'removed' : 'installed'} ${acted}/${rows.length}` : `  would change ${would}/${rows.length}; rerun with --apply`);
  return lines.join('\n');
}
