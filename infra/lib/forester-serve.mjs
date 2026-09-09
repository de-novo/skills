// Forester's daemon: the one thing in this catalog that owns terminals. It
// keeps the budget filled (the same allocation as `assign --apply`), starts
// each seated item's tool as a real interactive session in a pseudo-terminal
// held here, reads the tool's own hook events for running / idle /
// needs-input, closes a session once its seat reported done, and lets a
// person attach to any session over a local socket. It decides nothing that
// `assign` would not; everything it does is readable from `forester status`.
//
// The pseudo-terminal comes from @lydell/node-pty, an optional dependency:
// every other verb works without it, and `serve` says so when it is absent.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { parseDryadCliArgs, readDryadState, runDryad } from './dryad.mjs';
import { loadForester, sessionsPath } from './forester.mjs';

// The seat carries the Dryad skill's path, as `dryad seat --env` does.
const DRYAD_SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/dryad/SKILL.md');
const POLL_MS = 2000;
const CLOSE_GRACE_MS = 1500;
// What a viewer sees on attach: the session's most recent output.
const SCROLLBACK_BYTES = 256 * 1024;
export const SESSION_STATES = Object.freeze(['starting', 'running', 'idle', 'needs-input', 'exited', 'closed']);

function fail(message) {
  throw new Error(`forester: ${message}`);
}

function now() {
  return new Date().toISOString();
}

function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

function shellSingle(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// --------------------------------------------------------------- template

// The tool's argv with {task} replaced by the item's task line. Claude Code
// additionally gets --settings pointing at a file that carries the hooks,
// so nothing is written into the worktree or the person's own settings.
export function launchCommand({ toolName, tool, task, settingsFile = null }) {
  const args = tool.command.map((part) => part.replaceAll('{task}', task));
  const [file, ...rest] = args;
  if (settingsFile != null && path.basename(file) === 'claude') rest.push('--settings', settingsFile);
  return { file, args: rest, tool: toolName };
}

// Hook commands append the hook's own JSON payload, one line each, to the
// seat's events file. The payload names the event, so the file is the
// session's history and its last line is its state.
export function claudeSettings(eventsFile) {
  const command = `cat >> ${shellSingle(eventsFile)} && printf '\\n' >> ${shellSingle(eventsFile)}`;
  const hook = [{ hooks: [{ type: 'command', command }] }];
  // PreToolUse is what turns needs-input back into running once a person
  // has answered a permission prompt.
  return { hooks: { UserPromptSubmit: hook, PreToolUse: hook, PostToolUse: hook, Stop: hook, StopFailure: hook, SessionEnd: hook, Notification: hook } };
}

const EVENT_NAMES = new Map(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'PermissionRequest', 'Notification'].map((name) => [name.toLowerCase(), name]));

function canonicalEvent(raw) {
  if (typeof raw !== 'string') return null;
  return EVENT_NAMES.get(raw.replace(/[_-]/g, '').toLowerCase()) ?? raw;
}

const EVENT_STATES = Object.freeze({
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  Stop: 'idle',
  StopFailure: 'idle',
  SessionEnd: 'exited',
  PermissionRequest: 'needs-input',
});

// The state the last meaningful event implies, or null when the file says
// nothing yet. A Notification counts only when it is a prompt for a person.
// What the session is doing right now, read from the last tool event the
// hooks wrote: the tool's name and its target (a path, a command, a
// pattern), never the worker's own account of itself. Null until a tool
// has been used. The payload keys are Claude Code's; Codex and OpenCode
// send the same names, Cursor's hook maps to them.
export function doingFromEvents(text) {
  let doing = null;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
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

export function stateFromEvents(text) {
  let state = null;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Claude, Codex, and OpenCode name the event UserPromptSubmit; Grok
    // writes user_prompt_submit under a camelCase key. Compare on letters.
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

// Before its first prompt is submitted no hook can fire, yet a tool can
// already be parked on a dialog (trust, external imports, onboarding). The
// only evidence then is the screen, so a session still `starting` whose
// recent output ends on a confirm-or-cancel line is reported needs-input.
// This is the fallback, never the primary signal.
export function screenAsksForInput(text) {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()<>=][A-Z0-9]?/g, '').replace(/\x1b[78]/g, '');
  // A TUI draws many of its spaces as cursor moves, so the stripped text
  // may read "Entertoconfirm"; compare with every space removed.
  const tail = plain.split(/\r?\n/).map((line) => line.replace(/\s+/g, '')).filter(Boolean).slice(-6).join('');
  return /Entertoconfirm|Entertoselect|Esctocancel|Pressanykey|Pressentertoconfirm|\(y\/N\)|\(Y\/n\)/i.test(tail);
}

