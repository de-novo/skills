// Sandbox lifecycle. Sample application values stay in its copied profiles.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, cpSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { parse } from 'yaml';
import { splitOverlayCommand, overlayStateDirectory } from './overlay.mjs';
import { dryadStateDirectory } from './dryad.mjs';
import { parseProfile } from './profile.mjs';
import { renderProjectUrls, resolveAddressing } from './addressing.mjs';

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(CATALOG, 'infra/bin/cli.mjs');
export const DEFAULT_SANDBOX = path.join(CATALOG, '.playground/sandbox');
const fail = message => { throw new Error(`playground: ${message}`); };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
};

export function assertTree(root) {
  if (lstatSync(root).isSymbolicLink()) fail(`symlinks are not allowed in the sandbox: ${root}`);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`symlinks are not allowed in the sandbox: ${file}`); // guard: containment
    if (entry.isDirectory()) assertTree(file);
  }
}

export function assertState(sandbox, environment = process.env) {
  const expected = path.join(sandbox, 'state');
  if (!environment.GROVE_STATE_DIR || path.resolve(environment.GROVE_STATE_DIR) !== expected || realpathSync(expected) !== expected) {
    fail(`GROVE_STATE_DIR must be ${expected}`); // guard: state
  }
}

// This preload follows Node children through NODE_OPTIONS. Each Node process
// records itself before application code runs and records listeners on bind.
// Receipts are per PID so concurrent listeners never overwrite one another.
export function processGuard() {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  const net = require('node:net');
  const root = process.env.PLAYGROUND_SANDBOX;
  if (!root || process.env.GROVE_STATE_DIR !== path.join(root, 'state')) throw Error('playground: GROVE_STATE_DIR must be inside the sandbox');
  const record = { pid: process.pid, name: path.basename(process.argv[1] || 'node'), ports: [], host: '127.0.0.1', started: cp.spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim() };
  const file = path.join(root, 'run/processes', `${process.pid}.json`);
  // Anything reading the process directory must see only finished records, so
  // the staging file lives outside it. Same filesystem, so the rename is atomic
  // and a reader never lists a name that is about to disappear.
  const staging = path.join(root, 'run/staging', `${process.pid}.json`);
  const write = () => { fs.writeFileSync(staging, JSON.stringify(record)); fs.renameSync(staging, file); };
  write(); // guard: recording
  // An orderly exit is recorded so a tool that ran and finished is not read as
  // a service that died. Rule 6 keeps the record either way; this only tells
  // the two apart.
  process.on('exit', code => { record.exit = code; try { write(); } catch { /* the sandbox may already be gone */ } });
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    if (options.host !== '127.0.0.1') throw Error('playground: only 127.0.0.1 may bind'); // guard: loopback
    if (Number(options.port) !== 0) throw Error('playground: listeners must request port 0'); // guard: ports
    this.once('listening', () => { record.ports.push(this.address().port); write(); });
    return originalListen.apply(this, args);
  };
  const allow = (command, options) => {
    if (!['node', path.basename(process.execPath), 'git', 'ps'].includes(path.basename(String(command))) || options?.shell) {
      throw Error('playground: only Node, git and process inspection commands are allowed'); // guard: engines
    }
  };
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[method];
    cp[method] = function (command, ...args) { allow(command, args.find(v => v && typeof v === 'object' && !Array.isArray(v))); return original.call(this, command, ...args); };
  }
  cp.exec = cp.execSync = () => { throw Error('playground: shell commands are not allowed'); };
  require('node:module').syncBuiltinESMExports();
}

// `playground` verbs take the sandbox as an argument, so they derive their own
// state directory rather than asking the caller to restate what they were just
// given. A GROVE_STATE_DIR naming a different sandbox is still a conflict and is
// refused: isolation rule 2 governs which state directory is used, not who types
// it. Ordinary catalog verbs are unchanged and still require the variable.
export function environmentForSandbox(sandbox, source = process.env) {
  const expected = path.join(sandbox, 'state');
  if (source.GROVE_STATE_DIR && path.resolve(source.GROVE_STATE_DIR) !== expected) {
    fail(`GROVE_STATE_DIR ${source.GROVE_STATE_DIR} does not belong to ${sandbox}`); // guard: state
  }
  return environmentFor(sandbox, source);
}

