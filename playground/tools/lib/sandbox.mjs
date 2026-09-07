// Everything this sample writes goes under one sandbox directory, and every
// listener it starts binds port 0 on loopback. These helpers are the only
// place that resolves a path or starts a process, so those two rules have one
// house instead of five.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only address anything in this sample is allowed to bind or dial.
export const LOOPBACK = '127.0.0.1';
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const PROBE_TIMEOUT_MS = 2_000;

// <sandbox>/project/tools/lib/sandbox.mjs — the layout the design fixes.
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SANDBOX_ROOT = path.dirname(PROJECT_ROOT);

export class Refusal extends Error {}

function within(root, target) {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Isolation rule 2: every call carries GROVE_STATE_DIR, and it points inside
// this sandbox. A call without it would write the machine's own registry, so
// it is refused before anything is touched.
export function assertSandbox(environment = process.env) {
  const stateDir = environment.GROVE_STATE_DIR;
  if (stateDir == null || stateDir === '') {
    throw new Refusal('GROVE_STATE_DIR is not set; the playground runs only inside its own sandbox');
  }
  if (!within(SANDBOX_ROOT, stateDir)) {
    throw new Refusal(`GROVE_STATE_DIR ${path.resolve(stateDir)} is outside the sandbox ${SANDBOX_ROOT}`);
  }
  return SANDBOX_ROOT;
}

// Isolation rule 1: nothing is written outside the sandbox directory.
export function sandboxPath(...segments) {
  const target = path.resolve(SANDBOX_ROOT, ...segments);
  if (!within(SANDBOX_ROOT, target)) {
    throw new Refusal(`${target} is outside the sandbox ${SANDBOX_ROOT}`);
  }
  return target;
}

export const runPath = (...segments) => sandboxPath('run', ...segments);
export const imageDir = (service, revision) => runPath('images', service, revision);
export const overlayDir = (env) => runPath('overlays', env);
export const overlayRecord = (env, service) => path.join(overlayDir(env), 'services', `${service}.json`);
export const baselineRecord = (name) => runPath('baseline', `${name}.json`);
export const notesFile = () => runPath('data', 'notes.json');
export const logFile = (name) => runPath('logs', `${name}.log`);

export function ensureDir(target) {
  mkdirSync(sandboxPath(target), { recursive: true });
  return target;
}

export function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  const target = sandboxPath(file);
  ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

export function removeQuietly(target) {
  rmSync(sandboxPath(target), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// What a running instance says about itself. The image is read back from the
// process, never from the file that asked for it.
export async function probe(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return { ok: response.ok && body?.ok === true, body };
  } catch (error) {
    return { ok: false, body: null, error: error.message };
  }
}

export async function waitUntilReady(url, deadlineMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const observed = await probe(url);
    if (observed.ok) return observed;
    if (Date.now() >= deadline) return observed;
    await sleep(POLL_INTERVAL_MS);
  }
}

// Start one recorded process. The child binds port 0 and reports the endpoint
// the kernel gave it; nothing here names a port.
export async function startProcess({ entry, cwd, env, log }) {
  ensureDir(path.dirname(log));
  const handle = openSync(sandboxPath(log), 'a');
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', handle, handle, 'ipc'],
    });
  } finally {
    closeSync(handle);
  }
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${entry} did not report an endpoint within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);
    child.once('message', (message) => { clearTimeout(timer); resolve(message); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${entry} exited ${code} before listening`)); });
  });
  child.disconnect();
  child.unref();
  return { ...endpoint, pid: child.pid };
}

// Stop a recorded process and confirm it is gone, so `status` can never see a
// port that outlived what owned it.
export async function stopProcess(record) {
  if (record == null || !alive(record.pid)) return true;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    return true;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive(record.pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch {
    return true;
  }
  await sleep(POLL_INTERVAL_MS);
  return !alive(record.pid);
}

// One JSON object as the last stdout line: the shape every tool here answers
// with, and the shape the overlay contract requires of an adapter.
export function emit(receipt) {
  console.log(JSON.stringify(receipt));
  return receipt;
}