// ------------------------------------------------------------------ trust

// Claude Code parks a fresh git root on a trust dialog whose default is
// "exit". Its own error message names projects[<path>].hasTrustDialogAccepted
// in its state file as the way to pre-trust a folder, so that is what is
// written, for the seat's worktree only, atomically, and never when the file
// does not exist (the tool's own onboarding has not run).
export function claudeTrustFile(environment = process.env) {
  const configDir = environment.CLAUDE_CONFIG_DIR;
  return configDir ? path.join(configDir, '.claude.json') : path.join(homedir(), '.claude.json');
}

export function seedClaudeTrust(worktree, environment = process.env) {
  const file = claudeTrustFile(environment);
  if (!existsSync(file)) return { file, result: 'absent' };
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { file, result: 'unreadable', error: error.message };
  }
  if (state == null || typeof state !== 'object' || Array.isArray(state)) return { file, result: 'unreadable' };
  const projects = state.projects != null && typeof state.projects === 'object' ? state.projects : {};
  const existing = projects[worktree];
  if (existing != null && existing.hasTrustDialogAccepted === true) return { file, result: 'already' };
  state.projects = { ...projects, [worktree]: { ...(existing ?? {}), hasTrustDialogAccepted: true } };
  atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
  return { file, result: 'seeded' };
}

// ------------------------------------------------------------------ serve

async function loadPty() {
  try {
    const module = await import('@lydell/node-pty');
    return module.default ?? module;
  } catch (error) {
    fail(`serve needs @lydell/node-pty, which is an optional dependency: run npm install in the catalog (${error.message}).`);
  }
}

function seatEnvironment(seat, id, project, environment) {
  return {
    ...environment,
    DRYAD_ID: id,
    DRYAD_ENV: seat.env == null || seat.env === 'pending' ? '' : seat.env,
    DRYAD_BRANCH: seat.branch,
    DRYAD_PROJECT: project.root,
    DRYAD_SKILL,
    FORESTER_SEAT: id,
  };
}

export class ForesterServe {
  constructor({ project = null, environment = process.env, cwd = process.cwd(), pollMs = POLL_MS, log = console.log } = {}) {
    this.projectOption = project;
    this.environment = { ...environment };
    // The daemon is nobody's seat; its own children are.
    delete this.environment.DRYAD_ID;
    delete this.environment.FORESTER_SEAT;
    // A serve started from inside a Claude Code session must not make its
    // children look like that session's children.
    delete this.environment.CLAUDECODE;
    delete this.environment.CLAUDE_CODE_ENTRYPOINT;
    delete this.environment.CLAUDE_CODE_CHILD_SESSION;
    this.cwd = cwd;
    this.pollMs = pollMs;
    this.log = log;
    this.sessions = new Map();
    this.server = null;
    this.timer = null;
    this.stopping = false;
  }

  async start() {
    this.pty = await loadPty();
    const loaded = loadForester({ project: this.projectOption, environment: this.environment, cwd: this.cwd });
    this.project = loaded.project;
    this.snapshotFile = sessionsPath(this.project.slug, this.environment);
    this.dir = path.join(path.dirname(this.snapshotFile), this.project.slug);
    // A unix socket path is capped at about 100 bytes, and a state directory
    // can be longer than that, so the socket takes a short hashed name under
    // the OS temp dir. The snapshot records where it is.
    this.socketPath = path.join(tmpdir(), `de-novo-forester-${createHash('sha256').update(this.snapshotFile).digest('hex').slice(0, 12)}.sock`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const previous = existsSync(this.snapshotFile) ? readFileSync(this.snapshotFile, 'utf8') : null;
    if (previous != null) {
      const pid = Number((previous.match(/^pid: (\d+)$/m) ?? [])[1]);
      if (pid && pid !== process.pid && processAlive(pid)) fail(`serve already runs for ${this.project.slug} as pid ${pid}.`);
    }
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    await this.listen();
    this.writeSnapshot();
    this.log(`■ ${this.project.slug} — forester serve pid ${process.pid} · socket ${this.socketPath}`);
    await this.tick();
    this.timer = setInterval(() => { this.tick().catch((error) => this.log(`forester: ${error.message}`)); }, this.pollMs);
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.accept(socket));
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  // First line: {"attach": id, "cols": n, "rows": n}. Then raw bytes both ways
  // until the client closes. One session may have several viewers.
  accept(socket) {
    let head = '';
    const onHead = (chunk) => {
      head += chunk.toString('utf8');
      const newline = head.indexOf('\n');
      if (newline === -1) return;
      socket.off('data', onHead);
      const rest = head.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(head.slice(0, newline));
      } catch {
        socket.end(JSON.stringify({ error: 'first line must be JSON' }) + '\n');
        return;
      }
      if (request.list) {
        socket.end(JSON.stringify({ seats: this.snapshotSeats() }) + '\n');
        return;
      }
      const session = this.sessions.get(request.attach);
      if (session == null || session.pty == null) {
        socket.end(JSON.stringify({ error: `no live session for ${JSON.stringify(request.attach)}` }) + '\n');
        return;
      }
      socket.write(JSON.stringify({ ok: true, seat: request.attach, state: session.state }) + '\n');
      if (Number.isInteger(request.cols) && Number.isInteger(request.rows)) session.pty.resize(request.cols, request.rows);
      if (session.scrollback.length > 0) socket.write(session.scrollback);
      const forward = (data) => { if (!socket.destroyed) socket.write(data); };
      session.viewers.add(forward);
      if (rest.length > 0) session.pty.write(rest);
      socket.on('data', (chunk) => session.pty.write(chunk.toString('utf8')));
      socket.on('close', () => session.viewers.delete(forward));
      socket.on('error', () => session.viewers.delete(forward));
    };
    socket.on('data', onHead);
    socket.on('error', () => {});
  }

