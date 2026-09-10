import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { parseDryadCliArgs, parseDryadProfile, readDryadFinished, readDryadProjectsIndex, readDryadState } from '../lib/dryad.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');
const SKILL = path.resolve(HERE, '../../skills/dryad/SKILL.md');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
function fixture(t, { overlay = false, worktrees = true, createOn = null } = {}) {
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
  // A fixture command is nobody's seat: the suite itself may run in one.
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(root, 'process-test-marker'), 'owned fixture');
  const runtime = { project: { slug: 'dryad-test' }, services: { api: {} }, data: { infra: 'project' } };
  if (overlay) {
    // tld pinned so the rendered hostnames do not depend on this machine's addressing.local.yml.
    runtime.addressing = { tld: 'localhost', scheme: { overlay: '{service}--{env}.{project}.{tld}' } };
    runtime.runtime = { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } };
    runtime.overlay = { attachable: ['api'], stale_after: '1h', ...(createOn ? { create_on: createOn } : {}) };
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
  const images = [];
  if (overlay) {
    const artifacts = {};
    for (const revision of ['a', 'b']) {
      const source = `// ${revision}\n` + readFileSync(path.join(HERE, 'fixtures/process-workload.mjs'), 'utf8');
      const image = `process/api@sha256:${createHash('sha256').update(source).digest('hex')}`;
      const file = path.join(root, `${revision}.mjs`);
      writeFileSync(file, source);
      artifacts[image] = file;
      images.push(image);
    }
    writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify(artifacts));
  }
  const children = new Set();
  const gate = (verb, env) => path.join(root, `gate-${verb}-${env}`);
  const enter = async (verb, env) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(gate(verb, env) + '.entered') && Date.now() < deadline) await sleep(10);
    assert.ok(existsSync(gate(verb, env) + '.entered'), `${verb} ${env} reached the backend`);
  };
  const launchOverlay = (args, cwd) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'overlay', ...args, '--project', baseline], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (value) => { stdout += value; });
      child.stderr.on('data', (value) => { stderr += value; });
      child.once('exit', (status) => { children.delete(child); resolve({ status, stdout, stderr }); });
    });
  const state = () => readDryadState('dryad-test', environment).state;
  const stateFile = path.join(stateDir, 'dryads', 'dryad-test.yml');
  const indexFile = path.join(stateDir, 'dryads', 'projects.yml');
  const groveStateFile = path.join(stateDir, 'dryad-test.yml');
  const seatPath = (id) => path.join(root, 'seats', id);

  t.after(async () => {
    for (const verb of ['create', 'attach', 'destroy']) for (const env of ['w1', 'w2', 'w3']) rmSync(gate(verb, env), { force: true });
    for (const child of children) child.kill('SIGTERM');
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
  return { root, baseline, head, environment, run, good, bad, state, stateFile, indexFile, groveStateFile, seatPath, images, gate, enter, launchOverlay };
}

test('dryad profile parser accepts the documented shape and rejects unknown keys and placeholders', () => {
  const ok = parseDryadProfile('version: 1\nworktrees:\n  root: ../seats\n  branch: "dryad/{id}"\n');
  assert.deepEqual(ok, { version: 1, project: null, worktrees: { root: '../seats', branch: 'dryad/{id}' } });
  assert.deepEqual(parseDryadProfile(''), { version: 1, project: null, worktrees: null });
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

test('a project without Grove carries its slug in the Dryad profile; with Grove the duplicate is rejected', (t) => {
  assert.deepEqual(parseDryadProfile('project: { slug: solo }\n'), { version: 1, project: { slug: 'solo' }, worktrees: null });
  assert.throws(() => parseDryadProfile('project: { slug: Solo Project }\n'), /DNS label/);
  assert.throws(() => parseDryadProfile('project: { slug: solo, namespace: x }\n'), /unknown key/);

  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dryad-solo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), 'project: { slug: solo }\nworktrees: { root: ../seats, branch: "dryad/{id}" }\n');
  writeFileSync(path.join(baseline, 'README.md'), 'solo\n');
  gitIn(baseline, ['init', '-b', 'main']); gitIn(baseline, ['add', '.']); gitIn(baseline, ['commit', '-m', 'solo']);
  const env = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete env.DRYAD_PROJECT;
  const run = (args) => spawnSync(process.execPath, [CLI, 'dryad', ...args, '--project', baseline], { env, encoding: 'utf8' });
  const planned = run(['plan', 'w1', '--task', 'solo work', '--apply']);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /env       none/);
  const status = run(['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /■ solo — seats 1/);
  assert.match(status.stdout, /envs       none \(overlay inactive\)/);
  assert.equal(run(['finish', 'w1', '--apply']).status, 0);

  writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), 'project: { slug: solo }\nservices: { api: {} }\noverlay: none\ndata: { infra: project }\n');
  const duplicate = run(['status']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /declared here and in/);
  t.diagnostic('Grove-less project: plan/status/finish 3/3; duplicate slug rejected 1/1');
});

