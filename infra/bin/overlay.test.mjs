import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import {
  parseDuration,
  verifyAttachService,
  parseOverlayCliArgs,
  splitOverlayCommand,
  staleOverlayEnvironments,
} from '../lib/overlay.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'infra/bin/cli.mjs');
const STUB = path.join(REPO_ROOT, 'infra/bin/overlay-stub.mjs');
const FULL_IMAGE = `acme/api:${'a'.repeat(40)}`;

test('overlay command tokenization preserves quoted arguments without a shell', () => {
  assert.deepEqual(
    splitOverlayCommand('node "tools/path with spaces/dev-overlay.mjs" --mode \'local qa\''),
    ['node', 'tools/path with spaces/dev-overlay.mjs', '--mode', 'local qa']
  );
  assert.throws(() => splitOverlayCommand('node "unfinished'), /unfinished quote/);
});

test('stale lease boundary is exact and duration units are counted', () => {
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.throws(() => parseDuration('0h'), /positive duration/);
  const state = {
    envs: {
      stale: { last_used_at: '2026-09-04T00:00:00.000Z' },
      active: { last_used_at: '2026-09-04T00:00:00.001Z' },
    },
  };
  assert.deepEqual(
    staleOverlayEnvironments(state, 3_600_000, Date.parse('2026-09-04T01:00:00.000Z'))
      .map(({ env }) => env),
    ['stale']
  );
});

function projectFixture(t, { planFirst = true, staleAfter = '1h', createOn = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'grove-overlay-'));
  const stateDir = path.join(root, 'state');
  const log = path.join(root, 'overlay-calls.jsonl');
  const runtimeState = path.join(root, 'overlay-runtime.json');
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  const staleLine = (staleAfter == null ? '' : `  stale_after: ${staleAfter}\n`) + (createOn == null ? '' : `  create_on: ${createOn}\n`);
  writeFileSync(
    path.join(root, '.agents', 'runtime-profile.yml'),
    `version: 1
project: { slug: lifecycle-test }
addressing:
  proxy: project
  scheme:
    shared: "{service}.{project}.{tld}"
    overlay: "{service}--{env}.{project}.{tld}"
runtime:
  single_stack: true
  writers: 1
  commands:
    overlay: ${JSON.stringify(`${process.execPath} ${STUB}`)}
services:
  api: { kind: api }
  worker: { kind: worker }
overlay:
  attachable: [api]
  shared_only: [worker]
  image_tag: full-git-sha
  plan_first: ${planFirst}
${staleLine}data:
  infra: machine
  forbid_direct_db_writes: true
`,
    'utf8'
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateDir,
    log,
    runtimeState,
    planFirst,
    stateFile: path.join(stateDir, 'lifecycle-test.yml'),
  };
}

function run(fixture, args, extraEnv = {}) {
  const separator = args.indexOf('--');
  const cliArgs = separator === -1
    ? [...args, '--project', fixture.root]
    : [
        ...args.slice(0, separator),
        '--project',
        fixture.root,
        ...args.slice(separator),
      ];
  return spawnSync(
    process.execPath,
    [CLI, 'overlay', ...cliArgs],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GROVE_STATE_DIR: fixture.stateDir,
        GROVE_OVERLAY_STUB_LOG: fixture.log,
        GROVE_OVERLAY_STUB_RUNTIME_STATE: fixture.runtimeState,
        GROVE_OVERLAY_STUB_PLAN_FIRST: String(fixture.planFirst),
        ...extraEnv,
      },
    }
  );
}

function readState(fixture) {
  return parse(readFileSync(fixture.stateFile, 'utf8'));
}

function calls(fixture) {
  if (!existsSync(fixture.log)) return [];
  return readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function runtimeState(fixture) {
  if (!existsSync(fixture.runtimeState)) return { environments: {} };
  return JSON.parse(readFileSync(fixture.runtimeState, 'utf8'));
}

test('an apply intent exists on disk before the project mutation starts', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_REQUIRE_PENDING: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readState(fixture).pending_by_env.w1, undefined);
});

