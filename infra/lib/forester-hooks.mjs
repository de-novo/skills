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
import { randomUUID } from 'node:crypto';

export const HOOK_MARKER = 'de-novo forester hook';

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
    const unchanged = next == null ? !existsSync(store.file) : existsSync(store.file) && current === next;
    if (unchanged) {
      row.action = remove ? 'nothing to remove' : 'already installed';
      rows.push(row);
      continue;
    }
    row.action = remove ? (apply ? 'removed' : 'would remove') : (apply ? (before === 'installed' ? 'updated' : 'installed') : 'would install');
    if (apply) {
      if (next == null) unlinkSync(store.file);
      else atomicWrite(store.file, next);
      row.after = storeState(store);
    }
    rows.push(row);
  }
  return rows;
}

export function formatHooksReport(rows, { apply, remove }) {
  const width = Math.max(...rows.map((row) => row.tool.length));
  const lines = [`■ forester hooks${remove ? ' --remove' : ''}${apply ? ' --apply' : ''}`];
  for (const row of rows) lines.push(`  ${row.tool.padEnd(width)}  ${row.before.padEnd(9)}  ${row.action.padEnd(22)}  ${row.file}`);
  const acted = rows.filter((row) => ['installed', 'updated', 'removed'].includes(row.action)).length;
  const would = rows.filter((row) => row.action.startsWith('would')).length;
  lines.push(apply ? `  ${remove ? 'removed' : 'installed'} ${acted}/${rows.length}` : `  would change ${would}/${rows.length}; rerun with --apply`);
  return lines.join('\n');
}