function environmentFor(sandbox, source = process.env) {
  const environment = { ...source, GROVE_STATE_DIR: path.join(sandbox, 'state'), PLAYGROUND_SANDBOX: sandbox };
  for (const key of Object.keys(environment)) if (key.startsWith('DRYAD_') || key.startsWith('GIT_')) delete environment[key];
  environment.NODE_OPTIONS = `--require ${JSON.stringify(path.join(sandbox, 'run/guard.cjs'))}`;
  return environment;
}

function findSandbox(start) {
  let current = path.resolve(start);
  if (existsSync(current) && !lstatSync(current).isDirectory()) current = path.dirname(current);
  for (;;) {
    if (existsSync(path.join(current, 'run/sandbox.json'))) return current;
    const marker = path.join(current, '.agents/playground.json');
    if (existsSync(marker)) return json(marker).sandbox;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Protect ordinary catalog verbs before profile resolution or registry writes.
export function guardPlaygroundInvocation(args, environment = process.env, cwd = process.cwd()) {
  if (args[0] === 'playground') return;
  const candidates = [cwd, environment.PLAYGROUND_SANDBOX, environment.DRYAD_PROJECT, ...args.filter(a => !a.startsWith('-') && existsSync(path.resolve(cwd, a)))].filter(Boolean);
  const roots = [...new Set(candidates.map(findSandbox).filter(Boolean))];
  if (roots.length > 1) fail('one CLI call cannot address multiple sandboxes');
  if (!roots.length) return;
  const sandbox = roots[0];
  // Even a refused call must not journal into the caller's machine seat.
  for (const key of Object.keys(environment)) if (key.startsWith('DRYAD_')) delete environment[key];
  assertState(sandbox, environment);
  assertTree(sandbox);
  for (const flag of ['--project', '--worktree']) {
    const index = args.indexOf(flag);
    if (index >= 0 && args[index + 1] && !inside(sandbox, path.resolve(cwd, args[index + 1]))) fail(`${flag} must stay inside the sandbox`);
  }
  if (['infra', 'setup', 'up', 'provision', 'canopy', 'init'].includes(args[0])) fail('machine and provisioning verbs are not available inside a sandbox');
  Object.assign(environment, environmentFor(sandbox, environment));
  // Explicit --project still wins; all inherited seat context is removed.
  for (const key of Object.keys(environment)) if (key.startsWith('DRYAD_') || key.startsWith('GIT_')) delete environment[key];
  environment.DRYAD_PROJECT = path.join(sandbox, 'project');
}

export function machineMentions(sandbox) {
  const inspect = directory => {
    if (!existsSync(directory)) return [];
    const matches = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && readFileSync(file, 'utf8').includes(sandbox)) matches.push(file);
    }
    return matches;
  };
  return { dryad: inspect(dryadStateDirectory({})), overlays: inspect(overlayStateDirectory({})) };
}

function signature(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
export function alive(record) {
  return Number.isSafeInteger(record.pid) && record.pid > 1 && signature(record.pid) === record.started;
}
// alive: still running. finished: it recorded its own exit, whatever the code.
// stopped: it is gone and recorded nothing, so it was killed or died hard.
// A non-zero exit is not a failure here. The overlay contract requires an
// adapter to refuse some calls, and a refusal is a tool exiting non-zero on
// purpose. The record can only tell whether a process ended on its own terms,
// so that is the distinction it is allowed to make; the code is kept beside it.
export function processState(record) {
  if (alive(record)) return 'alive';
  return Number.isInteger(record.exit) ? 'finished' : 'stopped';
}
function records(sandbox) {
  const directory = path.join(sandbox, 'run/processes');
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    return [json(path.join(directory, name))];
  });
}
function manifest(sandbox) {
  const data = json(path.join(sandbox, 'run/sandbox.json'));
  if (data.version !== 1 || data.sandbox !== sandbox) fail('sandbox receipt does not match this directory');
  for (const key of ['project', 'state', 'seats', 'run']) if (data[key] !== path.join(sandbox, key)) fail(`invalid ${key} path in sandbox receipt`);
  return data;
}
export function status(sandbox, environment = process.env) {
  assertState(sandbox, environment);
  assertTree(sandbox);
  const data = manifest(sandbox);
  data.processes = records(sandbox).map(record => ({ ...record, alive: alive(record), state: processState(record) }));
  data.ports = [...new Set(data.processes.filter(record => record.alive).flatMap(record => record.ports))];
  data.counts = { alive: 0, finished: 0, stopped: 0 };
  for (const record of data.processes) data.counts[record.state] += 1;
  data.machine = machineMentions(sandbox);
  save(path.join(sandbox, 'run/sandbox.json'), data);
  return data;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(true));
  });
}
export async function down(sandbox, environment = process.env) {
  const data = status(sandbox, environment);
  for (const record of data.processes) if (alive(record)) process.kill(record.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && data.processes.some(alive); attempt++) await sleep(20);
  for (const record of data.processes) if (alive(record)) process.kill(record.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 50 && data.processes.some(alive); attempt++) await sleep(20);
  const processes = data.processes.filter(alive).length;
  if (processes) fail(`${processes} processes still alive; sandbox preserved for retry`);
  rmSync(sandbox, { recursive: true });
  const ports = (await Promise.all(data.ports.map(listening))).filter(Boolean).length;
  const machine = machineMentions(sandbox);
  return { sandbox, processes, ports, machine, removed: !existsSync(sandbox), ok: ports === 0 && !machine.dryad.length && !machine.overlays.length };
}