test('the published example profile parses', () => {
  const example = readFileSync(path.join(HERE, '../../skills/dryad/examples/dryad-profile.yml'), 'utf8');
  assert.deepEqual(parseDryadProfile(example), { version: 1, project: null, worktrees: { root: '../acme-seats', branch: 'dryad/{id}' } });
});

test('dryad cli args enforce verb shapes', () => {
  assert.equal(parseDryadCliArgs([]).help, true);
  assert.throws(() => parseDryadCliArgs(['launch', 'w1']), /unknown command/);
  assert.throws(() => parseDryadCliArgs(['plan', 'w1']), /exactly one of --task or --task-file/);
  assert.throws(() => parseDryadCliArgs(['plan', 'w1', '--task', 'a', '--task-file', 'b']), /exactly one/);
  assert.throws(() => parseDryadCliArgs(['plan', 'W1', '--task', 'a']), /DNS label/);
  assert.throws(() => parseDryadCliArgs(['seat', 'w1', '--json', '--env']), /at most one/);
  assert.equal(parseDryadCliArgs(['seat', 'w1', '--task']).format, 'task');
  assert.equal(parseDryadCliArgs(['status', '--finished']).finished, true);
  assert.throws(() => parseDryadCliArgs(['finish', 'w1', '--finished']), /not valid for finish/);
  assert.throws(() => parseDryadCliArgs(['report', 'w1']), /requires --status/);
  assert.throws(() => parseDryadCliArgs(['report', 'w1', '--status', 'planned']), /--status must be one of/);
  assert.throws(() => parseDryadCliArgs(['finish', 'w1', '--force']), /not valid for finish/);
  assert.throws(() => parseDryadCliArgs(['status', 'w1', 'w2']), /at most 1/);
  const plan = parseDryadCliArgs(['plan', 'w1', '--task-file', 'tasks/w1.md', '--by', 'codex', '--apply']);
  assert.deepEqual([plan.verb, plan.id, plan.taskFile, plan.by, plan.apply], ['plan', 'w1', 'tasks/w1.md', 'codex', true]);
  assert.equal(parseDryadCliArgs(['seat', 'w1', '--shell']).format, 'shell');
  assert.equal(parseDryadCliArgs(['seat', 'w1']).format, 'text');
  assert.equal(parseDryadCliArgs(['projects', '--json']).json, true);
  assert.throws(() => parseDryadCliArgs(['projects', 'w1']), /no positional/);
  assert.throws(() => parseDryadCliArgs(['projects', '--project', 'x']), /not valid for projects/);
});

test('plan --apply records the baseline root in the machine index; finish leaves it alone; a moved root warns once', (t) => {
  const f = fixture(t);
  f.good(['plan', 'w1', '--task', 'first']);
  assert.equal(existsSync(f.indexFile), false, 'plan without --apply writes no index');
  f.good(['plan', 'w1', '--task', 'first', '--apply']);
  const { index } = readDryadProjectsIndex(f.environment);
  assert.equal(index.version, 1);
  assert.equal(index.projects['dryad-test'].root, f.baseline);
  assert.match(index.projects['dryad-test'].updated_at, /^\d{4}-\d{2}-\d{2}T/);
  const written = readFileSync(f.indexFile, 'utf8');
  f.good(['finish', 'w1', '--apply']);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(readFileSync(f.indexFile, 'utf8'), written, 'finish leaves the index untouched');

  writeFileSync(f.indexFile, stringify({ version: 1, projects: { 'dryad-test': { root: '/elsewhere/old', updated_at: '2026-01-01T00:00:00.000Z' } } }));
  const moved = f.good(['plan', 'w2', '--task', 'second', '--apply']);
  assert.equal((moved.stderr.match(/root moved from \/elsewhere\/old to /g) ?? []).length, 1, moved.stderr);
  assert.equal(readDryadProjectsIndex(f.environment).index.projects['dryad-test'].root, f.baseline);
  const again = f.good(['plan', 'w3', '--task', 'third', '--apply']);
  assert.doesNotMatch(again.stderr, /root moved/);
  t.diagnostic('index written on apply 1/1; untouched by finish 1/1; moved-root warning 1/1');
});