  async tick() {
    if (this.stopping) return;
    let loaded = loadForester({ project: this.projectOption, environment: this.environment, cwd: this.cwd });
    // 1. Fill the budget exactly as assign --apply would.
    for (const item of loaded.allocation.chosen) {
      const args = ['plan', item.id, '--task', item.task, '--by', 'forester', '--project', this.project.root, '--apply'];
      try {
        const code = runDryad({ options: parseDryadCliArgs(args), environment: this.environment, cwd: this.cwd });
        if (code !== 0) this.log(`forester: seat ${item.id} not planned (exit ${code})`);
      } catch (error) {
        this.log(error.message);
      }
    }
    loaded = loadForester({ project: this.projectOption, environment: this.environment, cwd: this.cwd });
    const { state } = readDryadState(this.project.slug, this.environment);
    // 2. Start a session for every active plan item without one; close the
    //    session of every item whose seat reported done.
    for (const item of loaded.items) {
      const session = this.sessions.get(item.id);
      if (item.state === 'active' && session == null) this.launch(item, state.seats[item.id], loaded.local);
      if (item.state === 'done' && session != null && session.pty != null) this.close(item.id, 'seat reported done');
    }
    // 3. Refresh what the hooks say.
    for (const session of this.sessions.values()) this.refresh(session);
    this.writeSnapshot();
  }

