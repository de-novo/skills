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
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify } from 'yaml';

import { parseDryadCliArgs, readDryadState, runDryad } from './dryad.mjs';
import { loadForester, seatArguments, sessionsPath } from './forester.mjs';
import { claudeSettings, doingFromEvents, seatEventsPath, seatSettingsPath, stateFromEvents } from './seat-events.mjs';

export { claudeSettings, doingFromEvents, stateFromEvents };

// The seat carries the Dryad skill's path, as `dryad seat --env` does.
const DRYAD_SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/dryad/SKILL.md');
const POLL_MS = 2000;
const CLOSE_GRACE_MS = 1500;
// What a viewer sees on attach: the session's most recent output.
const SCROLLBACK_BYTES = 256 * 1024;
// A seat whose overlay env is pending is planned again with a doubling wait
// between tries, capped, and given up after this many so a broken backend
// is not hammered; forester restart <id> starts the count over.
const PENDING_RETRIES = 5;
const PENDING_BACKOFF_MAX_MS = 60000;
export const SESSION_STATES = Object.freeze(['starting', 'running', 'idle', 'needs-input', 'exited', 'closed', 'failed']);
// Why a session could not be started, so a person knows which thing to fix.
export const FAILURE_KINDS = Object.freeze(['no-tool', 'tool-missing', 'env-pending', 'worktree-missing', 'spawn-failed']);

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
// in its state file as the way to pre-trust a folder. Granting trust is a
// person's decision, so by default serve writes nothing here and the parked
// session shows as needs-input for a person to answer through attach. Only
// a local file that sets tools.<name>.pretrust_worktrees: true has this
// written, for the seat's worktree only, atomically, and never when the
// file does not exist (the tool's own onboarding has not run).
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

// -------------------------------------------------------------- readiness