test('projects joins the index with live registries: two seats, then one finished; a missing index is projects 0', (t) => {
  const f = fixture(t);
  const empty = path.join(f.root, 'empty-state');
  const none = f.good(['projects'], { cwd: f.root, env: { GROVE_STATE_DIR: empty } });
  assert.match(none.stdout, /projects 0/);
  assert.deepEqual(JSON.parse(f.good(['projects', '--json'], { cwd: f.root, env: { GROVE_STATE_DIR: empty } }).stdout), { projects: [] });

  for (const id of ['w1', 'w2']) f.good(['plan', id, '--task', id, '--apply']);
  // projects is machine-wide: no dryad profile above f.root, no --project.
  const two = JSON.parse(f.good(['projects', '--json'], { cwd: f.root }).stdout).projects;
  assert.equal(two.length, 1);
  assert.equal(two[0].slug, 'dryad-test');
  assert.equal(two[0].root, f.baseline);
  assert.deepEqual([two[0].root_present, two[0].seats, two[0].finished, two[0].overlay], [true, 2, 0, false]);
  assert.match(two[0].updated_at, /^\d{4}-/);
  assert.match(f.good(['projects'], { cwd: f.root }).stdout, /dryad-test  .*  present  seats 2  finished 0  overlay off/);

  f.good(['finish', 'w1', '--apply']);
  const one = JSON.parse(f.good(['projects', '--json'], { cwd: f.root }).stdout).projects[0];
  assert.deepEqual([one.seats, one.finished], [1, 1]);
  assert.match(f.good(['projects'], { cwd: f.root }).stdout, /projects 1\n.*seats 1  finished 1/);

  writeFileSync(f.indexFile, stringify({ version: 1, projects: { 'dryad-test': { root: path.join(f.root, 'gone'), updated_at: '2026-01-01T00:00:00.000Z' } } }));
  const gone = JSON.parse(f.good(['projects', '--json'], { cwd: f.root }).stdout).projects[0];
  assert.deepEqual([gone.root_present, gone.seats, gone.finished], [false, 1, 1]);
  assert.match(f.good(['projects'], { cwd: f.root }).stdout, /missing  seats 1/);
  t.diagnostic('missing index 2/2; two seats counted 1/1; one finished counted 1/1; missing root flagged 1/1');
});

test('status --json marks each seat\'s overlay hostnames attached or not; without overlays the list is empty', (t) => {
  const f = fixture(t, { overlay: true });
  f.good(['plan', 'w1', '--task', 'named seat', '--apply']);
  // The env exists but holds no service: a hostname is rendered for every
  // service of the project, and none of them answers yet.
  const seated = JSON.parse(f.good(['status', '--json']).stdout);
  assert.deepEqual(seated.seats[0].hostnames, [{ host: 'api--w1.dryad-test.localhost', service: 'api', attached: false }]);
  assert.equal(JSON.parse(f.good(['projects', '--json'], { cwd: f.root }).stdout).projects[0].overlay, true);

  const attach = spawnSync(process.execPath, [CLI, 'overlay', 'attach', 'w1', 'api', '--image', f.images[0], '--apply', '--project', f.baseline], { cwd: f.seatPath('w1'), env: f.environment, encoding: 'utf8', timeout: 20000 });
  assert.equal(attach.status, 0, attach.stderr);
  const live = JSON.parse(f.good(['status', '--json']).stdout);
  assert.deepEqual(live.seats[0].hostnames, [{ host: 'api--w1.dryad-test.localhost', service: 'api', attached: true }]);

  // A pending env has no hostnames yet.
  f.bad(['plan', 'w2', '--task', 'pending', '--apply'], { env: { GROVE_PROCESS_TEST_ROOT: path.join(f.root, 'missing') } });
  const pending = JSON.parse(f.bad(['status', '--json']).stdout);
  assert.deepEqual(pending.seats.find((seat) => seat.id === 'w2').hostnames, []);
  assert.deepEqual(pending.seats.find((seat) => seat.id === 'w1').hostnames, [{ host: 'api--w1.dryad-test.localhost', service: 'api', attached: true }]);

  const plain = fixture(t);
  plain.good(['plan', 'w1', '--task', 'no grove overlay', '--apply']);
  assert.deepEqual(JSON.parse(plain.good(['status', '--json']).stdout).seats[0].hostnames, []);
  t.diagnostic('hostnames unattached 1/1; attached after attach 1/1; pending empty 1/1; without overlay empty 1/1');
});