test('a successful receipt cannot finalize state before the runtime postcondition exists', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_SKIP_RUNTIME_MUTATION: 'true',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '20',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /postcondition.*pending.*retained/i);
  const state = readState(fixture);
  assert.equal(state.envs.w1, undefined);
  assert.equal(state.pending_by_env.w1.verb, 'create');
  assert.equal(state.pending_by_env.w1.env, 'w1');
});

test('postcondition verification retries asynchronous status before finalizing', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_STATUS_LAG: '2',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2000',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postcondition 1\/1.*attempts 3/);
  assert.equal(readState(fixture).pending_by_env.w1, undefined);
  assert.ok(calls(fixture).filter((call) => call.verb === 'status').length >= 3);
});

test('destroy finalizes only after status observes actual absence', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);

  const result = run(fixture, ['destroy', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_DESTROY_STATUS_LAG: '2',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2000',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /postcondition 1\/1: destroy w1 observed \(attempts 3\)/);
  assert.equal(existsSync(fixture.stateFile), false);
  assert.deepEqual(runtimeState(fixture).environments, {});
});

test('destroy keeps its lease and pending intent when successful receipt leaves runtime present', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);

  const unverified = run(fixture, ['destroy', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_SKIP_RUNTIME_MUTATION: 'destroy',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '20',
  });
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.stderr, /postcondition.*pending operation retained/i);
  assert.ok(readState(fixture).envs.w1);
  assert.equal(readState(fixture).pending_by_env.w1.verb, 'destroy');
  assert.deepEqual(runtimeState(fixture).environments, { w1: [] });

  const recovered = run(fixture, ['destroy', 'w1', '--apply']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /recovered pending destroy w1/);
  assert.equal(existsSync(fixture.stateFile), false);
  assert.deepEqual(runtimeState(fixture).environments, {});
});

test('missing status inventory cannot finalize an applied mutation', (t) => {
  const fixture = projectFixture(t);
  // A receipt with no inventory can never satisfy the postcondition, so the
  // deadline is generous and the command must still answer well inside it.
  // Retrying instead of failing fast made this test flaky under load and
  // would hang a real adapter for the whole default deadline.
  const started = Date.now();
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_OMIT_INVENTORY: 'true',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '30000',
  });
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /omitted environments/);
  assert.doesNotMatch(result.stderr, /timed out/);
  assert.ok(elapsed < 15000, `gave up after ${elapsed}ms instead of failing fast`);
  assert.equal(readState(fixture).pending_by_env.w1.verb, 'create');
  assert.equal(readState(fixture).envs.w1, undefined);
});

test('an invalid verification deadline fails before journaling or project dispatch', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: 'never',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VERIFY_TIMEOUT_MS must be a positive integer/);
  assert.equal(calls(fixture).length, 0);
  assert.equal(existsSync(fixture.stateFile), false);
  assert.deepEqual(runtimeState(fixture).environments, {});
});

test('rerunning the same apply recovers an interruption after the runtime side effect', (t) => {
  const fixture = projectFixture(t);
  const interrupted = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true',
  });
  assert.notEqual(interrupted.status, 0);
  assert.deepEqual(runtimeState(fixture).environments, { w1: [] });
  assert.equal(readState(fixture).pending_by_env.w1.verb, 'create');

  const recovered = run(fixture, ['create', 'w1', '--apply']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /recovered pending create/);
  assert.equal(readState(fixture).pending_by_env.w1, undefined);
  assert.deepEqual(Object.keys(readState(fixture).envs), ['w1']);
});

test('status exposes a pending operation without completing it', (t) => {
  const fixture = projectFixture(t);
  const interrupted = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true',
  });
  assert.notEqual(interrupted.status, 0);

  const status = run(fixture, ['status']);
  assert.notEqual(status.status, 0);
  assert.match(status.stdout, /pending {7}1/);
  assert.match(status.stdout, /pending-item {2}create w1/);
  assert.equal(readState(fixture).pending_by_env.w1.verb, 'create');
});

