// Mycelium's commit policy is stated, not hidden: a project without judges
// is permissive and says so; one that declares restricted must name its
// judges; and a fact can name the commit it was true at, so a reader tells
// a fact the baseline holds from one it has moved past.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { describeMode, makeAssertion, parseMyceliumValues } from '../lib/mycelium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const VALUES = { version: 1, domains: ['auth'], types: ['issue', 'seat'], predicates: { 'caused-by': 'one' } };

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Policy Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A baseline repository with Dryad and Mycelium values, so a seat can be
// planned, commit, report done, and be proposed as a fact with its head.
function fixture(t, values = VALUES) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mycelium-policy-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, project: { slug: 'policy-test' }, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/mycelium.yml'), stringify(values));
  writeFileSync(path.join(baseline, 'app.txt'), 'baseline\n');
  gitIn(baseline, ['init', '-b', 'main']);
  gitIn(baseline, ['add', '.']);
  gitIn(baseline, ['commit', '-m', 'baseline']);
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args, '--project', baseline], { cwd: baseline, encoding: 'utf8', env: { ...environment, ...env } });
  const good = (args, env) => { const r = run(args, env); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
  const json = (args, env) => JSON.parse(good([...args, '--json'], env).stdout);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, baseline, environment, run, good, json, seat: (id) => path.join(root, 'seats', id) };
}

test('the commit mode is implied by judges, may be declared, and a declaration that contradicts the judges is refused', () => {
  const permissive = parseMyceliumValues(stringify(VALUES));
  assert.deepEqual({ mode: permissive.mode, declared: permissive.mode_declared }, { mode: 'permissive', declared: false });
  assert.match(describeMode(permissive), /^permissive \(no judges declared\): any named writer may commit/);
  const restricted = parseMyceliumValues(stringify({ ...VALUES, judges: ['human:jane'] }));
  assert.deepEqual({ mode: restricted.mode, declared: restricted.mode_declared }, { mode: 'restricted', declared: false });
  const declared = parseMyceliumValues(stringify({ ...VALUES, judges: ['human:jane'], mode: 'restricted' }));
  assert.deepEqual({ mode: declared.mode, declared: declared.mode_declared }, { mode: 'restricted', declared: true });
  assert.match(describeMode(declared), /^restricted \(declared\): only human:jane/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, mode: 'restricted' })), /mode: restricted needs judges/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, judges: ['human:jane'], mode: 'permissive' })), /mode: permissive contradicts judges/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, mode: 'open' })), /mode must be one of permissive, restricted/);
  // A ref is a full sha and nothing else is typed into it.
  const withRef = makeAssertion({ s: 'issue-1', p: 'caused-by', o: 'x', s_type: 'issue', domain: 'auth', source: 'f:1', agent_id: 'human:a', ref: { commit: 'a'.repeat(40), verified: true } }, permissive);
  assert.deepEqual(withRef.ref, { commit: 'a'.repeat(40), verified: true });
  assert.throws(() => makeAssertion({ s: 'issue-1', p: 'caused-by', o: 'x', s_type: 'issue', domain: 'auth', source: 'f:1', agent_id: 'human:a', ref: { commit: 'abc' } }, permissive), /ref\.commit must be a full commit sha/);
});

test('permissive: any named writer commits and status says so; restricted: a worker is refused and a judge commits', (t) => {
  const open = fixture(t);
  assert.match(open.good(['mycelium', 'status']).stdout, /mode      permissive \(no judges declared\)/);
  const fact = open.json(['mycelium', 'propose', '--s', 'issue-1', '--p', 'caused-by', '--o', 'cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:1', '--by', 'agent:worker']);
  assert.equal(open.good(['mycelium', 'commit', fact.id, '--by', 'agent:worker']).status, 0);
  assert.match(JSON.parse(open.good(['mycelium', 'status', '--json']).stdout).values.mode, /permissive/);

  const closed = fixture(t, { ...VALUES, judges: ['human:jane'], mode: 'restricted' });
  assert.match(closed.good(['mycelium', 'status']).stdout, /mode      restricted \(declared\): only human:jane/);
  const proposed = closed.json(['mycelium', 'propose', '--s', 'issue-1', '--p', 'caused-by', '--o', 'cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:1', '--by', 'agent:worker']);
  const refused = closed.run(['mycelium', 'commit', proposed.id, '--by', 'agent:worker']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /agent:worker is not a judge/);
  assert.equal(closed.good(['mycelium', 'commit', proposed.id, '--by', 'human:jane']).status, 0);
});

test('a fact from a seat names the seat\'s own head; query says whether the baseline holds it yet', (t) => {
  const f = fixture(t);
  f.good(['dryad', 'plan', 'w1', '--task', 'find the cause', '--apply']);
  const seat = f.seat('w1');
  writeFileSync(path.join(seat, 'cause.txt'), 'stale cache\n');
  gitIn(seat, ['add', '.']);
  gitIn(seat, ['commit', '-m', 'cause']);
  const head = gitIn(seat, ['rev-parse', 'HEAD']);
  const evidence = path.join(f.root, 'evidence.yml');
  writeFileSync(evidence, stringify({ checks: [{ command: 'npm test', exit: 0, observed: '3/3' }] }));
  f.good(['dryad', 'report', 'w1', '--status', 'done', '--note', 'cause found', '--evidence', evidence]);
  const fact = f.json(['mycelium', 'propose', '--from-seat', 'w1', '--s-type', 'seat', '--domain', 'auth', '--by', 'human:jane']);
  assert.deepEqual(fact.ref, { commit: head, seat: 'w1', attempt: 1, base: gitIn(f.baseline, ['rev-parse', 'HEAD']), verified: true });
  assert.match(f.run(['mycelium', 'propose', '--from-seat', 'w1', '--s-type', 'seat', '--domain', 'auth', '--by', 'human:jane', '--ref-commit', head]).stderr, /--from-seat sets --ref-commit/);

  let rows = f.json(['mycelium', 'query', '--status', 'staging']);
  assert.equal(rows[0].ref_state, 'not-in-baseline');
  assert.match(f.good(['mycelium', 'query', '--status', 'staging']).stdout, new RegExp(`@${head.slice(0, 12)} \\(not in baseline\\)`));
  gitIn(f.baseline, ['merge', '--ff-only', 'dryad/w1']);
  rows = f.json(['mycelium', 'query', '--status', 'staging']);
  assert.equal(rows[0].ref_state, 'in-baseline');
  assert.doesNotMatch(f.good(['mycelium', 'query', '--status', 'staging']).stdout, /not in baseline/);

  // A hand proposal names its commit too; a fact without one has no state.
  const byHand = f.json(['mycelium', 'propose', '--s', 'issue-2', '--p', 'caused-by', '--o', 'y', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:2', '--by', 'human:jane', '--ref-commit', head]);
  assert.equal(byHand.ref.commit, head);
  const bare = f.json(['mycelium', 'propose', '--s', 'issue-3', '--p', 'caused-by', '--o', 'z', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:3', '--by', 'human:jane']);
  const states = Object.fromEntries(f.json(['mycelium', 'query', '--status', 'staging']).map((row) => [row.id, row.ref_state]));
  assert.equal(states[byHand.id], 'in-baseline');
  assert.equal(states[bare.id], null);
  assert.match(f.run(['mycelium', 'propose', '--s', 'issue-4', '--p', 'caused-by', '--o', 'z', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:3', '--by', 'human:jane', '--ref-commit', 'abc']).stderr, /ref\.commit must be a full commit sha/);
});