// The executable a template names, resolved the way the shell would: a
// path as given, a bare name through PATH. Null when nothing is there.
export function resolveExecutable(file, environment = process.env) {
  if (file.includes('/')) return existsSync(file) ? file : null;
  for (const dir of (environment.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Everything a launch needs, checked before anything is spawned. Each
// failure names its kind, so the session record says what to fix.
export function launchReadiness({ item, seat, local, environment = process.env }) {
  const toolName = item.tool ?? local?.tool ?? null;
  const tool = toolName == null ? null : local?.tools?.[toolName] ?? null;
  if (toolName == null) return { ok: false, kind: 'no-tool', note: 'no tool: set tool in the item or in the local file', toolName: null, tool: null };
  if (tool == null) return { ok: false, kind: 'no-tool', note: `tool ${toolName} is not declared under tools in the local file`, toolName, tool: null };
  const executable = resolveExecutable(tool.command[0], environment);
  if (executable == null) return { ok: false, kind: 'tool-missing', note: `${tool.command[0]} is not on PATH; install it or fix tools.${toolName}.command, then forester restart ${item.id}`, toolName, tool };
  if (seat.env === 'pending') return { ok: false, kind: 'env-pending', note: `overlay env ${item.id} is pending; serve retries dryad plan --apply with backoff`, toolName, tool };
  if (seat.worktree == null || !existsSync(seat.worktree)) return { ok: false, kind: 'worktree-missing', note: `worktree missing: ${seat.worktree}`, toolName, tool };
  return { ok: true, kind: null, note: null, toolName, tool, executable };
}

// ------------------------------------------------------------------ serve

// One serve per project: the lock is held for the daemon's lifetime and
// names its pid, so a second start finds it and stops, and a crashed
// daemon's lock is reclaimed by its dead pid, never by age.
export function acquireServeLock(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // The lock appears with its owner already written: a temporary file is
  // linked into place, which fails when the lock exists, so no reader ever
  // sees an empty lock.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, host: hostname() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(temporary, file);
        return () => {
          try { unlinkSync(file); } catch {}
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch {}
        if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid !== process.pid && !processAlive(owner.pid)) {
          try { unlinkSync(file); } catch {}
          continue;
        }
        fail(`serve already runs for this project as pid ${owner?.pid ?? '?'} (lock ${file}).`);
      }
    }
    fail(`could not take the serve lock ${file}.`);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

// Whether something answers at a socket path. A stale socket file from a
// crashed daemon does not; a live daemon does, and is not removed.
function socketAnswers(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

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
    // Seats whose overlay env is pending: how often they were planned again
    // and when the next try may go.
    this.pending = new Map();
    // What a previous daemon's snapshot said, so a relaunch after a crash
    // says it is a fresh context and not a native resume.
    this.previous = {};
    this.server = null;
    this.timer = null;
    this.releaseLock = null;
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
    // The lock settles who owns this project's serve before anything else
    // is touched; two starts at once leave exactly one running.
    this.releaseLock = acquireServeLock(`${this.snapshotFile}.serve.lock`);
    try {
      const previous = existsSync(this.snapshotFile) ? readFileSync(this.snapshotFile, 'utf8') : null;
      if (previous != null) {
        const pid = Number((previous.match(/^pid: (\d+)$/m) ?? [])[1]);
        if (pid && pid !== process.pid && processAlive(pid)) fail(`serve already runs for ${this.project.slug} as pid ${pid}.`);
        let doc = null;
        try { doc = parseYaml(previous); } catch {}
        if (doc?.seats != null && typeof doc.seats === 'object') {
          this.previous = doc.seats;
          const live = Object.entries(this.previous).filter(([, session]) => ['starting', 'running', 'idle', 'needs-input'].includes(session?.state));
          if (live.length > 0) this.log(`forester: previous serve pid ${pid || '?'} ended with ${live.length} live session${live.length === 1 ? '' : 's'} (${live.map(([id]) => id).join(', ')}); they cannot be resumed natively and will be launched again as fresh contexts`);
        }
      }
      if (existsSync(this.socketPath)) {
        if (await socketAnswers(this.socketPath)) fail(`another serve answers at ${this.socketPath}; not removing it.`);
        unlinkSync(this.socketPath);
      }
      await this.listen();
    } catch (error) {
      this.releaseLock();
      this.releaseLock = null;
      throw error;
    }
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
      if (request.restart != null) {
        socket.end(JSON.stringify(this.restart(request.restart)) + '\n');
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
      const args = seatArguments(item, loaded);
      try {
        const code = runDryad({ options: parseDryadCliArgs(args), environment: this.environment, cwd: this.cwd });
        if (code !== 0) this.log(`forester: seat ${item.id} not planned (exit ${code})`);
      } catch (error) {
        this.log(error.message);
      }
    }
    loaded = loadForester({ project: this.projectOption, environment: this.environment, cwd: this.cwd });
    const { state } = readDryadState(this.project.slug, this.environment);
    // 2. Start a session for every active plan item without one; retry a
    //    pending env instead of launching into it; close the session of
    //    every item whose seat reported done.
    for (const item of loaded.items) {
      const session = this.sessions.get(item.id);
      const seat = state.seats[item.id];
      if (item.state === 'active' && seat?.env === 'pending' && (session == null || session.pty == null)) {
        this.retryPending(item, loaded);
        continue;
      }
      if (item.state === 'active' && session == null) this.launch(item, seat, loaded.local);
      if (item.state === 'done' && session != null && session.pty != null) this.close(item.id, 'seat reported done');
    }
    // 3. Refresh what the hooks say.
    for (const session of this.sessions.values()) this.refresh(session);
    this.writeSnapshot();
  }

  // A pending overlay env is Dryad's to repair through the same plan
  // --apply; serve asks again with a doubling wait and gives up after a
  // fixed count, recording the failure for a person.
  retryPending(item, loaded) {
    const retry = this.pending.get(item.id) ?? { attempts: 0, nextAt: 0 };
    if (Date.now() < retry.nextAt) return;
    if (retry.attempts >= PENDING_RETRIES) {
      if (!this.sessions.has(item.id)) this.failSession(item, null, 'env-pending', `overlay env ${item.id} still pending after ${PENDING_RETRIES} plan --apply retries; fix the overlay, then forester restart ${item.id}`);
      return;
    }
    retry.attempts += 1;
    retry.nextAt = Date.now() + Math.min(this.pollMs * 2 ** retry.attempts, PENDING_BACKOFF_MAX_MS);
    this.pending.set(item.id, retry);
    let code;
    try {
      code = runDryad({ options: parseDryadCliArgs(seatArguments(item, loaded)), environment: this.environment, cwd: this.cwd });
    } catch (error) {
      code = 1;
      this.log(error.message);
    }
    if (code === 0) {
      this.pending.delete(item.id);
      this.log(`forester: ${item.id}: overlay env ready after ${retry.attempts} retr${retry.attempts === 1 ? 'y' : 'ies'}`);
    } else {
      this.log(`forester: ${item.id}: overlay env still pending (retry ${retry.attempts}/${PENDING_RETRIES}, next in ${Math.round((retry.nextAt - Date.now()) / 1000)}s)`);
    }
  }

  failSession(item, toolName, kind, note) {
    const record = { id: item.id, tool: toolName ?? '-', state: 'failed', since: now(), pid: null, exit: null, pty: null, viewers: new Set(), events: null, note, failure: { kind, note, at: now() }, scrollback: '' };
    this.sessions.set(item.id, record);
    this.log(`forester: ${item.id}: ${kind}: ${note}`);
    return record;
  }

  // Drop a session that is not live so the next tick launches it again.
  // A live session is somebody's work and is refused by name.
  restart(id) {
    const session = this.sessions.get(id);
    if (session == null) return { error: `no session for ${JSON.stringify(id)}` };
    if (session.pty != null) return { error: `session ${id} is live (${session.state}); it is not restarted underneath a worker` };
    this.sessions.delete(id);
    this.pending.delete(id);
    this.log(`forester: ${id}: restart requested; the next poll launches it again as a fresh context`);
    this.writeSnapshot();
    return { ok: true, restarted: id, was: session.state };
  }

  launch(item, seat, local) {
    const readiness = launchReadiness({ item, seat, local, environment: this.environment });
    if (!readiness.ok) {
      this.failSession(item, readiness.toolName, readiness.kind, readiness.note);
      return;
    }
    const { toolName, tool } = readiness;
    const record = { id: item.id, tool: toolName, state: 'starting', since: now(), pid: null, exit: null, pty: null, viewers: new Set(), events: null, note: null, failure: null, scrollback: '' };
    const before = this.previous[item.id];
    if (before != null && ['starting', 'running', 'idle', 'needs-input'].includes(before.state)) {
      record.note = `fresh context: the previous serve's session (${before.state}) was not resumed natively`;
      delete this.previous[item.id];
    }
    this.sessions.set(item.id, record);
    // The seat's own events file, the one dryad status, Canopy, and
    // Understory read; serve is one launcher among others. A fresh file
    // per launch: a previous session's SessionEnd must not read as this
    // one's exit.
    record.worktree = seat.worktree;
    record.events = seatEventsPath(this.project.slug, item.id, this.environment);
    mkdirSync(path.dirname(record.events), { recursive: true, mode: 0o700 });
    writeFileSync(record.events, '');
    let settingsFile = null;
    if (path.basename(tool.command[0]) === 'claude') {
      settingsFile = seatSettingsPath(this.project.slug, item.id, this.environment);
      writeFileSync(settingsFile, JSON.stringify(claudeSettings(record.events), null, 2));
      if (tool.pretrustWorktrees) {
        const trust = seedClaudeTrust(seat.worktree, this.environment);
        this.log(`forester: ${item.id}: trust ${trust.result === 'seeded' ? 'seeded' : trust.result} (${trust.file}; tools.${toolName}.pretrust_worktrees)`);
      } else {
        this.log(`forester: ${item.id}: trust not seeded; a trust dialog shows as needs-input, answer it with forester attach ${item.id}`);
      }
    }
    // The seat's task is the handoff Forester wrote at seating, so the tool
    // sees the same text a person reads with dryad seat --task.
    const command = launchCommand({ toolName, tool, task: seat.task ?? item.task, settingsFile });
    const env = seatEnvironment(seat, item.id, this.project, this.environment);
    env.FORESTER_EVENTS = record.events;
    env.DRYAD_EVENTS = record.events;
    if (settingsFile != null) env.DRYAD_CLAUDE_SETTINGS = settingsFile;
    try {
      record.pty = this.pty.spawn(command.file, command.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: seat.worktree, env });
    } catch (error) {
      record.state = 'failed';
      record.note = `spawn failed: ${error.message}`;
      record.failure = { kind: 'spawn-failed', note: record.note, at: now() };
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
      if (!record.closing) record.note = `exited ${exitCode} on its own without a done report; forester restart ${item.id} launches it again`;
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
    const doing = doingFromEvents(text, { base: session.worktree ?? null });
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
      seats[id] = { tool: session.tool, state: session.state, since: session.since, pid: session.pid, exit: session.exit, events: session.events, note: session.note, failure: session.failure ?? null, doing: session.doing ?? null, doing_since: session.doing_since ?? null };
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
    const lingering = [...this.sessions.values()].filter((session) => session.pty != null);
    if (lingering.length > 0) this.log(`forester: ${lingering.length} session${lingering.length === 1 ? '' : 's'} still running after the close grace: ${lingering.map((session) => `${session.id} pid ${session.pid}`).join(', ')}`);
    if (this.server != null) await new Promise((resolve) => this.server.close(() => resolve()));
    for (const file of [this.socketPath, this.snapshotFile]) {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        this.log(`forester: could not remove ${file}: ${error.message}`);
      }
    }
    if (this.releaseLock != null) this.releaseLock();
  }
}

// forester restart <id>: ask the running serve to drop a session that is
// not live, so its next poll launches the item again.
export function runRestart({ options, environment = process.env, cwd = process.cwd() }) {
  const loaded = loadForester({ project: options.project, environment, cwd });
  const sessions = loaded.sessions;
  if (sessions == null || !sessions.alive) fail(`no serve daemon for ${loaded.project.slug}; start one with forester serve.`);
  return new Promise((resolve) => {
    const socket = createConnection(sessions.socket);
    let head = '';
    socket.once('connect', () => socket.write(JSON.stringify({ restart: options.id }) + '\n'));
    socket.on('data', (chunk) => { head += chunk.toString('utf8'); });
    socket.on('close', () => {
      let reply;
      try { reply = JSON.parse(head.trim()); } catch { reply = { error: `no reply from ${sessions.socket}` }; }
      if (reply.error) { console.error(`forester: ${reply.error}`); resolve(1); return; }
      console.log(`■ ${loaded.project.slug} — forester restart ${options.id}\n  session   1/1 dropped (was ${reply.was}); the next poll launches it again`);
      resolve(0);
    });
    socket.on('error', (error) => { console.error(`forester: ${error.message}`); resolve(1); });
  });
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
