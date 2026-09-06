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

function projectFixture(t, { planFirst = true, staleAfter = '1h' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'grove-overlay-'));
  const stateDir = path.join(root, 'state');
  const log = path.join(root, 'overlay-calls.jsonl');
  const runtimeState = path.join(root, 'overlay-runtime.json');
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  const staleLine = staleAfter == null ? '' : `  stale_after: ${staleAfter}\n`;
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
  const result = run(fixture, ['create', 'w1', '--apply'], {
    GROVE_OVERLAY_STUB_OMIT_INVENTORY: 'true',
    GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '500',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /omitted environments/);
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