test('a pending operation blocks only its environment mutations and lease renewal', (t) => {
  const fixture = projectFixture(t);
  const interrupted = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true',
  });
  assert.notEqual(interrupted.status, 0);
  const before = calls(fixture).length;

  const conflicting = run(fixture, ['destroy', 'w1', '--apply']);
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /pending operation create w1 must be recovered first/);
  assert.equal(calls(fixture).length, before);
  assert.equal(run(fixture, ['create', 'w2', '--apply']).status, 0);
  assert.equal(run(fixture, ['touch', 'w2']).status, 0);

  const touched = run(fixture, ['touch', 'w1']);
  assert.notEqual(touched.status, 0);
  assert.match(touched.stderr, /pending operation create w1.*before touch/);
  assert.equal(readState(fixture).pending_by_env.w1.env, 'w1');
});

test('recovery requires matching passthrough context and reuses it for status', (t) => {
  const fixture = projectFixture(t);
  const interrupted = run(
    fixture,
    ['create', 'w1', '--apply', '--', '--context=a'],
    { GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true' }
  );
  assert.notEqual(interrupted.status, 0);
  const journal = readFileSync(fixture.stateFile, 'utf8');
  assert.doesNotMatch(journal, /--context=a/);
  assert.match(readState(fixture).pending_by_env.w1.passthrough_sha256, /^[0-9a-f]{64}$/);
  const before = calls(fixture).length;

  const wrongContext = run(fixture, ['create', 'w1', '--apply', '--', '--context=b']);
  assert.notEqual(wrongContext.status, 0);
  assert.match(wrongContext.stderr, /pending operation create w1 must be recovered first/);
  assert.equal(calls(fixture).length, before);

  const recovered = run(fixture, ['create', 'w1', '--apply', '--', '--context=a']);
  assert.equal(recovered.status, 0, recovered.stderr);
  const statusCall = calls(fixture).filter((call) => call.verb === 'status').at(-1);
  assert.ok(statusCall.args.includes('--context=a'));
  assert.equal(readState(fixture).pending_by_env.w1, undefined);
});

test('overlay lifecycle creates, attaches, touches, detaches, and destroys counted state', (t) => {
  const fixture = projectFixture(t);

  const created = run(fixture, ['create', 'w1', '--apply']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /overlay create 1\/1/);
  assert.equal(readState(fixture).envs.w1.services.api, undefined);
  assert.equal(statSync(fixture.stateFile).mode & 0o777, 0o600);
  assert.equal(calls(fixture)[0].cwd, realpathSync(fixture.root));

  const attached = run(fixture, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply']);
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stdout, /overlay attach 1\/1/);
  assert.equal(readState(fixture).envs.w1.services.api.image, FULL_IMAGE);

  const touched = run(fixture, ['touch', 'w1']);
  assert.equal(touched.status, 0, touched.stderr);
  assert.match(touched.stdout, /overlay touch 1\/1/);

  const detached = run(fixture, ['detach', 'w1', 'api', '--apply']);
  assert.equal(detached.status, 0, detached.stderr);
  assert.match(detached.stdout, /overlay detach 1\/1/);
  assert.deepEqual(readState(fixture).envs.w1.services, {});

  const destroyed = run(fixture, ['destroy', 'w1', '--apply']);
  assert.equal(destroyed.status, 0, destroyed.stderr);
  assert.match(destroyed.stdout, /overlay destroy 1\/1/);
  assert.equal(existsSync(fixture.stateFile), false);
});

test('overlay mutations are plans until --apply and do not write lifecycle state', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /overlay create plan 0\/1/);
  assert.equal(existsSync(fixture.stateFile), false);
  assert.equal(calls(fixture).length, 1);
  assert.equal(calls(fixture)[0].apply, false);
});

test('project passthrough cannot smuggle the central --apply gate', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--', '--apply=true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a Grove option/);
  assert.equal(calls(fixture).length, 0);
  assert.equal(existsSync(fixture.stateFile), false);
});

test('project-specific arguments require the explicit -- boundary', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['create', 'w1', '--custom-flag']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must follow --/);
  assert.equal(calls(fixture).length, 0);
});

