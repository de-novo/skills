import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { parseDryadCliArgs, parseDryadProfile, readDryadState } from '../lib/dryad.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');

function gitIn(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Dryad Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A disposable baseline repo with Grove + Dryad profiles. overlay: true wires
// the isolated process backend so `overlay create` really runs.
function fixture(t, { overlay = false, worktrees = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dryad-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const stateDir = path.join(root, 'state');
  const environment = {
    ...process.env,
    GROVE_STATE_DIR: stateDir,
    GROVE_PROCESS_TEST_ROOT: root,
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '3000',
    GROVE_OVERLAY_TIMEOUT_MS: '10000',
  };
  delete environment.DRYAD_PROJECT;
  writeFileSync(path.join(root, 'process-test-marker'), 'owned fixture');
  const runtime = { project: { slug: 'dryad-test' }, services: { api: {} }, data: { infra: 'project' } };
  if (overlay) {
    runtime.addressing = { scheme: { overlay: '{service}--{env}.{project}.{tld}' } };
    runtime.runtime = { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } };
    runtime.overlay = { attachable: ['api'], stale_after: '1h' };
  } else {
    runtime.overlay = 'none';
  }
  writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify(runtime));
  const dryad = { version: 1 };
  if (worktrees) dryad.worktrees = { root: '../seats', branch: 'dryad/{id}' };
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify(dryad));
  writeFileSync(path.join(baseline, 'app.txt'), 'baseline\n');
  gitIn(baseline, ['init', '-b', 'main']);
  gitIn(baseline, ['add', '.']);
  gitIn(baseline, ['commit', '-m', 'baseline']);
  const head = gitIn(baseline, ['rev-parse', 'HEAD']);

  const run = (args, { cwd = baseline, env = {} } = {}) =>
    spawnSync(process.execPath, [CLI, 'dryad', ...args], { cwd, env: { ...environment, ...env }, encoding: 'utf8', timeout: 20000 });
  const good = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const bad = (args, options) => {
    const result = run(args, options);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded\n${result.stdout}`);
    return result;
  };
  const state = () => readDryadState('dryad-test', environment).state;
  const stateFile = path.join(stateDir, 'dryads', 'dryad-test.yml');
  const groveStateFile = path.join(stateDir, 'dryad-test.yml');
  const seatPath = (id) => path.join(root, 'seats', id);

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, baseline, head, environment, run, good, bad, state, stateFile, groveStateFile, seatPath };
}

test('dryad profile parser accepts the documented shape and rejects unknown keys and placeholders', () => {
  const ok = parseDryadProfile('version: 1\nworktrees:\n  root: ../seats\n  branch: "dryad/{id}"\n');
  assert.deepEqual(ok, { version: 1, worktrees: { root: '../seats', branch: 'dryad/{id}' } });
  assert.deepEqual(parseDryadProfile(''), { version: 1, worktrees: null });
  const rejected = [
    'version: 2\n',
    'runners: {}\n',
    'worktrees:\n  root: ../seats\n  branch: "dryad/{id}"\n  extra: 1\n',
    'worktrees:\n  root: ../seats\n  branch: "dryad/{env}"\n',
    'worktrees:\n  root: ../seats\n  branch: "dryad/all"\n',
    'worktrees:\n  branch: "dryad/{id}"\n',
    'worktrees:\n  root: ""\n  branch: "dryad/{id}"\n',
  ];
  let count = 0;
  for (const text of rejected) {
    assert.throws(() => parseDryadProfile(text), /dryad:/);
    count += 1;
  }
  assert.equal(count, rejected.length);
});

test('the published example profile parses', () => {
  const example = readFileSync(path.join(HERE, '../../skills/dryad/examples/dryad-profile.yml'), 'utf8');
  assert.deepEqual(parseDryadProfile(example), { version: 1, worktrees: { root: '../acme-seats', branch: 'dryad/{id}' } });
});

test('dryad cli args enforce verb shapes', () => {
  assert.equal(parseDryadCliArgs([]).help, true);
  assert.throws(() => parseDryadCliArgs(['launch', 'w1']), /unknown command/);
  assert.throws(() => parseDryadCliArgs(['plan', 'w1']), /exactly one of --task or --task-file/);
  assert.throws(() => parseDryadCliArgs(['plan', 'w1', '--task', 'a', '--task-file', 'b']), /exactly one/);
  assert.throws(() => parseDryadCliArgs(['plan', 'W1', '--task', 'a']), /DNS label/);
  assert.throws(() => parseDryadCliArgs(['seat', 'w1', '--json', '--env']), /at most one/);
  assert.throws(() => parseDryadCliArgs(['report', 'w1']), /requires --status/);
  assert.throws(() => parseDryadCliArgs(['report', 'w1', '--status', 'planned']), /--status must be one of/);
  assert.throws(() => parseDryadCliArgs(['finish', 'w1', '--force']), /not valid for finish/);
  assert.throws(() => parseDryadCliArgs(['status', 'w1', 'w2']), /at most 1/);
  const plan = parseDryadCliArgs(['plan', 'w1', '--task-file', 'tasks/w1.md', '--by', 'codex', '--apply']);
  assert.deepEqual([plan.verb, plan.id, plan.taskFile, plan.by, plan.apply], ['plan', 'w1', 'tasks/w1.md', 'codex', true]);
  assert.equal(parseDryadCliArgs(['seat', 'w1', '--shell']).format, 'shell');
  assert.equal(parseDryadCliArgs(['seat', 'w1']).format, 'text');
});

test('plan without --apply creates nothing; with --apply it creates a worktree seat that seat, report, status and finish round-trip', (t) => {
  const f = fixture(t);
  const plan = f.good(['plan', 'w1', '--task', 'add refund endpoint', '--by', 'claude']);
  assert.match(plan.stdout, /would create/);
  assert.equal(existsSync(f.seatPath('w1')), false);
  assert.equal(existsSync(f.stateFile), false);

  f.good(['plan', 'w1', '--task', 'add refund endpoint', '--by', 'claude', '--apply']);
  assert.equal(existsSync(f.seatPath('w1')), true);
  assert.equal(gitIn(f.seatPath('w1'), ['symbolic-ref', '--short', 'HEAD']), 'dryad/w1');
  const seat = f.state().seats.w1;
  assert.equal(seat.owned, true);
  assert.equal(seat.base, f.head);
  assert.equal(seat.env, null);
  assert.equal(seat.status, 'planned');
  assert.equal(seat.journal.length, 1);
  assert.equal(gitIn(f.baseline, ['status', '--porcelain']), '', 'baseline stays clean');
  f.bad(['plan', 'w1', '--task', 'again', '--apply']);

  const json = JSON.parse(f.good(['seat', 'w1', '--json']).stdout);
  assert.equal(json.worktree, f.seatPath('w1'));
  assert.deepEqual(json.env_vars, { DRYAD_ID: 'w1', DRYAD_ENV: '', DRYAD_BRANCH: 'dryad/w1', DRYAD_PROJECT: f.baseline });
  assert.equal(json.task, 'add refund endpoint');
  const envLines = f.good(['seat', 'w1', '--env']).stdout.trim().split('\n');
  assert.equal(envLines.length, 4);
  assert.ok(envLines.includes('DRYAD_ID=w1'));

  // The launcher boundary: the --shell line, executed by a real shell, lands
  // a process in the worktree with the seat's environment.
  const shellLine = f.good(['seat', 'w1', '--shell']).stdout.trim();
  const probe = spawnSync('sh', ['-c', `${shellLine} && pwd && env | grep '^DRYAD_' | sort`], { encoding: 'utf8', env: f.environment });
  assert.equal(probe.status, 0, probe.stderr);
  const probeLines = probe.stdout.trim().split('\n');
  assert.equal(realpathSync(probeLines[0]), f.seatPath('w1'));
  assert.deepEqual(probeLines.slice(1), ['DRYAD_BRANCH=dryad/w1', 'DRYAD_ENV=', 'DRYAD_ID=w1', `DRYAD_PROJECT=${f.baseline}`]);

  // A worker inside the worktree resolves the baseline through DRYAD_PROJECT
  // (the worktree carries its own copy of .agents/).
  f.good(['report', 'w1', '--status', 'working', '--note', 'started'], { cwd: f.seatPath('w1'), env: { DRYAD_PROJECT: f.baseline } });
  f.good(['report', 'w1', '--status', 'blocked', '--note', 'mock schema differs', '--session', 'sess-123'], { cwd: f.seatPath('w1'), env: { DRYAD_PROJECT: f.baseline } });
  const reported = f.state().seats.w1;
  assert.equal(reported.status, 'blocked');
  assert.equal(reported.session, 'sess-123');
  assert.equal(reported.journal.length, 3);
  assert.equal(reported.journal.at(-1).detail, 'blocked: mock schema differs');

  const blocked = f.bad(['status']);
  assert.match(blocked.stdout, /seats 1/);
  assert.match(blocked.stdout, /worktrees  1\/1 present/);
  assert.match(blocked.stdout, /problem  w1: blocked/);
  f.good(['report', 'w1', '--status', 'done']);
  const clean = f.good(['status', 'w1']);
  assert.match(clean.stdout, /reported   done 1/);
  assert.equal((clean.stdout.match(/\n  \d{4}-\d{2}-\d{2}T/g) ?? []).length, 4, 'status <id> prints the journal');
  const statusJson = JSON.parse(f.good(['status', '--json']).stdout);
  assert.deepEqual(statusJson.problems, []);
  assert.equal(statusJson.seats[0].ahead, 0);

  writeFileSync(path.join(f.seatPath('w1'), 'app.txt'), 'changed\n');
  const dirty = f.bad(['finish', 'w1', '--apply']);
  assert.match(dirty.stderr, /uncommitted changes/);
  assert.equal(existsSync(f.seatPath('w1')), true);
  assert.equal(f.state().seats.w1.journal.at(-1).event, 'finish.worktree');

  gitIn(f.seatPath('w1'), ['commit', '-am', 'seat work']);
  assert.match(f.good(['status']).stdout, /\+1/);
  const finishPlan = f.good(['finish', 'w1']);
  assert.match(finishPlan.stdout, /would remove/);
  assert.equal(existsSync(f.seatPath('w1')), true);
  const finished = f.good(['finish', 'w1', '--apply']);
  assert.match(finished.stdout, /worktree  1\/1 removed/);
  assert.match(finished.stdout, /branch    kept dryad\/w1/);
  assert.equal(existsSync(f.seatPath('w1')), false);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(gitIn(f.baseline, ['rev-parse', '--verify', 'dryad/w1']).length, 40, 'branch survives finish');
  t.diagnostic('seat formats 3/3; reports 3/3; dirty finish refused 1/1; clean finish removed 1/1; branch kept 1/1');
});

test('plan adopts a worktree another launcher created and finish leaves it in place', (t) => {
  const f = fixture(t, { worktrees: false });
  const adopted = path.join(f.root, 'launcher-made');
  gitIn(f.baseline, ['worktree', 'add', '-b', 'feature/x', adopted]);
  f.bad(['plan', 'w2', '--task', 'no worktrees section and no --worktree']);
  f.bad(['plan', 'w2', '--task', 'x', '--worktree', f.baseline, '--apply']);
  const foreign = path.join(f.root, 'foreign');
  mkdirSync(foreign);
  gitIn(foreign, ['init', '-b', 'main']);
  f.bad(['plan', 'w2', '--task', 'x', '--worktree', foreign, '--apply']);

  f.good(['plan', 'w2', '--task', 'x', '--worktree', adopted, '--by', 'codex', '--apply']);
  const seat = f.state().seats.w2;
  assert.equal(seat.owned, false);
  assert.equal(seat.branch, 'feature/x');
  assert.equal(seat.worktree, realpathSync(adopted));
  assert.match(f.good(['status']).stdout, /by codex/);

  writeFileSync(path.join(adopted, 'dirty.txt'), 'kept\n');
  const finished = f.good(['finish', 'w2', '--apply']);
  assert.match(finished.stdout, /worktree  kept \(adopted\)/);
  assert.equal(existsSync(adopted), true);
  assert.equal(existsSync(path.join(adopted, 'dirty.txt')), true);
  assert.equal(existsSync(f.stateFile), false);
  t.diagnostic('rejected adoptions 3/3; adopted 1/1; adopted worktree kept 1/1');
});

test('with overlays, plan creates the env through Grove, a failed create stays pending and the same plan retries it', (t) => {
  const f = fixture(t, { overlay: true });
  const groveRegistry = () => parse(readFileSync(f.groveStateFile, 'utf8'));

  // Point the isolated backend at a root it does not own: Grove's create fails
  // after Dryad has already made the worktree.
  const failed = f.bad(['plan', 'w3', '--task', 'retry me', '--apply'], { env: { GROVE_PROCESS_TEST_ROOT: path.join(f.root, 'missing') } });
  assert.match(failed.stderr, /env pending/);
  assert.equal(existsSync(f.seatPath('w3')), true, 'worktree survives a failed overlay create');
  assert.equal(f.state().seats.w3.env, 'pending');
  const pending = f.bad(['status']);
  assert.match(pending.stdout, /problem  w3: env pending/);
  f.bad(['plan', 'w3', '--task', 'different task while pending', '--apply'], { env: { GROVE_PROCESS_TEST_ROOT: path.join(f.root, 'missing') } });

  f.good(['plan', 'w3', '--task', 'retry me', '--apply']);
  const w3 = f.state().seats.w3;
  assert.equal(w3.env, 'w3');
  assert.equal(w3.journal.at(-1).event, 'plan.retry');
  assert.ok(groveRegistry().envs.w3, 'Grove tracks the env after retry');

  f.good(['plan', 'w1', '--task', 'real env', '--apply']);
  assert.equal(JSON.parse(f.good(['seat', 'w1', '--json']).stdout).env_vars.DRYAD_ENV, 'w1');
  const status = f.good(['status']);
  assert.match(status.stdout, /envs       2\/2 tracked/);
  assert.match(status.stdout, /env w1 tracked/);

  const finished = f.good(['finish', 'w3', '--apply']);
  assert.match(finished.stdout, /env       1\/1 destroyed/);
  assert.equal(groveRegistry().envs.w3, undefined);
  assert.match(f.good(['status']).stdout, /envs       1\/1 tracked/);
  f.good(['finish', 'w1', '--apply']);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(existsSync(f.groveStateFile), false, 'Grove registry empties too');
  t.diagnostic('overlay create failed→pending 1/1; pending retry finalized 1/1; envs tracked 2/2; destroyed 2/2');
});

test('two seats plan concurrently without clobbering each other', async (t) => {
  const f = fixture(t);
  const { spawn } = await import('node:child_process');
  const launch = (id) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'dryad', 'plan', id, '--task', id, '--apply'], { cwd: f.baseline, env: f.environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (value) => { stderr += value; });
      child.once('exit', (status) => resolve({ status, stderr }));
    });
  const results = await Promise.all([launch('w1'), launch('w2')]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(f.state().seats).sort(), ['w1', 'w2']);
  assert.equal(existsSync(f.seatPath('w1')) && existsSync(f.seatPath('w2')), true);
  const status = f.good(['status']);
  assert.match(status.stdout, /seats 2/);
  assert.match(status.stdout, /worktrees  2\/2 present/);
  t.diagnostic('concurrent plans 2/2; seats registered 2/2');
});