function run(command, args, cwd, environment) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function up(sandbox, { source = path.join(CATALOG, 'playground'), profiles = path.join(source, '.agents'), environment = process.env, host = '127.0.0.1' } = {}) {
  if (host !== '127.0.0.1') fail('only 127.0.0.1 may bind');
  sandbox = path.resolve(sandbox);
  if (existsSync(sandbox)) fail(`directory already exists: ${sandbox}`);
  // Never put a sandbox among tracked catalog files. The ignored local area
  // is the only permitted location within this checkout.
  if (inside(CATALOG, sandbox) && !inside(path.join(CATALOG, '.playground'), sandbox)) fail('use the ignored .playground directory or a directory outside the catalog');
  let ancestor = path.dirname(sandbox);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) fail('sandbox parent must not traverse a symlink');
  for (const name of ['app', 'tools']) {
    if (!existsSync(path.join(source, name))) fail(`sample source missing: ${path.join(source, name)}`);
    assertTree(path.join(source, name));
  }
  mkdirSync(path.dirname(sandbox), { recursive: true });
  mkdirSync(sandbox);
  for (const name of ['project/.agents', 'state', 'seats', 'run/processes', 'run/staging']) mkdirSync(path.join(sandbox, name), { recursive: true });
  const data = { version: 1, sandbox, project: path.join(sandbox, 'project'), state: path.join(sandbox, 'state'), seats: path.join(sandbox, 'seats'), run: path.join(sandbox, 'run'), host, processes: [], ports: [], names: [] };
  save(path.join(data.run, 'sandbox.json'), data);
  writeFileSync(path.join(data.run, 'guard.cjs'), `(${processGuard.toString()})();\n`);
  const env = environmentFor(sandbox, environment);
  try {
    for (const name of ['app', 'tools']) cpSync(path.join(source, name), path.join(data.project, name), { recursive: true });
    // Profiles travel with the sample; the CLI does not inspect app sources.
    for (const name of ['runtime-profile.yml', 'dryad-profile.yml']) cpSync(path.join(profiles, name), path.join(data.project, '.agents', name));
    const runtimePath = path.join(data.project, '.agents/runtime-profile.yml');
    const runtime = parseProfile(readFileSync(runtimePath, 'utf8'), runtimePath);
    data.names = renderProjectUrls(runtime, resolveAddressing(runtime, { profilePath: runtimePath })).shared;
    const dryadPath = path.join(data.project, '.agents/dryad-profile.yml');
    const dryad = parse(readFileSync(dryadPath, 'utf8'));
    if (!dryad.worktrees?.root || path.resolve(data.project, dryad.worktrees.root) !== data.seats) fail('Dryad worktrees.root must resolve to the sandbox seats directory');
    save(path.join(data.project, '.agents/playground.json'), { sandbox });
    const git = args => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Playground', '-c', 'user.email=playground@example.invalid', ...args], data.project, env);
    git(['init', '-b', 'main']); // guard: git
    if (git(['rev-parse', '--show-toplevel']) !== data.project || git(['rev-parse', '--git-common-dir']) !== '.git') fail('sandbox git must be its own repository');
    git(['add', '.']);
    git(['commit', '-m', 'Playground baseline']);
    data.revision = git(['rev-parse', 'HEAD']);
    data.verify_image = runtime.overlay.attachable.length ? `${runtime.project.slug}/${runtime.overlay.attachable[0]}:${data.revision}` : null;
    save(path.join(data.run, 'sandbox.json'), data);
    const [command, ...args] = splitOverlayCommand(runtime.runtime.commands.up);
    if (!['node', path.basename(process.execPath)].includes(path.basename(command))) fail('baseline adapter must be a Node command');
    run(command, args, data.project, env);
    const result = status(sandbox, env);
    if (!result.processes.some(p => p.alive && p.ports.length)) fail('adapter did not start any recorded listeners');
    return result;
  } catch (error) {
    await down(sandbox, env);
    throw error;
  }
}