test('overlay rejects non-SHA images and non-attachable services before dispatch', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const before = calls(fixture).length;

  const latest = run(fixture, ['attach', 'w1', 'api', '--image', 'acme/api:latest', '--apply']);
  assert.notEqual(latest.status, 0);
  assert.match(latest.stderr, /full git SHA|sha256 digest/);

  const shared = run(fixture, ['attach', 'w1', 'worker', '--image', FULL_IMAGE, '--apply']);
  assert.notEqual(shared.status, 0);
  assert.match(shared.stderr, /not attachable/);
  assert.equal(calls(fixture).length, before);
});

test('status exposes stale leases and prune destroys only stale environments on apply', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'old', '--apply']).status, 0);
  assert.equal(run(fixture, ['attach', 'old', 'api', '--image', FULL_IMAGE, '--apply']).status, 0);
  assert.equal(run(fixture, ['create', 'fresh', '--apply']).status, 0);
  const state = readState(fixture);
  state.envs.old.last_used_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(fixture.stateFile, stringify(state), 'utf8');
  const inventory = JSON.stringify([
    { env: 'old', services: [{ service: 'api', image: FULL_IMAGE, ready: true }] },
    { env: 'fresh', services: [] },
  ]);

  const status = run(fixture, ['status'], { GROVE_OVERLAY_STUB_INVENTORY: inventory });
  assert.notEqual(status.status, 0);
  assert.match(status.stdout, /environments {2}2/);
  assert.match(status.stdout, /stale {9}1/);
  assert.match(status.stdout, /drift {9}0/);

  const beforePlan = calls(fixture).length;
  const plan = run(fixture, ['prune']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /overlay prune plan: stale 1\/2, destroyed 0\/1/);
  assert.equal(calls(fixture).length, beforePlan);
  assert.equal(existsSync(fixture.stateFile), true);

  const applied = run(fixture, ['prune', '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /overlay prune 1\/1/);
  assert.deepEqual(Object.keys(readState(fixture).envs), ['fresh']);
  const destroyed = calls(fixture).filter((call) => call.verb === 'destroy').at(-1);
  assert.equal(destroyed.verb, 'destroy');
  assert.equal(destroyed.args[0], 'old');
});

test('prune requires an explicit stale policy when the profile omits one', (t) => {
  const fixture = projectFixture(t, { staleAfter: null });
  const missing = run(fixture, ['prune']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /stale_after|--stale-after/);

  const explicit = run(fixture, ['prune', '--stale-after', '12h']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /stale 0\/0/);
});

test('failed or malformed project receipts retain intent without mutating tracked environments', (t) => {
  const fixture = projectFixture(t);
  const failed = run(fixture, ['create', 'bad', '--apply', '--', '--fail']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /ok: true/);
  assert.equal(readState(fixture).pending_by_env.bad.verb, 'create');
  assert.deepEqual(readState(fixture).envs, {});

  const malformedFixture = projectFixture(t);
  const malformed = run(malformedFixture, ['create', 'bad', '--apply', '--', '--malformed']);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /JSON/);
  assert.equal(readState(malformedFixture).pending_by_env.bad.verb, 'create');
  assert.deepEqual(readState(malformedFixture).envs, {});
});

