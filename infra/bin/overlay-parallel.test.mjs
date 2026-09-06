import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { readOverlayState } from '../lib/overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'grove-parallel-'));
  const main = path.join(root, 'main'); mkdirSync(path.join(main, '.agents'), { recursive: true });
  const trees = Object.fromEntries(['w1', 'w2'].map(env => [env, path.join(root, env + '-tree')]));
  const stateDir = path.join(root, 'state');
  const stateFile = path.join(stateDir, 'parallel-test.yml');
  const environment = { ...process.env, GROVE_PROCESS_TEST_ROOT: root, GROVE_STATE_DIR: stateDir,
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '3000', GROVE_OVERLAY_TIMEOUT_MS: '10000' };
  writeFileSync(path.join(root, 'process-test-marker'), 'owned fixture');
  writeFileSync(path.join(main, '.agents/runtime-profile.yml'), stringify({
    project: { slug: 'parallel-test' }, addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
    runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } },
    services: { api: {} }, overlay: { attachable: ['api'], stale_after: '1h' }, data: { infra: 'project' },
  }));
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: main, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Grove Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'isolated baseline']);
  for (const env of ['w1', 'w2']) git(['worktree', 'add', '-b', env, trees[env]]);
  const artifacts = {}; const images = [];
  for (const revision of ['a', 'b']) {
    const source = `// ${revision}\n` + readFileSync(path.join(HERE, 'fixtures/process-workload.mjs'), 'utf8');
    const image = `process/api@sha256:${createHash('sha256').update(source).digest('hex')}`;
    const file = path.join(root, `${revision}.mjs`); writeFileSync(file, source); artifacts[image] = file; images.push(image);
  }
  writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify(artifacts));
  const children = new Set();
  const cwd = env => trees[env] ?? main;
  const args = values => [CLI, 'overlay', ...values, '--project', '.'];
  const run = (values, env = 'w1') => spawnSync(process.execPath, args(values), { cwd: cwd(env), env: environment, encoding: 'utf8', timeout: 13000 });
  const launch = (values, env = 'w1') => {
    const child = spawn(process.execPath, args(values), { cwd: cwd(env), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    return new Promise(resolve => child.once('exit', status => { children.delete(child); resolve({ status, stdout, stderr }); }));
  };
  const gate = (verb, env) => path.join(root, `gate-${verb}-${env}`);
  const enter = async (verb, env) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(gate(verb, env) + '.entered') && Date.now() < deadline) await sleep(10);
    assert.ok(existsSync(gate(verb, env) + '.entered'), `${verb} ${env} reached its real runtime side effect while its peer is still held`);
  };
  t.after(async () => {
    for (const verb of ['create', 'attach', 'destroy']) for (const env of ['w1', 'w2', 'w3']) rmSync(gate(verb, env), { force: true });
    for (const child of children) child.kill('SIGTERM');
    await sleep(100);
    for (const env of ['w1', 'w2', 'w3']) {
      const endpoint = path.join(root, env, 'endpoint.json');
      if (existsSync(endpoint)) {
        const { pid, url } = JSON.parse(readFileSync(endpoint, 'utf8'));
        try { await fetch(url + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(1000) }); }
        catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const state = () => readOverlayState('parallel-test', environment).state;
  const good = (values, env) => { const result = run(values, env); assert.equal(result.status, 0, result.stderr); return result; };
  return { root, main, trees, stateFile, environment, images, run, launch, gate, enter, state, good };
}

test('real worktrees overlap create, attach and destroy while same-environment writes stay exclusive', async t => {
  const f = fixture(t); let endpoints;
  for (const verb of ['create', 'attach', 'destroy']) {
    for (const env of ['w1', 'w2']) writeFileSync(f.gate(verb, env), 'hold after runtime mutation');
    const request = env => [verb, env, ...(verb === 'attach' ? ['api', '--image', f.images[env === 'w1' ? 0 : 1]] : []), '--apply'];
    const jobs = Object.fromEntries(['w1', 'w2'].map(env => [env, f.launch(request(env), env)]));
    await Promise.all(['w1', 'w2'].map(env => f.enter(verb, env)));
    assert.deepEqual(Object.keys(f.state().pending_by_env).sort(), ['w1', 'w2']);
    const conflicting = f.run(request('w1'));
    assert.notEqual(conflicting.status, 0); assert.match(conflicting.stderr, /locked/);
    if (verb === 'attach') {
      endpoints = ['w1', 'w2'].map(env => JSON.parse(readFileSync(path.join(f.root, env, 'endpoint.json'), 'utf8')));
      for (const [index, { url }] of endpoints.entries()) {
        const response = await fetch(url); assert.equal(response.status, 200); assert.equal((await response.json()).image, f.images[index]);
      }
    }
    if (verb === 'destroy') for (const { url } of endpoints) await assert.rejects(fetch(url));
    rmSync(f.gate(verb, 'w2')); const second = await jobs.w2; assert.equal(second.status, 0, second.stderr);
    assert.equal(f.state().pending_by_env.w1.verb, verb); assert.equal(f.state().pending_by_env.w2, undefined);
    rmSync(f.gate(verb, 'w1')); const first = await jobs.w1; assert.equal(first.status, 0, first.stderr);
    if (verb !== 'destroy') {
      assert.deepEqual(Object.keys(f.state().envs).sort(), ['w1', 'w2']);
      for (const env of ['w1', 'w2']) assert.equal(f.state().envs[env].worktree, realpathSync(f.trees[env]));
    }
  }
  assert.equal(existsSync(f.stateFile), false);
  t.diagnostic('overlapped lifecycle pairs 3/3; exclusive same-environment writes 3/3; independent HTTP artifacts 2/2; removed endpoints 2/2');
});

test('legacy pending migration preserves recovery while another worktree advances independently', async t => {
  const f = fixture(t); const fault = path.join(f.root, 'fail-create-w1'); writeFileSync(fault, 'interrupt');
  assert.notEqual(f.run(['create', 'w1', '--apply']).status, 0);
  const current = f.state();
  const legacy = { version: 1, project: current.project, envs: current.envs, pending: current.pending_by_env.w1 };
  writeFileSync(f.stateFile, stringify(legacy));
  f.good(['create', 'w2', '--apply'], 'w2');
  const stored = parse(readFileSync(f.stateFile, 'utf8'));
  assert.equal(stored.version, 2); assert.deepEqual(stored.pending_by_env.w1, legacy.pending);
  f.good(['touch', 'w2'], 'w2'); f.good(['status', 'w2'], 'w2');
  assert.notEqual(f.run(['status']).status, 0);
  assert.notEqual(f.run(['destroy', 'w1', '--apply']).status, 0);
  rmSync(fault); f.good(['create', 'w1', '--apply']);
  assert.deepEqual(f.state().pending_by_env, {});
  for (const env of ['w1', 'w2']) f.good(['destroy', env, '--apply'], env);
});

test('prune holds only its target and rechecks leases renewed from a different worktree', async t => {
  const f = fixture(t);
  for (const env of ['w1', 'w2']) f.good(['create', env, '--apply'], env);
  const state = f.state();
  for (const record of Object.values(state.envs)) record.last_used_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(f.stateFile, stringify(state));
  writeFileSync(f.gate('destroy', 'w1'), 'hold prune');
  const pruning = f.launch(['prune', '--apply']); await f.enter('destroy', 'w1');
  f.good(['touch', 'w2'], 'w2');
  f.good(['attach', 'w2', 'api', '--image', f.images[1], '--apply'], 'w2');
  f.good(['create', 'w3', '--apply'], 'w2');
  rmSync(f.gate('destroy', 'w1')); const result = await pruning; assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(f.state().envs).sort(), ['w2', 'w3']);
  assert.deepEqual(f.state().pending_by_env, {});
  f.good(['destroy', 'w2', '--apply'], 'w2'); f.good(['destroy', 'w3', '--apply'], 'w2');
});

test('prune retains a failed target while completing unrelated stale cleanup', t => {
  const f = fixture(t);
  for (const env of ['w1', 'w2']) f.good(['create', env, '--apply'], env);
  const state = f.state();
  for (const record of Object.values(state.envs)) record.last_used_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(f.stateFile, stringify(state));
  const fault = path.join(f.root, 'fail-destroy-w1'); writeFileSync(fault, 'interrupt');
  const result = f.run(['prune', '--apply']); assert.notEqual(result.status, 0);
  assert.deepEqual(Object.keys(f.state().envs), ['w1']); assert.equal(f.state().pending_by_env.w1.source, 'prune');
  rmSync(fault); f.good(['prune', '--apply']); assert.equal(existsSync(f.stateFile), false);
});

test('a mismatched pending map key is rejected before any runtime mutation', t => {
  const f = fixture(t); writeFileSync(path.join(f.root, 'fail-create-w1'), 'interrupt');
  assert.notEqual(f.run(['create', 'w1', '--apply']).status, 0);
  const state = f.state(); state.pending_by_env.w2 = state.pending_by_env.w1; delete state.pending_by_env.w1;
  writeFileSync(f.stateFile, stringify(state));
  const result = f.run(['create', 'w3', '--apply']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /match its map key/);
  assert.equal(existsSync(path.join(f.root, 'w3', 'environment')), false);
});

test('a competing dead-lock reclaimer cannot remove the recovery owner marker', t => {
  const f = fixture(t); f.good(['create', 'w1', '--apply']);
  const lock = path.join(`${f.stateFile}.env-locks`, 'w1.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, host: hostname() }));
  mkdirSync(lock + '.recovery');
  const before = f.state().envs.w1.last_used_at;
  const result = f.run(['touch', 'w1']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /recovery is busy or interrupted/);
  assert.equal(f.state().envs.w1.last_used_at, before);
  assert.ok(existsSync(lock + '.recovery'));
  rmSync(lock + '.recovery', { recursive: true });
  f.good(['touch', 'w1']); assert.equal(existsSync(lock), false);
  f.good(['destroy', 'w1', '--apply']);
});

test('status labels a pending operation in-flight while its lock owner lives and stalled afterwards', async t => {
  const f = fixture(t);
  f.good(['create', 'w1', '--apply']);
  writeFileSync(f.gate('attach', 'w1'), 'hold after runtime mutation');
  const job = f.launch(['attach', 'w1', 'api', '--image', f.images[0], '--apply']);
  await f.enter('attach', 'w1');
  const inFlight = f.run(['status']);
  assert.notEqual(inFlight.status, 0, 'exit code contract unchanged while pending');
  assert.match(inFlight.stdout, /pending-item  attach w1\/api  in-flight pid \d+/);
  const inFlightJson = JSON.parse(f.run(['status', '--json']).stdout);
  assert.equal(inFlightJson.ok, false);
  assert.equal(inFlightJson.pending[0].liveness, 'in-flight');
  assert.ok(Number.isInteger(inFlightJson.pending[0].pid) && inFlightJson.pending[0].pid > 0);
  rmSync(f.gate('attach', 'w1'));
  const finished = await job; assert.equal(finished.status, 0, finished.stderr);
  f.good(['status']);

  const fault = path.join(f.root, 'fail-create-w2'); writeFileSync(fault, 'interrupt');
  assert.notEqual(f.run(['create', 'w2', '--apply'], 'w2').status, 0);
  const stalled = f.run(['status']);
  assert.notEqual(stalled.status, 0);
  assert.match(stalled.stdout, /pending-item  create w2  stalled/);
  rmSync(fault); f.good(['create', 'w2', '--apply'], 'w2');
  for (const env of ['w1', 'w2']) f.good(['destroy', env, '--apply'], env);
  t.diagnostic('in-flight labels 1/1; stalled labels 1/1; exit code unchanged 2/2');
});