export function nextCommands(data) {
  const prefix = `GROVE_STATE_DIR=${quote(data.state)} ${quote(process.execPath)} ${quote(CLI)}`;
  return [
    `${prefix} validate ${quote(data.project)}`,
    `${prefix} urls ${quote(data.project)}`,
    `${prefix} overlay verify --project ${quote(data.project)}${data.verify_image ? ` --image ${quote(data.verify_image)}` : ''}`,
    `${prefix} dryad plan worker --project ${quote(data.project)} --task 'Change the sample web page' --by reader --apply`,
  ].join('\n');
}
export async function runPlayground(args) {
  const [verb, ...rest] = args;
  let sandbox = process.env.PLAYGROUND_SANDBOX || (process.env.GROVE_STATE_DIR ? path.dirname(path.resolve(process.env.GROVE_STATE_DIR)) : DEFAULT_SANDBOX);
  let jsonOutput = false;
  let host = '127.0.0.1';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && rest[i + 1] && !rest[i + 1].startsWith('--')) sandbox = path.resolve(rest[++i]);
    else if (rest[i] === '--json' && verb === 'status') jsonOutput = true;
    else if (rest[i] === '--host' && rest[i + 1] && verb === 'up') host = rest[++i];
    else fail(`unexpected argument ${rest[i]}`);
  }
  if (verb === 'up') {
    const data = await up(sandbox, { host });
    console.log(`sandbox ${data.sandbox}\nservices ${data.counts.alive} alive, ${data.counts.finished} finished, ${data.counts.stopped} stopped\nports ${data.ports.join(', ')}`);
    console.log(nextCommands(data));
    return 0;
  }
  if (verb === 'status') {
    const data = status(sandbox, environmentForSandbox(sandbox));
    if (jsonOutput) console.log(JSON.stringify(data, null, 2));
    else {
      // Every process stays in the record (rule 6). Only the ones that are
      // still running, or died without finishing, are worth a line each.
      const lines = data.processes
        .filter(p => p.state !== 'finished' || p.exit !== 0)
        .map(p => `process ${p.pid} ${p.name} ${p.state}${p.state === 'finished' ? ` (exit ${p.exit})` : ''}`);
      console.log([`sandbox ${data.sandbox}`, ...lines,
        `processes ${data.counts.alive} alive, ${data.counts.finished} finished, ${data.counts.stopped} stopped`,
        `ports ${data.ports.join(', ')}`, `names ${JSON.stringify(data.names)}`,
        `machine dryad ${data.machine.dryad.length}, overlays ${data.machine.overlays.length}`].join('\n'));
    }
    // The exit code answers one question: did isolation hold. The counts line
    // carries health, so a service that crashed earlier does not make an
    // isolation check read as an isolation failure.
    return data.machine.dryad.length || data.machine.overlays.length ? 1 : 0;
  }
  if (verb === 'down') {
    const data = await down(sandbox, environmentForSandbox(sandbox));
    console.log(`sandbox ${sandbox}\nprocesses still alive ${data.processes}\nports still listening ${data.ports}\nmachine dryad mentions ${data.machine.dryad.length}\nmachine overlay mentions ${data.machine.overlays.length}\ndirectories remaining ${data.removed ? 0 : 1}`);
    return data.ok ? 0 : 1;
  }
  fail('usage: playground up [--dir PATH] | status [--dir PATH] [--json] | down [--dir PATH]');
}