test('plan_first false refuses implicit execution and strips central --apply on dispatch', (t) => {
  const fixture = projectFixture(t, { planFirst: false });
  const plan = run(fixture, ['create', 'w1']);
  assert.notEqual(plan.status, 0);
  assert.match(plan.stderr, /requires --apply/);
  assert.equal(calls(fixture).length, 0);

  const applied = run(fixture, ['create', 'w1', '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(calls(fixture).length, 2);
  assert.equal(calls(fixture)[0].verb, 'create');
  assert.equal(calls(fixture)[0].apply, false);
  assert.equal(calls(fixture)[1].verb, 'status');
});

test('an apply request rejects a project receipt that is still only a plan', (t) => {
  const fixture = projectFixture(t, { planFirst: false });
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_PLAN_FIRST: 'true',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /returned a plan during --apply/);
  assert.equal(readState(fixture).pending_by_env.w1.verb, 'create');
  assert.deepEqual(readState(fixture).envs, {});
});

test('prune keeps failed environments tracked and counts partial cleanup', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'z-keep', '--apply']).status, 0);
  assert.equal(run(fixture, ['create', 'a-remove', '--apply']).status, 0);
  const state = readState(fixture);
  state.envs['z-keep'].last_used_at = '2000-01-01T00:00:00.000Z';
  state.envs['a-remove'].last_used_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(fixture.stateFile, stringify(state), 'utf8');

  const result = run(fixture, ['prune', '--apply'], {
    GROVE_OVERLAY_STUB_FAIL_ENV: 'z-keep',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /overlay prune 1\/2/);
  assert.match(result.stderr, /retained z-keep/);
  assert.deepEqual(Object.keys(readState(fixture).envs), ['z-keep']);
  assert.equal(readState(fixture).pending_by_env['z-keep'].verb, 'destroy');
  assert.equal(readState(fixture).pending_by_env['z-keep'].source, 'prune');

  const pendingState = readState(fixture);
  pendingState.envs['z-keep'].last_used_at = '2999-01-01T00:00:00.000Z';
  writeFileSync(fixture.stateFile, stringify(pendingState), 'utf8');

  const recovered = run(fixture, ['prune', '--apply']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /recovered pending destroy z-keep/);
  assert.equal(existsSync(fixture.stateFile), false);
});

test('overlay status reports untracked runtime environments as drift', (t) => {
  const fixture = projectFixture(t);
  const inventory = JSON.stringify([{ env: 'orphan', services: ['api'] }]);
  const result = run(fixture, ['status'], { GROVE_OVERLAY_STUB_INVENTORY: inventory });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /drift {9}1/);
  assert.match(result.stdout, /orphan.*untracked/);
});

test('status keeps reporting known leases when the project runtime check fails', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const result = run(fixture, ['status', '--', '--fail']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /environments {2}1/);
  assert.match(result.stdout, /project-status {2}0\/1/);
  assert.match(result.stdout, /drift {9}notMeasured/);
  assert.match(result.stderr, /ok: true/);
});

test('status treats malformed runtime inventory as not measured without hiding leases', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const result = run(fixture, ['status'], {
    GROVE_OVERLAY_STUB_INVENTORY: JSON.stringify('not-a-list'),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /environments {2}1/);
  assert.match(result.stdout, /project-status {2}0\/1/);
  assert.match(result.stdout, /drift {9}notMeasured/);
  assert.match(result.stderr, /environments must be a list/);
});

test('an untracked runtime environment can be explicitly destroyed but is never aged', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['destroy', 'orphan', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /overlay destroy 1\/1/);
  assert.equal(calls(fixture).filter((call) => call.verb === 'destroy').at(-1).verb, 'destroy');
  assert.equal(existsSync(fixture.stateFile), false);
});

