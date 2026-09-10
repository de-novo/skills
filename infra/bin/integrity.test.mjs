// Handoff integrity: an earlier completion never bleeds into a new task, a
// dependent item gets the result it needs, no trust is granted without a
// person, and a failed attempt keeps its record while the next one starts.
// Every case here was first reproduced against the audited base
// 3ccdbdaf5474bc688e0a3c56721c77e30124adb2 (2026-09-10) and went red before
// the fix landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { claimsIntersect, claimSegments, itemRevision, itemStates, parseForesterPlan } from '../lib/forester.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const TOOL = path.join(HERE, 'fixtures/forester-tool.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = `version: 1
tasks:
  define-shape:
    task: "Decide the response shape and write it into the reference"
    owns: [docs/reference/**]
    retry: { max_attempts: 2 }
  api-endpoint:
    task: "Add the endpoint returning that shape"
    owns: [src/api/**]
    depends_on: [define-shape]
  web-panel:
    task: "Show it in the page"
    owns: [src/web/**]
    depends_on: [{ item: define-shape, needs: order }]
`;

function gitIn(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Integrity Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, { plan = PLAN, local = 'version: 1\nparallel: 2\n' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'integrity-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  mkdirSync(path.join(baseline, 'src/api'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'integrity-test' }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none' }));
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/forester-plan.yml'), plan);
  if (local != null) writeFileSync(path.join(baseline, '.agents/forester.local.yml'), local);
  writeFileSync(path.join(baseline, 'app.txt'), 'baseline\n');
  writeFileSync(path.join(baseline, 'src/api/handler.mjs'), 'export default 1;\n');
  gitIn(baseline, ['init', '-b', 'main']);
  gitIn(baseline, ['add', '.']);
  gitIn(baseline, ['commit', '-m', 'baseline']);
  const run = (args, { cwd = baseline } = {}) =>
    spawnSync(process.execPath, [CLI, ...args, '--project', baseline], { cwd, env: environment, encoding: 'utf8', timeout: 20000 });
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
  const json = (args) => JSON.parse(good([...args, '--json']).stdout);
  const seat = (id) => path.join(root, 'seats', id);
  const item = (id) => json(['forester', 'plan']).items.find((row) => row.id === id);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, baseline, environment, run, good, bad, json, seat, item };
}

// ------------------------------------------------------------ F02 identity

test('F02: an archived done counts only for the same task revision; a v1 record without one is never reused', () => {
  const plan = parseForesterPlan(PLAN);
  const observed = { head: 'base0', contains: () => true, headOf: () => null };
  const row = (rows, id) => rows.find((item) => item.id === id);
  const revision = itemRevision(plan.tasks[0]);
  assert.match(revision, /^[0-9a-f]{16}$/);
  // Whitespace in the task line is not a new task; a new owns claim is.
  assert.equal(itemRevision({ ...plan.tasks[0], task: `  ${plan.tasks[0].task}\n` }), revision);
  assert.notEqual(itemRevision({ ...plan.tasks[0], owns: ['docs/**'] }), revision);

  let rows = itemStates({ plan, state: { seats: {} }, finished: { seats: [{ id: 'define-shape', status: 'done' }] }, observed });
  assert.equal(row(rows, 'define-shape').state, 'ready');
  assert.match(row(rows, 'define-shape').why, /archived done .*no revision/);

  rows = itemStates({ plan, state: { seats: {} }, finished: { seats: [{ id: 'define-shape', status: 'done', revision: 'deadbeefdeadbeef', result: { head: 'h1', clean: true } }] }, observed });
  assert.equal(row(rows, 'define-shape').state, 'ready');
  assert.match(row(rows, 'define-shape').why, /revision deadbeefdeadbeef, not/);

  rows = itemStates({ plan, state: { seats: {} }, finished: { seats: [{ id: 'define-shape', status: 'done', revision, result: { head: 'h1', clean: true } }] }, observed });
  assert.equal(row(rows, 'define-shape').state, 'done');
  assert.equal(row(rows, 'api-endpoint').state, 'ready');
  // The dependent's revision carries the result it was built on: a redone
  // define-shape with a new head makes api-endpoint's earlier done stale.
  const apiRevision = itemRevision(plan.tasks[1], { inputs: { 'define-shape': 'h1' } });
  assert.notEqual(itemRevision(plan.tasks[1], { inputs: { 'define-shape': 'h2' } }), apiRevision);
  rows = itemStates({
    plan,
    state: { seats: {} },
    finished: { seats: [
      { id: 'define-shape', status: 'done', revision, result: { head: 'h1', clean: true } },
      { id: 'api-endpoint', status: 'done', revision: apiRevision, result: { head: 'h3', clean: true } },
    ] },
    observed,
  });
  assert.equal(row(rows, 'api-endpoint').state, 'done');
});

// ------------------------------------------------------- F01 materialization

test('F01: a done report alone does not release a result dependency; the result must be in the baseline the next seat starts from', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const seatA = f.seat('define-shape');
  mkdirSync(path.join(seatA, 'docs/reference'), { recursive: true });
  writeFileSync(path.join(seatA, 'docs/reference/shape.md'), '# shape\n');
  gitIn(seatA, ['add', '.']);
  gitIn(seatA, ['commit', '-m', 'shape']);
  const headA = gitIn(seatA, ['rev-parse', 'HEAD']);
  f.good(['dryad', 'report', 'define-shape', '--status', 'done', '--note', 'shape written']);

  // done is recorded with the seat's own head, never a worker-supplied one.
  const status = f.json(['dryad', 'status']);
  const reported = status.seats.find((seat) => seat.id === 'define-shape');
  assert.equal(reported.result.head, headA);
  assert.equal(reported.result.clean, true);
  assert.equal(reported.result.evidence, null);

  let api = f.item('api-endpoint');
  assert.equal(api.state, 'waiting', JSON.stringify(api));
  assert.match(api.why, /define-shape .*not in baseline HEAD/);
  let panel = f.item('web-panel');
  assert.equal(panel.state, 'ready', 'an order-only dependency is released by the report');
  assert.deepEqual(f.json(['forester', 'next']).next, ['web-panel']);
  const before = f.good(['forester', 'assign', '--apply']).stdout;
  assert.match(before, /assigned 1\/1/);
  assert.equal(existsSync(path.join(f.seat('web-panel'), 'docs/reference/shape.md')), false);

  // A person integrates the branch; the dependent becomes ready on a base that holds it.
  gitIn(f.baseline, ['merge', '--ff-only', 'dryad/define-shape']);
  api = f.item('api-endpoint');
  assert.equal(api.state, 'ready', JSON.stringify(api));
  f.good(['forester', 'assign', '--apply']);
  const seatB = f.seat('api-endpoint');
  assert.equal(readFileSync(path.join(seatB, 'docs/reference/shape.md'), 'utf8'), '# shape\n');
  const seatRecord = f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'api-endpoint');
  assert.equal(seatRecord.base, gitIn(f.baseline, ['rev-parse', 'HEAD']));
  assert.deepEqual(seatRecord.inputs, { 'define-shape': headA });
  const handoff = f.good(['dryad', 'seat', 'api-endpoint', '--task']).stdout;
  assert.match(handoff, /define-shape/);
  assert.match(handoff, new RegExp(headA.slice(0, 12)));
});

test('F01: a squash integration needs an explicit record naming a real commit; a false sha is refused', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const seatA = f.seat('define-shape');
  mkdirSync(path.join(seatA, 'docs/reference'), { recursive: true });
  writeFileSync(path.join(seatA, 'docs/reference/shape.md'), '# shape\n');
  gitIn(seatA, ['add', '.']);
  gitIn(seatA, ['commit', '-m', 'shape']);
  f.good(['dryad', 'report', 'define-shape', '--status', 'done']);
  gitIn(f.baseline, ['merge', '--squash', 'dryad/define-shape']);
  gitIn(f.baseline, ['commit', '-m', 'squash: shape']);
  const squash = gitIn(f.baseline, ['rev-parse', 'HEAD']);
  assert.equal(f.item('api-endpoint').state, 'waiting', 'a squash leaves the original head outside the baseline');

  const refused = f.bad(['dryad', 'integrate', 'define-shape', '--commit', 'ffffffffffffffffffffffffffffffffffffffff', '--apply']);
  assert.match(refused.stderr, /not a commit of this repository/);
  const plan = f.good(['dryad', 'integrate', 'define-shape', '--commit', squash]).stdout;
  assert.match(plan, /would record/);
  assert.equal(f.item('api-endpoint').state, 'waiting');
  f.good(['dryad', 'integrate', 'define-shape', '--commit', squash, '--by', 'human:reviewer', '--apply']);
  const api = f.item('api-endpoint');
  assert.equal(api.state, 'ready', JSON.stringify(api));
  assert.match(api.why, /integrated as/);

  // The finished archive keeps the integration with the seat.
  f.good(['dryad', 'finish', 'define-shape', '--apply']);
  assert.equal(f.item('api-endpoint').state, 'ready');
  const archived = f.json(['dryad', 'status', '--finished']).finished.find((seat) => seat.id === 'define-shape');
  assert.equal(archived.integration.commit, squash);
});

test('F01: done with uncommitted changes, or a worktree that moved after done, is not a usable result', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const seatA = f.seat('define-shape');
  mkdirSync(path.join(seatA, 'docs/reference'), { recursive: true });
  writeFileSync(path.join(seatA, 'docs/reference/dirty.md'), 'dirty\n');
  const report = f.good(['dryad', 'report', 'define-shape', '--status', 'done']);
  assert.match(report.stderr, /uncommitted/);
  let api = f.item('api-endpoint');
  assert.equal(api.state, 'waiting');
  assert.match(api.why, /uncommitted/);

  gitIn(seatA, ['add', '.']);
  gitIn(seatA, ['commit', '-m', 'late commit']);
  api = f.item('api-endpoint');
  assert.equal(api.state, 'blocked', 'a moved seat is active again, so its dependents wait for it');
  const shape = f.item('define-shape');
  assert.equal(shape.state, 'active');
  assert.match(shape.why, /moved to .*report again/);
});

test('a seat has one evidence file, named by its environment and the handoff; a done report reads it without --evidence', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const seat = f.json(['dryad', 'seat', 'define-shape']);
  assert.equal(seat.evidence_file, seat.env_vars.DRYAD_EVIDENCE);
  assert.match(seat.evidence_file, /\/define-shape\.evidence\.yml$/);
  assert.equal(existsSync(seat.evidence_file), false, 'the worker writes it; Dryad does not');
  const handoff = f.good(['dryad', 'seat', 'define-shape', '--task']).stdout;
  assert.match(handoff, new RegExp(`Evidence file: ${seat.evidence_file.replaceAll('/', '\\/')}`), 'the handoff names the file literally');
  assert.match(handoff, /Seat id: define-shape \(use it as written/);
  assert.match(handoff, /--evidence - <<'EOF'/);
  assert.match(handoff, /Run each command on its own line, with literal ids and paths/);
  writeFileSync(seat.evidence_file, stringify({ checks: [{ command: 'npm test', exit: 0, observed: '3/3' }] }));
  const report = f.good(['dryad', 'report', 'define-shape', '--status', 'done']);
  assert.doesNotMatch(report.stderr, /unverified/);
  assert.equal(f.json(['dryad', 'status']).seats[0].result.evidence.checks[0].command, 'npm test');
  assert.equal(f.item('define-shape').verification, 'verified');
  f.good(['dryad', 'finish', 'define-shape', '--apply']);
  assert.equal(existsSync(seat.evidence_file), false, 'finish removes it with the seat');

  // Evidence handed in with the report on stdin: no file write at all.
  f.good(['forester', 'assign', '--apply']);
  const piped = spawnSync(process.execPath, [CLI, 'dryad', 'report', 'web-panel', '--status', 'done', '--evidence', '-', '--project', f.baseline], { cwd: f.baseline, env: f.environment, encoding: 'utf8', input: stringify({ checks: [{ command: 'node --check x.mjs', exit: 0, observed: 'no output' }], not_measured: [{ boundary: 'browser', reason: 'none here' }] }) });
  assert.equal(piped.status, 0, piped.stderr);
  const record = f.json(['dryad', 'status']).seats.find((row) => row.id === 'web-panel');
  assert.equal(record.result.evidence.checks[0].command, 'node --check x.mjs');
  assert.equal(record.result.evidence.not_measured[0].boundary, 'browser');
  const empty = spawnSync(process.execPath, [CLI, 'dryad', 'report', 'web-panel', '--status', 'done', '--evidence', '-', '--project', f.baseline], { cwd: f.baseline, env: f.environment, encoding: 'utf8', input: '' });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--evidence -: nothing on stdin/);
});

test('F03/WP-03: evidence is recorded as given and shown as unverified when absent', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const evidence = path.join(f.root, 'evidence.yml');
  writeFileSync(evidence, stringify({ checks: [{ command: 'npm test', cwd: '.', exit: 0, observed: 'tests 3/3' }], not_measured: [{ boundary: 'browser', reason: 'no runner in the seat' }] }));
  writeFileSync(path.join(f.root, 'bad.yml'), stringify({ checks: [{ command: 'npm test' }] }));
  assert.match(f.bad(['dryad', 'report', 'define-shape', '--status', 'done', '--evidence', path.join(f.root, 'bad.yml')]).stderr, /checks\[0\]\.exit/);
  f.good(['dryad', 'report', 'define-shape', '--status', 'done', '--evidence', evidence]);
  const seat = f.json(['dryad', 'status']).seats.find((row) => row.id === 'define-shape');
  assert.deepEqual(seat.result.evidence.checks[0], { command: 'npm test', cwd: '.', exit: 0, observed: 'tests 3/3' });
  assert.equal(seat.result.evidence.not_measured[0].boundary, 'browser');
  assert.equal(f.item('define-shape').verification, 'verified');
});

// --------------------------------------------------------------- F04 retry

test('F04: a new attempt takes a fresh branch and keeps the failed one; --resume continues the previous branch', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  const seatA = f.seat('define-shape');
  writeFileSync(path.join(seatA, 'attempt.txt'), 'first\n');
  gitIn(seatA, ['add', '.']);
  gitIn(seatA, ['commit', '-m', 'first attempt']);
  f.good(['dryad', 'finish', 'define-shape', '--apply']);
  assert.equal(f.item('define-shape').state, 'ready', 'two attempts allowed');

  const second = f.good(['forester', 'assign', '--apply']);
  assert.match(second.stdout, /assigned 1\/1/);
  const record = f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'define-shape');
  assert.equal(record.branch, 'dryad/define-shape-2');
  assert.equal(record.attempt, 2);
  assert.equal(existsSync(path.join(seatA, 'attempt.txt')), false, 'a fresh attempt starts from the baseline, not the failed branch');
  assert.equal(gitIn(f.baseline, ['rev-parse', '--verify', 'refs/heads/dryad/define-shape']).length, 40, 'the failed branch is kept');
  f.good(['dryad', 'finish', 'define-shape', '--apply']);

  // A resumed attempt sits on the previous branch, base unchanged.
  const resumed = f.good(['dryad', 'plan', 'define-shape', '--task', 'continue', '--resume', '--apply']).stdout;
  assert.match(resumed, /resumes attempt 2/);
  const again = f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'define-shape');
  assert.equal(again.branch, 'dryad/define-shape-2');
  assert.equal(again.attempt, 3);
  assert.equal(again.resumed_from, 2);
});

// -------------------------------------------------------------- F07 claims

test('F07: claims are normalized and validated; alias spellings are one claim', () => {
  assert.deepEqual(claimSegments('./src//api/'), ['src', 'api']);
  assert.equal(claimsIntersect('src/api/handler.mjs', './src/api/handler.mjs'), true);
  const plan = (owns) => `version: 1\ntasks:\n  a: { task: x, owns: [${JSON.stringify(owns)}] }\n`;
  assert.throws(() => parseForesterPlan(plan('/etc/passwd')), /owns\[0\] must be relative/);
  assert.throws(() => parseForesterPlan(plan('../other/**')), /owns\[0\] must not leave the repository/);
  assert.throws(() => parseForesterPlan(plan('src/../src/api')), /owns\[0\] must not leave the repository/);
  assert.throws(() => parseForesterPlan(plan('src/{a,b}/**')), /owns\[0\] uses an unsupported glob/);
  assert.deepEqual(parseForesterPlan(plan('./src//api/')).tasks[0].owns, ['src/api']);
  assert.throws(() => parseForesterPlan('version: 1\ntasks:\n  a: { task: x, read_only: true, owns: [src] }\n'), /read_only item must not own paths/);
  assert.equal(parseForesterPlan('version: 1\ntasks:\n  a: { task: x, read_only: true }\n').tasks[0].readOnly, true);
});

test('F07: a done report is refused while the seat changed paths outside its scope; renames count on both sides', (t) => {
  const f = fixture(t);
  f.good(['forester', 'assign', '--apply']);
  f.good(['dryad', 'report', 'define-shape', '--status', 'done']);
  gitIn(f.baseline, ['merge', '--ff-only', 'dryad/define-shape']);
  f.good(['forester', 'assign', '--apply']);
  const seatB = f.seat('api-endpoint');
  const scope = f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'api-endpoint').scope;
  assert.deepEqual(scope, ['src/api/**']);
  mkdirSync(path.join(seatB, 'src/web'), { recursive: true });
  gitIn(seatB, ['mv', 'src/api/handler.mjs', 'src/web/handler.mjs']);
  gitIn(seatB, ['commit', '-m', 'move']);
  writeFileSync(path.join(seatB, 'notes.txt'), 'untracked\n');
  const refused = f.bad(['dryad', 'report', 'api-endpoint', '--status', 'done']);
  assert.match(refused.stderr, /outside its scope/);
  assert.match(refused.stderr, /src\/web\/handler\.mjs/);
  assert.match(refused.stderr, /notes\.txt/);
  assert.equal(f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'api-endpoint').status, 'planned', 'a refused report changes no status');
  const accepted = f.good(['dryad', 'report', 'api-endpoint', '--status', 'done', '--accept-outside-scope']);
  assert.match(accepted.stdout, /done/);
  const record = f.json(['dryad', 'status']).seats.find((seat) => seat.id === 'api-endpoint');
  assert.deepEqual(record.result.outside_scope.sort(), ['notes.txt', 'src/web/handler.mjs']);
});

// ------------------------------------------------------------- WP-01 trust

// serve with a tool named claude, a stand-in that behaves like one at the
// seams serve reads. The person's Claude state file must be byte-identical
// before and after the launch unless the local file opts in for worktrees.
async function serveOnce(t, f, { pretrust = false }) {
  const configDir = mkdtempSync(path.join(tmpdir(), 'integrity-claude-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const trustFile = path.join(configDir, '.claude.json');
  writeFileSync(trustFile, JSON.stringify({ projects: { '/somewhere/else': { hasTrustDialogAccepted: true } }, theme: 'dark' }, null, 2) + '\n');
  const before = createHash('sha256').update(readFileSync(trustFile)).digest('hex');
  const bin = path.join(f.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, 'claude');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(TOOL)} "$1"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(path.join(f.baseline, '.agents/forester.local.yml'), `version: 1\nparallel: 1\ntool: claude\ntools:\n  claude:\n    command: [${JSON.stringify(wrapper)}, "{task}"]\n${pretrust ? '    pretrust_worktrees: true\n' : ''}`);
  const environment = { ...f.environment, CLAUDE_CONFIG_DIR: configDir, FORESTER_POLL_MS: '300' };
  const serve = spawn(process.execPath, [CLI, 'forester', 'serve', '--project', f.baseline], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.on('data', (chunk) => { log += chunk; });
  serve.stderr.on('data', (chunk) => { log += chunk; });
  t.after(() => { if (serve.exitCode == null) serve.kill('SIGKILL'); });
  const deadline = Date.now() + 15000;
  let session = null;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [CLI, 'forester', 'status', '--json', '--project', f.baseline], { env: environment, encoding: 'utf8' });
    try { session = JSON.parse(result.stdout).items.find((item) => item.id === 'define-shape')?.session ?? null; } catch {}
    if (session?.state === 'needs-input') break;
    await sleep(100);
  }
  assert.equal(session?.state, 'needs-input', `session reached needs-input\n${log}`);
  serve.kill('SIGINT');
  await sleep(500);
  return { before, after: createHash('sha256').update(readFileSync(trustFile)).digest('hex'), trustFile, log };
}

test('WP-01: a default serve launch never edits the person\'s Claude state file; pretrust_worktrees is the explicit opt-in', async (t) => {
  const f = fixture(t);
  const silent = await serveOnce(t, f, { pretrust: false });
  assert.equal(silent.after, silent.before, 'trust file untouched by a default launch');
  assert.match(silent.log, /trust not seeded/);
  assert.doesNotMatch(silent.log, /trust seeded/);

  const g = fixture(t);
  const seeded = await serveOnce(t, g, { pretrust: true });
  assert.notEqual(seeded.after, seeded.before);
  const written = JSON.parse(readFileSync(seeded.trustFile, 'utf8'));
  assert.equal(written.projects[g.seat('define-shape')].hasTrustDialogAccepted, true);
  assert.equal(written.projects['/somewhere/else'].hasTrustDialogAccepted, true);
  assert.equal(written.theme, 'dark');
});