test('a seat journals the state-changing catalog verbs it runs with their exit code, and never a read verb', (t) => {
  const f = fixture(t, { overlay: true });
  f.good(['plan', 'w1', '--task', 'journal what I ran', '--apply']);
  const seatEnv = { ...f.environment, DRYAD_ID: 'w1', DRYAD_PROJECT: f.baseline };
  const catalog = (args, { cwd = f.seatPath('w1'), env = seatEnv } = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
  const events = () => f.state().seats.w1.journal.filter((entry) => entry.event === 'cli');

  const attached = catalog(['overlay', 'attach', 'w1', 'api', '--image', f.images[0], '--apply', '--project', f.baseline]);
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(events().length, 1);
  assert.deepEqual([events()[0].actor, events()[0].exit], ['seat', 0]);
  assert.equal(events()[0].detail, `overlay attach w1 api --image ${f.images[0]} --apply --project ${f.baseline}`);

  // Read verbs stay out: a dashboard polling status must not bury the journal.
  assert.equal(catalog(['overlay', 'status', '--json', '--project', f.baseline]).status, 0);
  assert.equal(catalog(['urls', f.baseline, '--env', 'w1', '--json']).status, 0);
  assert.equal(catalog(['validate', f.baseline]).status, 0);
  catalog(['dryad', 'status', '--json', '--project', f.baseline]);
  catalog(['dryad', 'seat', 'w1', '--json', '--project', f.baseline]);
  assert.equal(events().length, 1, 'overlay status, urls, validate, dryad status and dryad seat record nothing');
  // report writes its own event; it must not be doubled by a cli one.
  f.good(['report', 'w1', '--status', 'working', '--note', 'measuring'], { cwd: f.seatPath('w1'), env: seatEnv });
  assert.equal(events().length, 1);
  assert.equal(f.state().seats.w1.journal.at(-1).event, 'report');

  // A failed command is what the seat tried: it is recorded with its exit
  // code, and the passthrough after -- is kept as a digest, never as text.
  const failed = catalog(['overlay', 'attach', 'w1', 'api', '--image', 'not-a-digest', '--apply', '--project', f.baseline, '--', 'project-secret']);
  assert.notEqual(failed.status, 0);
  const last = events().at(-1);
  assert.equal(events().length, 2);
  assert.equal(last.exit, 1);
  assert.doesNotMatch(last.detail, /project-secret/);
  assert.equal(
    last.detail,
    `overlay attach w1 api --image not-a-digest --apply --project ${f.baseline} -- sha256:${createHash('sha256').update(JSON.stringify(['project-secret'])).digest('hex')}`
  );
  assert.match(f.good(['status', 'w1']).stdout, /cli +overlay attach w1 api/);

  // A seat that is already finished records nothing and fails nothing.
  f.good(['finish', 'w1', '--apply']);
  const orphan = catalog(['overlay', 'create', 'w2', '--apply', '--project', f.baseline], { cwd: f.baseline });
  assert.equal(orphan.status, 0, orphan.stderr);
  const archived = readDryadFinished('dryad-test', f.environment).seats[0];
  assert.equal(archived.journal.filter((entry) => entry.event === 'cli').length, 2);
  t.diagnostic('cli events recorded 2/2 (exit 0 and 1); read verbs recorded 0/5; passthrough digested 1/1; finished seat skipped 1/1');
});

test('status --json counts what each seat changed, truncates the lists at 200, and is null without a worktree', (t) => {
  const f = fixture(t);
  f.good(['plan', 'w1', '--task', 'change files', '--apply']);
  const w1 = f.seatPath('w1');
  writeFileSync(path.join(w1, 'app.txt'), 'seat edit\n');
  gitIn(w1, ['commit', '-am', 'edit the baseline file']);
  writeFileSync(path.join(w1, 'added.txt'), 'new\n');
  gitIn(w1, ['add', 'added.txt']);
  gitIn(w1, ['commit', '-m', 'add a file']);
  writeFileSync(path.join(w1, 'open.txt'), 'not committed\n');

  const seat = JSON.parse(f.good(['status', '--json']).stdout).seats[0];
  assert.equal(seat.changes.base, f.head);
  assert.deepEqual(seat.changes.counts, { committed: 2, uncommitted: 1, ahead: 2 });
  assert.deepEqual(seat.changes.committed.map((row) => row.path).sort(), ['added.txt', 'app.txt']);
  assert.deepEqual(seat.changes.committed.find((row) => row.path === 'app.txt'), { path: 'app.txt', status: 'M' });
  assert.deepEqual(seat.changes.uncommitted, [{ path: 'open.txt', status: '??' }]);
  assert.equal(seat.changes.truncated, false);
  assert.equal(seat.ahead, 2, 'ahead still reports the commits on top of the base');

  mkdirSync(path.join(w1, 'bulk'));
  for (let index = 0; index < 205; index += 1) writeFileSync(path.join(w1, 'bulk', `f${index}.txt`), `${index}\n`);
  gitIn(w1, ['add', 'bulk']);
  gitIn(w1, ['commit', '-m', 'bulk']);
  const big = JSON.parse(f.good(['status', '--json']).stdout).seats[0];
  assert.deepEqual(big.changes.counts, { committed: 207, uncommitted: 1, ahead: 3 });
  assert.equal(big.changes.committed.length, 200, 'the list is capped; the count is whole');
  assert.equal(big.changes.uncommitted.length, 1);
  assert.equal(big.changes.truncated, true);

  rmSync(w1, { recursive: true, force: true });
  const missing = JSON.parse(f.bad(['status', '--json']).stdout).seats[0];
  assert.equal(missing.changes, null);
  assert.equal(missing.ahead, null);
  t.diagnostic('committed 2/2; uncommitted 1/1; ahead 2; truncated at 200 of 207; missing worktree null 1/1');
});

test('status lists every worktree of the baseline repository; one nobody seated has seat null', (t) => {
  const f = fixture(t);
  f.good(['plan', 'w1', '--task', 'seated work', '--apply']);
  const unseated = path.join(f.root, 'launcher-made');
  gitIn(f.baseline, ['worktree', 'add', '-b', 'feature/x', unseated]);

  const report = JSON.parse(f.good(['status', '--json']).stdout);
  assert.equal(report.worktrees.length, 3);
  const baseline = report.worktrees.find((row) => row.baseline);
  assert.deepEqual([baseline.path, baseline.branch, baseline.seat], [f.baseline, 'main', null]);
  assert.equal(baseline.head, f.head);
  const seated = report.worktrees.find((row) => row.seat === 'w1');
  assert.deepEqual([seated.path, seated.branch, seated.baseline], [f.seatPath('w1'), 'dryad/w1', false]);
  const stray = report.worktrees.find((row) => !row.baseline && row.seat == null);
  assert.deepEqual([stray.path, stray.branch], [realpathSync(unseated), 'feature/x']);
  assert.equal(stray.head.length, 40);
  assert.equal(report.seats.length, 1, 'changes are computed for seats only, not for other people\'s worktrees');
  assert.match(f.good(['status']).stdout, /worktrees  3 \(1 unseated\)/);
  t.diagnostic('worktrees listed 3/3; seated 1/1; unseated 1/1; baseline flagged 1/1');
});

test('two seats holding one path are one overlap and do not change the exit code', (t) => {
  const f = fixture(t);
  for (const id of ['w1', 'w2']) f.good(['plan', id, '--task', `${id} work`, '--apply']);
  writeFileSync(path.join(f.seatPath('w1'), 'app.txt'), 'w1 edit\n');
  gitIn(f.seatPath('w1'), ['commit', '-am', 'w1 edits the shared file']);
  writeFileSync(path.join(f.seatPath('w2'), 'app.txt'), 'w2 edit\n');
  writeFileSync(path.join(f.seatPath('w2'), 'solo.txt'), 'only w2 has this\n');

  // f.good asserts exit 0: an overlap is a fact, not a problem.
  const text = f.good(['status']);
  assert.match(text.stdout, /overlaps   1/);
  assert.match(text.stdout, /overlap  app\.txt  w1 · w2/);
  const report = JSON.parse(f.good(['status', '--json']).stdout);
  assert.deepEqual(report.overlaps, [{ path: 'app.txt', seats: ['w1', 'w2'] }]);
  assert.deepEqual(report.problems, []);
  t.diagnostic('overlap of one committed and one uncommitted change 1/1; unshared path not counted 1/1; exit 0');
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
  const eventsFile = path.join(f.root, 'state/dryads/events', 'dryad-test', 'w1.events');
  assert.deepEqual(json.env_vars, { DRYAD_ID: 'w1', DRYAD_ENV: '', DRYAD_BRANCH: 'dryad/w1', DRYAD_PROJECT: f.baseline, DRYAD_SKILL: SKILL, DRYAD_EVENTS: eventsFile, DRYAD_EVIDENCE: path.join(path.dirname(eventsFile), 'w1.evidence.yml'), DRYAD_CLAUDE_SETTINGS: path.join(path.dirname(eventsFile), 'w1.claude-settings.json') });
  assert.equal(json.evidence_file, json.env_vars.DRYAD_EVIDENCE);
  // plan --apply laid the events file and the Claude settings that append to it; status reads them back as activity.
  assert.equal(existsSync(eventsFile), true, 'events file laid by plan');
  const settings = JSON.parse(readFileSync(json.env_vars.DRYAD_CLAUDE_SETTINGS, 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /cat >> /);
  assert.equal(JSON.parse(f.good(['status', '--json']).stdout).seats[0].activity, null, 'no session has written yet');
  writeFileSync(eventsFile, '{"hook_event_name":"UserPromptSubmit"}\n{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/x.ts"}}\n');
  const activity = JSON.parse(f.good(['status', '--json']).stdout).seats[0].activity;
  assert.equal(activity.state, 'running');
  assert.equal(activity.doing, 'Edit src/x.ts');
  assert.match(activity.changed_at, /^\d{4}-/);
  assert.match(f.good(['status']).stdout, /w1 .*· now Edit src\/x\.ts/);
  // diff: the seat's whole difference from its base, as a patch, plus untracked files.
  const empty = JSON.parse(f.good(['diff', 'w1', '--json']).stdout);
  assert.equal(empty.patch, '');
  assert.deepEqual(empty.untracked, []);
  assert.equal(empty.base, json.base);
  // Change a file the base tracks, and add one it does not.
  const tracked = spawnSync('git', ['ls-files'], { cwd: f.seatPath('w1'), encoding: 'utf8' }).stdout.split('\n').filter(Boolean)[0];
  writeFileSync(path.join(f.seatPath('w1'), tracked), readFileSync(path.join(f.seatPath('w1'), tracked), 'utf8') + 'refunds\n');
  writeFileSync(path.join(f.seatPath('w1'), 'new.txt'), 'untracked\n');
  const diff = JSON.parse(f.good(['diff', 'w1', '--json']).stdout);
  assert.match(diff.patch, new RegExp(`^diff --git a/${tracked.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} b/`, 'm'));
  assert.match(diff.patch, /^\+refunds$/m);
  assert.deepEqual(diff.untracked, ['new.txt']);
  assert.equal(diff.truncated, false);
  assert.match(f.good(['diff', 'w1']).stdout, /\+refunds[\s\S]*untracked: new\.txt/);
  assert.throws(() => parseDryadCliArgs(['diff']), /diff requires a seat id/);
  // Leave the seat as finish expects it: clean.
  spawnSync('git', ['checkout', '--', tracked], { cwd: f.seatPath('w1'), encoding: 'utf8' });
  rmSync(path.join(f.seatPath('w1'), 'new.txt'));
  assert.equal(JSON.parse(f.good(['diff', 'w1', '--json']).stdout).patch, '');
  assert.equal(json.task, 'add refund endpoint');
  assert.equal(existsSync(json.skill), true, 'the seat points at a skill file that exists');
  assert.equal(f.good(['seat', 'w1', '--task']).stdout, 'add refund endpoint\n');
  const envLines = f.good(['seat', 'w1', '--env']).stdout.trim().split('\n');
  assert.equal(envLines.length, 8);
  assert.ok(envLines.includes('DRYAD_ID=w1'));

  // The launcher boundary: the --shell line, executed by a real shell, lands
  // a process in the worktree with the seat's environment.
  const shellLine = f.good(['seat', 'w1', '--shell']).stdout.trim();
  const probe = spawnSync('sh', ['-c', `${shellLine} && pwd && env | grep '^DRYAD_' | sort`], { encoding: 'utf8', env: f.environment });
  assert.equal(probe.status, 0, probe.stderr);
  const probeLines = probe.stdout.trim().split('\n');
  assert.equal(realpathSync(probeLines[0]), f.seatPath('w1'));
  assert.deepEqual(probeLines.slice(1), ['DRYAD_BRANCH=dryad/w1', `DRYAD_CLAUDE_SETTINGS=${json.env_vars.DRYAD_CLAUDE_SETTINGS}`, 'DRYAD_ENV=', `DRYAD_EVENTS=${eventsFile}`, `DRYAD_EVIDENCE=${json.env_vars.DRYAD_EVIDENCE}`, 'DRYAD_ID=w1', `DRYAD_PROJECT=${f.baseline}`, `DRYAD_SKILL=${SKILL}`]);

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
  const doneWithoutSession = f.good(['report', 'w1', '--status', 'working']);
  assert.doesNotMatch(doneWithoutSession.stderr, /session/);
  f.good(['report', 'w1', '--status', 'done']);
  const clean = f.good(['status', 'w1']);
  assert.match(clean.stdout, /reported   done 1/);
  // One line more than the reports and finish steps alone: Dryad's result line beside the done report.
  assert.equal((clean.stdout.match(/\n  \d{4}-\d{2}-\d{2}T/g) ?? []).length, 6, 'status <id> prints the journal');
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

  // The journal outlives the seat: finish archives it for a later audit.
  const archived = readDryadFinished('dryad-test', f.environment).seats;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, 'w1');
  assert.equal(archived[0].journal.at(-1).event, 'finish');
  const finishedReport = f.good(['status', 'w1', '--finished']);
  assert.match(finishedReport.stdout, /finished seats 1/);
  assert.match(finishedReport.stdout, /report +blocked: mock schema differs/);
  assert.equal(JSON.parse(f.good(['status', '--finished', '--json']).stdout).finished.length, 1);
  t.diagnostic('seat formats 4/4; reports 4/4; dirty finish refused 1/1; clean finish removed 1/1; branch kept 1/1; archived journals 1/1');
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
  const noSession = f.good(['report', 'w2', '--status', 'done']);
  assert.match(noSession.stderr, /no session reference/);
  const withSession = f.good(['report', 'w2', '--status', 'done', '--session', 'codex-thread-1']);
  assert.doesNotMatch(withSession.stderr, /no session reference/);
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

test('two seats attach concurrently; an in-flight attach is not a problem for status, a stalled one is', async (t) => {
  const f = fixture(t, { overlay: true });
  for (const id of ['w1', 'w2']) f.good(['plan', id, '--task', id, '--apply']);
  const worker = (id) => ({ cwd: f.seatPath(id), env: { DRYAD_PROJECT: f.baseline } });

  writeFileSync(f.gate('attach', 'w1'), 'hold w1 mid-attach');
  const held = f.launchOverlay(['attach', 'w1', 'api', '--image', f.images[0], '--apply'], f.seatPath('w1'));
  await f.enter('attach', 'w1');
  const other = await f.launchOverlay(['attach', 'w2', 'api', '--image', f.images[1], '--apply'], f.seatPath('w2'));
  assert.equal(other.status, 0, other.stderr);
  const during = f.good(['status'], worker('w2'));
  assert.match(during.stdout, /envs       2\/2 tracked, 1 in-flight/);
  assert.match(during.stdout, /env w1 in-flight/);
  assert.match(during.stdout, /env w2 tracked/);
  const duringJson = JSON.parse(f.good(['status', '--json'], worker('w2')).stdout);
  assert.deepEqual(duringJson.problems, []);
  rmSync(f.gate('attach', 'w1'));
  const released = await held;
  assert.equal(released.status, 0, released.stderr);
  const after = f.good(['status']);
  assert.match(after.stdout, /envs       2\/2 tracked$/m);
  const grove = parse(readFileSync(f.groveStateFile, 'utf8'));
  assert.equal(grove.envs.w1.services.api.image, f.images[0]);
  assert.equal(grove.envs.w2.services.api.image, f.images[1]);

  const fault = path.join(f.root, 'fail-attach-w2');
  writeFileSync(fault, 'interrupt after mutation');
  const broken = await f.launchOverlay(['attach', 'w2', 'api', '--image', f.images[0], '--apply'], f.seatPath('w2'));
  assert.notEqual(broken.status, 0);
  const stalled = f.bad(['status']);
  assert.match(stalled.stdout, /problem  overlay pending stalled: attach w2\/api; rerun it with --apply/);
  rmSync(fault);
  const recovered = await f.launchOverlay(['attach', 'w2', 'api', '--image', f.images[0], '--apply'], f.seatPath('w2'));
  assert.equal(recovered.status, 0, recovered.stderr);
  f.good(['status']);

  for (const id of ['w1', 'w2']) f.good(['finish', id, '--apply']);
  assert.equal(existsSync(f.stateFile), false);
  t.diagnostic('concurrent attaches 2/2; in-flight tolerated 1/1; stalled flagged 1/1; recovered 1/1; finished 2/2');
});

// The worker side of the seat contract, without any agent tool: a scripted
// worker is launched exactly the way a launcher would launch an agent (the
// --shell line, then the program), and must find its seat, the skill, and
// the task through DRYAD_* alone, then report its own completion.
test('a scripted worker seated through --shell reads seat, skill and task, commits on its branch, and reports done', (t) => {
  const f = fixture(t);
  const worker = path.join(HERE, 'fixtures/dryad-worker.mjs');
  f.good(['plan', 'w1', '--task', 'write the work note', '--by', 'worker', '--apply']);
  const shellLine = f.good(['seat', 'w1', '--shell']).stdout.trim();
  const run = spawnSync('sh', ['-c', `${shellLine} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(worker)}`], {
    encoding: 'utf8',
    env: { ...f.environment, DRYAD_TEST_CLI: CLI },
    cwd: f.root, // deliberately not the worktree: the --shell line must move the worker there
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(out.branch, 'dryad/w1');
  assert.equal(gitIn(f.seatPath('w1'), ['rev-parse', 'HEAD']), out.head);
  assert.equal(gitIn(f.seatPath('w1'), ['status', '--porcelain']), '', 'worker left its worktree clean');
  assert.equal(gitIn(f.baseline, ['rev-parse', 'HEAD']), f.head, 'baseline untouched');
  assert.equal(readFileSync(path.join(f.seatPath('w1'), 'WORK.md'), 'utf8'), 'seat w1 on dryad/w1: write the work note\n');
  const seat = f.state().seats.w1;
  assert.equal(seat.status, 'done');
  assert.match(seat.session, /^worker-\d+$/);
  // The done report is the worker's line; the git facts of its result are Dryad's line beside it.
  assert.deepEqual(seat.journal.map((entry) => entry.event), ['plan', 'report', 'report', 'result']);
  assert.deepEqual({ head: seat.result.head, clean: seat.result.clean, scope_checked: seat.result.scope_checked }, { head: out.head, clean: true, scope_checked: false });
  const status = f.good(['status']);
  assert.match(status.stdout, /reported   done 1/);
  assert.match(status.stdout, /\+1/);
  t.diagnostic('scripted worker: seat+skill+task read 3/3; commit on own branch 1/1; baseline untouched 1/1; done with session 1/1');
});

test('with create_on: attach, plan creates no env, status shows unattached without a problem, and the seat attach creates it', (t) => {
  const f = fixture(t, { overlay: true, createOn: 'attach' });
  const groveRegistry = () => (existsSync(f.groveStateFile) ? parse(readFileSync(f.groveStateFile, 'utf8')) : null);
  const planned = f.good(['plan', 'w1', '--task', 'deferred env', '--apply']);
  assert.match(planned.stdout, /env       1\/1 w1/);
  assert.equal(groveRegistry(), null, 'no overlay create at plan');
  assert.match(f.state().seats.w1.journal[0].detail, /create_on: attach/);
  const before = f.good(['status']);
  assert.match(before.stdout, /env w1 unattached/);
  assert.doesNotMatch(before.stdout, /problem/);
  const attach = spawnSync(process.execPath, [CLI, 'overlay', 'attach', 'w1', 'api', '--image', f.images[0], '--apply', '--project', f.baseline], { cwd: f.seatPath('w1'), env: f.environment, encoding: 'utf8' });
  assert.equal(attach.status, 0, attach.stderr);
  assert.match(attach.stdout, /create_on: attach/);
  assert.equal(groveRegistry().envs.w1.worktree, f.seatPath('w1'), 'the env is owned by the seat worktree, not the baseline');
  const after = f.good(['status']);
  assert.match(after.stdout, /env w1 tracked/);
  f.good(['finish', 'w1', '--apply']);
  t.diagnostic('deferred create: plan 0 creates, unattached tolerated 1/1, first attach created 1/1 from the seat worktree');
});