test('a live registry lock blocks mutation and a dead same-machine lock is recovered', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const lock = `${fixture.stateFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }), 'utf8');
  const blocked = run(fixture, ['touch', 'w1']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /registry is locked/);

  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, host: hostname() }), 'utf8');
  const recovered = run(fixture, ['touch', 'w1']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(lock), false);
});

test('main help advertises overlay lifecycle commands', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /overlay (create|<verb>)/);
  assert.match(result.stdout, /prune/);
  assert.match(result.stdout, /touch/);
});

for (const [label, services] of [
  ['old image', [{ service: 'api', image: `acme/api:${'b'.repeat(40)}`, ready: true }]],
  ['not ready', [{ service: 'api', image: FULL_IMAGE, ready: false }]],
  ['name only', ['api']],
]) {
  test(`attach cannot finalize from ${label} inventory`, (t) => {
    const fixture = projectFixture(t);
    assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
    const result = run(fixture, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply'], {
      GROVE_OVERLAY_STUB_INVENTORY: JSON.stringify([{ env: 'w1', services }]),
      GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '300',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /postcondition.*pending operation retained/i);
    assert.equal(readState(fixture).pending_by_env.w1.image, FULL_IMAGE);
    assert.equal(readState(fixture).envs.w1.services.api, undefined);
    const recovered = run(fixture, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readState(fixture).pending_by_env.w1, undefined);
  });

  test(`status refuses a clean result for ${label} inventory`, (t) => {
    const fixture = projectFixture(t);
    assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
    assert.equal(run(fixture, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply']).status, 0);
    const result = run(fixture, ['status'], {
      GROVE_OVERLAY_STUB_INVENTORY: JSON.stringify([{ env: 'w1', services }]),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /drift {9}1/);
  });
}

test('status without runtime inventory is non-zero', (t) => {
  const fixture = projectFixture(t);
  const result = run(fixture, ['status'], { GROVE_OVERLAY_STUB_OMIT_INVENTORY: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /drift {9}notMeasured/);
});

test('status --json reports environments, pending liveness and drift as data with the text verdict', (t) => {
  const fixture = projectFixture(t);
  assert.throws(() => parseOverlayCliArgs(['create', 'w1', '--json']), /--json is valid only for status/);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const clean = run(fixture, ['status', '--json']);
  assert.equal(clean.status, 0, clean.stderr);
  const report = JSON.parse(clean.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.scope, null);
  assert.deepEqual(report.environments.map((entry) => entry.env), ['w1']);
  assert.equal(report.environments[0].stale, false);
  assert.deepEqual(report.environments[0].services, []);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.drift, []);
  assert.equal(report.project_status.ok, true);
  assert.equal(report.counts.environments, 1);

  const interrupted = run(fixture, ['create', 'w2', '--apply'], { GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true' });
  assert.notEqual(interrupted.status, 0);
  const pending = run(fixture, ['status', '--json']);
  assert.notEqual(pending.status, 0);
  const stalled = JSON.parse(pending.stdout);
  assert.equal(stalled.ok, false);
  assert.equal(stalled.counts.pending, 1);
  assert.deepEqual([stalled.pending[0].verb, stalled.pending[0].env, stalled.pending[0].liveness, stalled.pending[0].pid], ['create', 'w2', 'stalled', null]);
  const text = run(fixture, ['status']);
  assert.equal(text.status, pending.status, 'json and text share the exit code');
  t.diagnostic('json reports 2/2; verdict parity 1/1; --json rejected off status 1/1');
});

test('the project command receives the caller directory as GROVE_CALLER_CWD', (t) => {
  const fixture = projectFixture(t);
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'caller-cwd-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, 'overlay', 'create', 'w1', '--apply', '--project', fixture.root], {
    cwd: elsewhere,
    encoding: 'utf8',
    env: { ...process.env, GROVE_STATE_DIR: fixture.stateDir, GROVE_OVERLAY_STUB_LOG: fixture.log, GROVE_OVERLAY_STUB_RUNTIME_STATE: fixture.runtimeState, GROVE_OVERLAY_STUB_PLAN_FIRST: 'true' },
  });
  assert.equal(result.status, 0, result.stderr);
  const dispatched = calls(fixture);
  assert.ok(dispatched.length >= 2, 'create and its status verification were dispatched');
  for (const call of dispatched) {
    assert.equal(call.callerCwd, realpathSync(elsewhere));
    assert.equal(call.cwd, realpathSync(fixture.root), 'the command still runs from the project root');
  }
  t.diagnostic(`GROVE_CALLER_CWD present on ${dispatched.length}/${dispatched.length} dispatches`);
});

test('a refusal receipt before mutation withdraws the pending journal; a refused retry keeps an older one', (t) => {
  const fixture = projectFixture(t);
  assert.equal(run(fixture, ['create', 'w1', '--apply']).status, 0);
  const refused = run(fixture, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply'], { GROVE_OVERLAY_STUB_REFUSE: 'true' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /project refused attach: refused by fixture/);
  assert.match(refused.stderr, /Nothing pending/);
  assert.equal(readState(fixture).pending_by_env.w1, undefined, 'no journal after a clean refusal');
  assert.deepEqual(runtimeState(fixture).environments.w1, [], 'runtime untouched');
  assert.equal(run(fixture, ['destroy', 'w1', '--apply']).status, 0, 'the environment is not locked afterwards');

  assert.equal(run(fixture, ['create', 'w2', '--apply']).status, 0);
  const interrupted = run(fixture, ['attach', 'w2', 'api', '--image', FULL_IMAGE, '--apply'], { GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION: 'true' });
  assert.notEqual(interrupted.status, 0);
  assert.equal(readState(fixture).pending_by_env.w2.verb, 'attach');
  const refusedRetry = run(fixture, ['attach', 'w2', 'api', '--image', FULL_IMAGE, '--apply'], { GROVE_OVERLAY_STUB_REFUSE: 'true' });
  assert.notEqual(refusedRetry.status, 0);
  assert.equal(readState(fixture).pending_by_env.w2.verb, 'attach', 'an older journal survives a refused retry');
  t.diagnostic('clean refusal withdrew 1/1 journals; refused retry kept 1/1');
});

test('create_on: attach lets the first applied attach create the environment from the caller directory', (t) => {
  const byPlan = projectFixture(t);
  const refused = run(byPlan, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /create it first/);

  const byAttach = projectFixture(t, { createOn: 'attach' });
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'create-on-attach-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const attached = spawnSync(process.execPath, [CLI, 'overlay', 'attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply', '--project', byAttach.root], {
    cwd: elsewhere, encoding: 'utf8',
    env: { ...process.env, GROVE_STATE_DIR: byAttach.stateDir, GROVE_OVERLAY_STUB_LOG: byAttach.log, GROVE_OVERLAY_STUB_RUNTIME_STATE: byAttach.runtimeState, GROVE_OVERLAY_STUB_PLAN_FIRST: 'true' },
  });
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stdout, /overlay create 1\/1: w1 \(create_on: attach\)/);
  const verbs = calls(byAttach).filter((c) => c.verb !== 'status').map((c) => c.verb);
  assert.deepEqual(verbs, ['create', 'attach'], 'create is dispatched once, before attach');
  for (const call of calls(byAttach)) assert.equal(call.callerCwd, realpathSync(elsewhere));
  const state = readState(byAttach);
  assert.equal(state.envs.w1.services.api.image, FULL_IMAGE);
  assert.deepEqual(state.pending_by_env, {});
  assert.equal(run(byAttach, ['attach', 'w1', 'api', '--image', FULL_IMAGE, '--apply']).status, 0, 'a second attach does not create again');
  assert.equal(calls(byAttach).filter((c) => c.verb === 'create').length, 1);
  t.diagnostic('create_on plan refused 1/1; create_on attach created+attached 1/1; caller cwd on all dispatches');
});

// --------------------------------------------------------------- verify
// The stub is a conforming adapter; each switch below breaks exactly one
// contract obligation so verify has to name the case that caught it.
const VERIFY_ENV = {
  GROVE_OVERLAY_STUB_ATTACHABLE: 'api',
  GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2000',
};

function runVerify(fixture, args = [], extraEnv = {}) {
  return run(fixture, ['verify', ...args], { ...VERIFY_ENV, ...extraEnv });
}

test('overlay verify passes against a conforming adapter and counts every case', (t) => {
  const fixture = projectFixture(t);
  const result = runVerify(fixture, ['--env', 'vfy', '--image', FULL_IMAGE, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { cases: 10, passed: 10, failed: 0, skipped: 0 });
  assert.deepEqual(report.cases.map((item) => item.name), [
    'plan-mutates-nothing',
    'create-observed',
    'create-idempotent',
    'attach-refuses-unknown-service',
    'attach-refuses-mutable-tag',
    'attach-observed',
    'status-inventory-shape',
    'receipt-identity',
    'refusal-leaves-no-journal',
    'destroy-observed',
  ]);
  for (const item of report.cases) assert.ok(item.evidence.length > 0, `${item.name} reported evidence`);
  assert.equal(report.cleanup.ok, true);
  assert.equal(existsSync(fixture.stateFile), false, 'verify leaves no lease behind');
  assert.deepEqual(runtimeState(fixture).environments, {}, 'verify leaves no environment behind');
  t.diagnostic(`verify cases ${report.counts.passed}/${report.counts.cases}; cleanup 1/1`);
});

test('overlay verify counts skipped attach cases without --image and refuses a name in use', (t) => {
  const fixture = projectFixture(t);
  const skipped = runVerify(fixture, ['--env', 'vfy']);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /cases {9}6\/6/);
  assert.match(skipped.stdout, /skipped {7}4/);
  assert.match(skipped.stdout, /skip {2}attach-observed {2,}--image is required/);

  assert.equal(run(fixture, ['create', 'taken', '--apply']).status, 0);
  const before = calls(fixture).length;
  const refused = runVerify(fixture, ['--env', 'taken']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already tracked/);
  assert.deepEqual(
    [...new Set(calls(fixture).slice(before).map((call) => call.verb))],
    [],
    'a refused verify dispatches nothing'
  );
  assert.ok(readState(fixture).envs.taken, 'the existing environment is untouched');
  t.diagnostic("skipped 4/4 without --image; existing name refused 1/1");
});

test('overlay verify rejects options that do not belong to it', () => {
  assert.throws(() => parseOverlayCliArgs(['verify', '--apply']), /--apply is not valid for verify/);
  assert.throws(() => parseOverlayCliArgs(['create', 'w1', '--env', 'x']), /--env is not valid for create/);
  assert.throws(() => parseOverlayCliArgs(['verify', 'w1']), /must follow --/);
});

for (const [label, broken, expected, evidence] of [
  ['a name-only status inventory', { GROVE_OVERLAY_STUB_NAME_ONLY: 'true' }, 'status-inventory-shape', /name-only/],
  ['an adapter that accepts a mutable tag', { GROVE_OVERLAY_STUB_ACCEPT_ANY_IMAGE: 'true' }, 'attach-refuses-mutable-tag', /the adapter accepted/],
  ['a create that is not idempotent', { GROVE_OVERLAY_STUB_DUPLICATE_ENVS: 'true' }, 'create-idempotent', /create left environments/],
]) {
  test(`overlay verify fails and names the case for ${label}`, (t) => {
    const fixture = projectFixture(t);
    const result = runVerify(fixture, ['--env', 'vfy', '--image', FULL_IMAGE, '--json'], {
      ...broken,
      GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '400',
    });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    const failed = report.cases.filter((item) => item.status === 'fail');
    const named = failed.find((item) => item.name === expected);
    assert.ok(named, `expected ${expected} to fail, got ${failed.map((item) => item.name).join(',') || 'none'}`);
    assert.match(named.evidence, evidence);
    assert.equal(report.cleanup.ok, true, 'verify cleans up its environment even when a case fails');
    assert.deepEqual(runtimeState(fixture).environments, {}, 'no environment is left behind');
    t.diagnostic(`${expected} failed 1/1 with evidence; cleanup 1/1`);
  });
}

test('verify picks the attach service from --service, then the image, then the first attachable', () => {
  const attachable = ['wms-web', 'oms-web', 'seller'];
  assert.equal(verifyAttachService({ service: 'seller', image: 'reg/oms-web:' + 'a'.repeat(40), attachable }), 'seller');
  assert.equal(verifyAttachService({ service: null, image: 'reg/oms-web:' + 'a'.repeat(40), attachable }), 'oms-web');
  assert.equal(verifyAttachService({ service: null, image: 'reg/oms-web@sha256:' + 'b'.repeat(64), attachable }), 'oms-web');
  assert.equal(verifyAttachService({ service: null, image: 'reg/not-declared:' + 'a'.repeat(40), attachable }), 'wms-web');
  assert.equal(verifyAttachService({ service: null, image: null, attachable }), 'wms-web');
  assert.throws(() => verifyAttachService({ service: 'nope', image: null, attachable }), /not in overlay.attachable/);
  assert.throws(() => parseOverlayCliArgs(['attach', 'w1', 'api', '--service', 'x', '--image', FULL_IMAGE]), /only for verify/);
  assert.equal(parseOverlayCliArgs(['verify', '--service', 'oms-web']).service, 'oms-web');
});
