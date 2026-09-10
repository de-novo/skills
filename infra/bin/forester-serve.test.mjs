// Forester serve recovers instead of guessing: a launch is checked before
// anything is spawned and a failed check names its kind; a pending overlay
// env is planned again with backoff and never launched into; a failed or
// exited session is restarted only when a person asks; two serves started
// at once leave exactly one; a serve started after a crash says a relaunch
// is a fresh context, not a native resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { acquireServeLock, launchReadiness, resolveExecutable } from '../lib/forester-serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const TOOL = path.join(HERE, 'fixtures/forester-tool.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = `version: 1
tasks:
  w1:
    task: "First"
    owns: [docs/reference/**]
  w2:
    task: "Second"
    owns: [src/**]
`;

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Serve Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const fixtureTool = (command = [process.execPath, TOOL, '{task}']) => `version: 1\nparallel: 1\ntool: fixture\ntools:\n  fixture: { command: ${JSON.stringify(command)} }\n`;

function fixture(t, { overlay = false, local = fixtureTool() } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'serve-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state'), FORESTER_POLL_MS: '150' };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  const runtime = { project: { slug: 'serve-test' }, services: { api: {} }, data: { infra: 'project' } };
  if (overlay) {
    runtime.addressing = { tld: 'localhost', scheme: { overlay: '{service}--{env}.{project}.{tld}' } };
    runtime.runtime = { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } };
    runtime.overlay = { attachable: ['api'], stale_after: '1h' };
  } else {
    runtime.overlay = 'none';
  }
  writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify(runtime));
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/forester-plan.yml'), PLAN);
  writeFileSync(path.join(baseline, '.agents/forester.local.yml'), local);
  writeFileSync(path.join(baseline, 'app.txt'), 'baseline\n');
  gitIn(baseline, ['init', '-b', 'main']);
  gitIn(baseline, ['add', '.']);
  gitIn(baseline, ['commit', '-m', 'baseline']);
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args, '--project', baseline], { cwd: baseline, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 20000 });
  const status = () => {
    const result = run(['forester', 'status', '--json']);
    try { return JSON.parse(result.stdout); } catch { return null; }
  };
  const session = (id) => status()?.items.find((item) => item.id === id)?.session ?? null;
  const children = new Set();
  const serve = (extra = {}) => {
    const child = spawn(process.execPath, [CLI, 'forester', 'serve', '--project', baseline], { env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { child, log: '' };
    child.stdout.on('data', (chunk) => { record.log += chunk; });
    child.stderr.on('data', (chunk) => { record.log += chunk; });
    children.add(child);
    return record;
  };
  const until = async (pred, what, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (pred()) return; await sleep(100); }
    assert.fail(`${what}\n--- status: ${JSON.stringify(status()?.items.map((item) => [item.id, item.state, item.session?.state, item.session?.note]))}`);
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode == null) child.kill('SIGKILL');
    await sleep(200);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, baseline, environment, run, status, session, serve, until };
}

test('launch readiness names what is missing before anything is spawned', () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'serve-bin-'));
  writeFileSync(path.join(bin, 'present'), '#!/bin/sh\n');
  const environment = { PATH: `${bin}${path.delimiter}/nonexistent` };
  assert.equal(resolveExecutable('present', environment), path.join(bin, 'present'));
  assert.equal(resolveExecutable('absent', environment), null);
  assert.equal(resolveExecutable(path.join(bin, 'present'), environment), path.join(bin, 'present'));
  assert.equal(resolveExecutable('/no/such/tool', environment), null);

  const seat = { env: null, worktree: bin };
  const local = { tool: 'x', tools: { x: { command: ['present', '{task}'] }, gone: { command: ['absent'] } } };
  assert.deepEqual(launchReadiness({ item: { id: 'a', tool: null }, seat, local: null, environment }).kind, 'no-tool');
  assert.deepEqual(launchReadiness({ item: { id: 'a', tool: 'nope' }, seat, local, environment }).kind, 'no-tool');
  assert.deepEqual(launchReadiness({ item: { id: 'a', tool: 'gone' }, seat, local, environment }).kind, 'tool-missing');
  assert.deepEqual(launchReadiness({ item: { id: 'a', tool: null }, seat: { ...seat, env: 'pending' }, local, environment }).kind, 'env-pending');
  assert.deepEqual(launchReadiness({ item: { id: 'a', tool: null }, seat: { ...seat, worktree: '/no/such/dir' }, local, environment }).kind, 'worktree-missing');
  const ready = launchReadiness({ item: { id: 'a', tool: null }, seat, local, environment });
  assert.deepEqual({ ok: ready.ok, toolName: ready.toolName, executable: ready.executable }, { ok: true, toolName: 'x', executable: path.join(bin, 'present') });
  rmSync(bin, { recursive: true, force: true });
});

test('the serve lock is taken once, reclaimed from a dead pid, and never stolen from an unreadable owner', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serve-lock-'));
  const lock = path.join(dir, 'slug.yml.serve.lock');
  const release = acquireServeLock(lock);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  assert.throws(() => acquireServeLock(lock), new RegExp(`serve already runs for this project as pid ${process.pid}`));
  release();
  assert.equal(existsSync(lock), false);
  // A lock left by a pid that is gone is reclaimed; one nobody can read is not.
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: (await import('node:os')).hostname() }));
  acquireServeLock(lock)();
  writeFileSync(lock, '');
  assert.throws(() => acquireServeLock(lock), /serve already runs for this project as pid \?/);
  assert.equal(readFileSync(lock, 'utf8'), '', 'the unreadable lock is left as it was');
  rmSync(dir, { recursive: true, force: true });
});

test('a missing tool is a failed session naming its kind; after the fix, restart launches it; a live session is not restarted', async (t) => {
  const f = fixture(t, { local: fixtureTool(['/no/such/tool', '{task}']) });
  const serve = f.serve();
  await f.until(() => f.session('w1')?.state === 'failed', 'w1 session failed');
  const failed = f.session('w1');
  assert.equal(failed.failure.kind, 'tool-missing');
  assert.match(failed.note, /\/no\/such\/tool is not on PATH/);
  assert.equal(failed.pid, null);
  assert.match(f.run(['forester', 'status']).stdout, /w1  fixture  failed  · tool-missing: \/no\/such\/tool is not on PATH/);
  // No relaunch happens on its own: the same failure stays, once.
  await sleep(600);
  assert.equal(f.session('w1').state, 'failed');
  assert.equal((serve.log.match(/tool-missing/g) ?? []).length, 1, 'the failure is logged once, not every poll');

  // The local file is a machine fact read every poll; fix it, then ask for the restart.
  writeFileSync(path.join(f.baseline, '.agents/forester.local.yml'), fixtureTool());
  const restarted = f.run(['forester', 'restart', 'w1']);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.stdout, /session   1\/1 dropped \(was failed\)/);
  await f.until(() => f.session('w1')?.state === 'needs-input', 'w1 launched after restart');
  const refused = f.run(['forester', 'restart', 'w1']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /session w1 is live \(needs-input\); it is not restarted underneath a worker/);
  assert.match(f.run(['forester', 'restart', 'w2']).stderr, /no session for "w2"/);
  serve.child.kill('SIGINT');
});

test('two serves started at once leave exactly one; the other stops at the lock and removes nothing', async (t) => {
  const f = fixture(t);
  const first = f.serve();
  const second = f.serve();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && first.child.exitCode == null && second.child.exitCode == null) await sleep(100);
  const [winner, loser] = first.child.exitCode == null ? [first, second] : [second, first];
  assert.equal(loser.child.exitCode, 1, `one serve exits\n${loser.log}`);
  assert.match(loser.log, /serve already runs for (this project|serve-test) as pid \d+/);
  await f.until(() => f.status()?.serve?.alive === true, 'the winner is serving');
  assert.equal(f.status().serve.pid, winner.child.pid);
  assert.equal(existsSync(f.status().serve.socket), true, 'the winner\'s socket was not removed by the loser');
  winner.child.kill('SIGINT');
  await f.until(() => winner.child.exitCode != null, 'winner exits', 8000);
  assert.equal(existsSync(path.join(f.root, 'state/foresters/serve-test.yml.serve.lock')), false, 'the lock goes with the daemon');
});

test('a serve started after a crash relaunches sessions as fresh contexts and says so', async (t) => {
  const f = fixture(t);
  const first = f.serve();
  await f.until(() => f.session('w1')?.state === 'needs-input', 'w1 session up');
  const firstPid = first.child.pid;
  first.child.kill('SIGKILL');
  await f.until(() => first.child.exitCode != null || first.child.signalCode != null, 'first serve gone', 5000);
  await sleep(300);
  const second = f.serve();
  await f.until(() => f.status()?.serve?.alive === true && f.status().serve.pid === second.child.pid, 'second serve took over');
  assert.match(second.log, new RegExp(`previous serve pid ${firstPid} ended with 1 live session \\(w1\\); they cannot be resumed natively`));
  await f.until(() => f.session('w1')?.state === 'needs-input', 'w1 relaunched');
  assert.match(f.session('w1').note, /fresh context: the previous serve's session \(needs-input\) was not resumed natively/);
  assert.notEqual(f.session('w1').pid, null);
  second.child.kill('SIGINT');
});

test('a pending overlay env is never launched into: serve plans it again with backoff, gives up after five tries, and restart begins again', async (t) => {
  const f = fixture(t, { overlay: true });
  // The backend refuses until its root exists; serve keeps retrying.
  const late = path.join(f.root, 'late');
  const serve = f.serve({ GROVE_PROCESS_TEST_ROOT: late });
  await f.until(() => /overlay env still pending \(retry 2\/5/.test(serve.log), 'second retry logged');
  const seat = JSON.parse(f.run(['dryad', 'status', '--json'], { GROVE_PROCESS_TEST_ROOT: late }).stdout).seats.find((row) => row.id === 'w1');
  assert.equal(seat.env, 'pending');
  assert.equal(f.session('w1'), null, 'nothing launched while the env is pending');
  await f.until(() => f.session('w1')?.state === 'failed', 'gave up after the retries', 30000);
  assert.equal(f.session('w1').failure.kind, 'env-pending');
  assert.equal((serve.log.match(/still pending \(retry/g) ?? []).length, 5);

  // The backend comes up; a person asks for the restart; the seat's env is
  // created by the same plan --apply and the tool is launched into it.
  mkdirSync(late, { recursive: true });
  writeFileSync(path.join(late, 'process-test-marker'), 'owned fixture');
  assert.equal(f.run(['forester', 'restart', 'w1']).status, 0);
  await f.until(() => /overlay env ready after 1 retry/.test(serve.log), 'env created on the retry after restart');
  await f.until(() => f.session('w1')?.state === 'needs-input', 'w1 launched into its env');
  const after = JSON.parse(f.run(['dryad', 'status', '--json'], { GROVE_PROCESS_TEST_ROOT: late }).stdout).seats.find((row) => row.id === 'w1');
  assert.equal(after.env, 'w1');
  serve.child.kill('SIGINT');
});