  launch(item, seat, local) {
    const toolName = item.tool ?? local?.tool;
    const tool = toolName == null ? null : local?.tools?.[toolName];
    const record = { id: item.id, tool: toolName ?? '-', state: 'starting', since: now(), pid: null, exit: null, pty: null, viewers: new Set(), events: null, note: null, scrollback: '' };
    this.sessions.set(item.id, record);
    if (tool == null) {
      record.state = 'exited';
      record.note = toolName == null ? 'no tool: set tool in the item or in the local file' : `tool ${toolName} is not declared under tools in the local file`;
      this.log(`forester: ${item.id}: ${record.note}`);
      return;
    }
    if (seat.worktree == null || !existsSync(seat.worktree)) {
      record.state = 'exited';
      record.note = `worktree missing: ${seat.worktree}`;
      return;
    }
    record.events = path.join(this.dir, `${item.id}.events`);
    // A fresh file per launch: a previous session's SessionEnd must not
    // read as this one's exit.
    writeFileSync(record.events, '');
    let settingsFile = null;
    if (path.basename(tool.command[0]) === 'claude') {
      settingsFile = path.join(this.dir, `${item.id}.claude-settings.json`);
      writeFileSync(settingsFile, JSON.stringify(claudeSettings(record.events), null, 2));
      const trust = seedClaudeTrust(seat.worktree, this.environment);
      this.log(`forester: ${item.id}: trust ${trust.result} (${trust.file})`);
    }
    const command = launchCommand({ toolName, tool, task: item.task, settingsFile });
    const env = seatEnvironment(seat, item.id, this.project, this.environment);
    env.FORESTER_EVENTS = record.events;
    try {
      record.pty = this.pty.spawn(command.file, command.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: seat.worktree, env });
    } catch (error) {
      record.state = 'exited';
      record.note = `spawn failed: ${error.message}`;
      this.log(`forester: ${item.id}: ${record.note}`);
      return;
    }
    record.pid = record.pty.pid;
    record.pty.onData((data) => {
      record.scrollback = (record.scrollback + data).slice(-SCROLLBACK_BYTES);
      for (const viewer of record.viewers) viewer(data);
    });
    record.pty.onExit(({ exitCode }) => {
      record.exit = exitCode;
      record.state = record.closing ? 'closed' : 'exited';
      record.pty = null;
      this.writeSnapshot();
    });
    this.log(`forester: ${item.id}: ${toolName} pid ${record.pid} in ${seat.worktree}`);
  }

  refresh(session) {
    if (session.pty == null || session.events == null || session.closing) return;
    let text = '';
    try {
      text = readFileSync(session.events, 'utf8');
    } catch {
      return;
    }
    const state = stateFromEvents(text);
    if (state != null && state !== session.state) session.state = state;
    // The doing line changes when the tool stream does; its clock starts
    // when it changes, so a reader sees how long the session has been on it.
    const doing = doingFromEvents(text);
    if (doing !== session.doing) {
      session.doing = doing;
      session.doing_since = doing == null ? null : now();
    }
    if (state == null && session.state === 'starting' && screenAsksForInput(session.scrollback)) session.state = 'needs-input';
    if (state == null && session.state === 'needs-input' && !screenAsksForInput(session.scrollback)) session.state = 'starting';
  }

  close(id, reason) {
    const session = this.sessions.get(id);
    if (session == null || session.pty == null) return;
    // Read the events one last time, so the closed record keeps what the
    // session was doing when its seat reported done.
    this.refresh(session);
    session.closing = true;
    session.state = 'closed';
    session.note = reason;
    const pty = session.pty;
    this.log(`forester: ${id}: closing (${reason})`);
    try { pty.kill('SIGHUP'); } catch {}
    setTimeout(() => { try { if (session.pty != null) pty.kill('SIGKILL'); } catch {} }, CLOSE_GRACE_MS).unref();
  }

  snapshotSeats() {
    const seats = {};
    for (const [id, session] of this.sessions) {
      seats[id] = { tool: session.tool, state: session.state, since: session.since, pid: session.pid, exit: session.exit, events: session.events, note: session.note, doing: session.doing ?? null, doing_since: session.doing_since ?? null };
    }
    return seats;
  }

  writeSnapshot() {
    atomicWrite(this.snapshotFile, stringify({ version: 1, project: this.project.slug, pid: process.pid, socket: this.socketPath, updated_at: now(), seats: this.snapshotSeats() }));
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer != null) clearInterval(this.timer);
    for (const id of this.sessions.keys()) this.close(id, 'serve stopped');
    await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS + 200));
    if (this.server != null) await new Promise((resolve) => this.server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
    rmSync(this.snapshotFile, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function runServe({ options, environment = process.env, cwd = process.cwd() }) {
  const serve = new ForesterServe({ project: options.project, environment, cwd, pollMs: Number(environment.FORESTER_POLL_MS) || POLL_MS });
  await serve.start();
  await new Promise((resolve) => {
    const finish = () => { serve.stop().then(resolve, resolve); };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  return 0;
}

// ----------------------------------------------------------------- attach

// A viewer for one session: raw stdin to the pty, pty output to stdout,
// Ctrl-] detaches. The session keeps running either way.
export function runAttach({ options, environment = process.env, cwd = process.cwd() }) {
  const loaded = loadForester({ project: options.project, environment, cwd });
  const sessions = loaded.sessions;
  if (sessions == null || !sessions.alive) fail(`no serve daemon for ${loaded.project.slug}; start one with forester serve.`);
  const id = options.id;
  return new Promise((resolve) => {
    const socket = createConnection(sessions.socket);
    const stdin = process.stdin;
    const restore = () => { if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); };
    socket.once('connect', () => {
      socket.write(JSON.stringify({ attach: id, cols: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 }) + '\n');
    });
    let head = '';
    let attached = false;
    socket.on('data', (chunk) => {
      if (attached) { process.stdout.write(chunk); return; }
      head += chunk.toString('utf8');
      const newline = head.indexOf('\n');
      if (newline === -1) return;
      const reply = JSON.parse(head.slice(0, newline));
      if (reply.error) { console.error(`forester: ${reply.error}`); socket.destroy(); resolve(1); return; }
      attached = true;
      process.stderr.write(`forester: attached to ${id} (${reply.state}); Ctrl-] detaches\n`);
      process.stdout.write(head.slice(newline + 1));
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', (data) => {
        if (data.includes(0x1d)) { restore(); socket.end(); return; }
        socket.write(data);
      });
    });
    socket.on('close', () => { restore(); process.stderr.write('\nforester: detached\n'); resolve(0); });
    socket.on('error', (error) => { restore(); console.error(`forester: ${error.message}`); resolve(1); });
  });
}
