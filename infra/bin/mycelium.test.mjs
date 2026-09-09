import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import {
  amendment,
  assertJudge,
  brief,
  commit,
  commitPlan,
  counts,
  foldLog,
  invalidate,
  makeAssertion,
  parseMyceliumCliArgs,
  parseMyceliumValues,
  propose,
  proposeAmendment,
  query,
  readLog,
  seatAt,
  seatDoneReport,
  seatReport,
  trace,
} from '../lib/mycelium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const PREDICATES = { 'caused-by': 'one', 'done-when': 'one', 'depends-on': 'many', b: 'one' };
const VALUES = { version: 1, domains: ['sprint', 'auth'], types: ['issue', 'decision', 'check', 'seat'], predicates: PREDICATES };
// What the CLI sees after parsing: reported is added as a built-in predicate.
const PARSED = parseMyceliumValues(stringify(VALUES));

// A disposable baseline with a Dryad profile that carries its own slug (no
// Grove profile, as this catalog itself does), a vocabulary, and its own
// state root. Nothing is seated; the log is the thing under test.
function fixture(t, { values = VALUES } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mycelium-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, project: { slug: 'mycelium-test' }, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/mycelium.yml'), stringify(values));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, 'mycelium', ...args], { cwd: baseline, encoding: 'utf8', env: { ...environment, ...env } });
  const json = (args, env = {}) => {
    const result = run([...args, '--json'], env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, baseline, environment, run, json, log: path.join(root, 'state/mycelium/mycelium-test.jsonl') };
}

function fact(overrides = {}) {
  return makeAssertion({ s: 'issue-12', p: 'caused-by', o: 'stale cache', s_type: 'issue', domain: 'auth', source: 'src/auth/cache.ts:40', agent_id: 'seat:a', ...overrides }, PARSED);
}

// -------------------------------------------------------------- values

test('the values file is a whitelist: unknown keys, empty lists, and bad tokens are refused', () => {
  const ok = parseMyceliumValues(stringify(VALUES));
  assert.deepEqual(ok.domains, ['sprint', 'auth']);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, judge: 'fable' })), /unknown key "judge"/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, version: 2 })), /version must be 1/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, domains: [] })), /domains must be a non-empty list/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, types: ['Issue'] })), /types entry "Issue" must be a lower-case token/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, types: ['issue', 'issue'] })), /types has a duplicate/);
  // judges are optional; when named they are writer ids, and only they may commit.
  assert.equal(ok.judges, null);
  const judged = parseMyceliumValues(stringify({ ...VALUES, judges: ['human:jane', 'agent:judge'] }));
  assert.deepEqual(judged.judges, ['human:jane', 'agent:judge']);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, judges: [] })), /judges must be a non-empty list/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, judges: ['Jane Doe'] })), /judges entry "Jane Doe" must be a writer id/);
  assert.equal(assertJudge(ok, 'seat:anyone'), 'seat:anyone');
  assert.equal(assertJudge(judged, 'human:jane'), 'human:jane');
  assert.throws(() => assertJudge(judged, 'seat:w1'), /seat:w1 is not a judge of this project \(judges: human:jane, agent:judge\)/);
  // predicates: a required map of name → one|many; reported is built in.
  assert.equal(ok.predicates['depends-on'], 'many');
  assert.equal(ok.predicates.reported, 'many');
  const { predicates, ...noPredicates } = VALUES;
  assert.throws(() => parseMyceliumValues(stringify(noPredicates)), /predicates must be a non-empty map of name: one\|many/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, predicates: {} })), /predicates must be a non-empty map/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, predicates: ['caused-by'] })), /predicates must be a non-empty map/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, predicates: { 'Caused-By': 'one' } })), /predicate "Caused-By" must be a lower-case token/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, predicates: { 'caused-by': 'single' } })), /predicate caused-by must be one or many, got "single"/);
  assert.throws(() => parseMyceliumValues(stringify({ ...VALUES, predicates: { reported: 'one' } })), /predicate "reported" is built in \(many\) and may not be redeclared/);
});

// ------------------------------------------------------------ envelope

test('an assertion needs subject, predicate, object, a declared type and domain, a source and an agent', () => {
  const row = fact();
  assert.match(row.id, /^a-[0-9a-f]{10}$/);
  assert.equal(row.status, 'staging');
  assert.equal(row.confidence, 0.5);
  assert.equal(row.valid_from, row.tx_at);
  assert.equal(row.valid_to, null);
  assert.equal(row.o_type, null);
  for (const name of ['s', 'p', 'o', 's_type', 'domain', 'source', 'agent_id']) {
    assert.throws(() => fact({ [name]: null }), new RegExp(`${name} is required`), name);
  }
  assert.throws(() => fact({ p: 'caused_by' }), /predicate "caused_by" is not in \.agents\/mycelium\.yml predicates \(caused-by, done-when, depends-on, b, reported\)/);
  assert.throws(() => fact({ s_type: 'module' }), /s_type "module" is not in \.agents\/mycelium\.yml types/);
  assert.throws(() => fact({ o_type: 'module' }), /o_type "module" is not in/);
  assert.throws(() => fact({ domain: 'payments' }), /domain "payments" is not in \.agents\/mycelium\.yml domains/);
  assert.throws(() => fact({ confidence: 1.5 }), /confidence must be a number from 0 to 1/);
  assert.throws(() => fact({ confidence: 'high' }), /confidence must be a number from 0 to 1/);
  assert.throws(() => fact({ valid_from: 'yesterday' }), /valid_from must be an ISO-8601 date-time/);
  assert.equal(fact({ valid_from: '2026-09-01T00:00:00Z' }).valid_from, '2026-09-01T00:00:00.000Z');
  assert.equal(fact({ confidence: '0.9' }).confidence, 0.9);
  assert.throws(() => fact({ agent_id: 'Jane Doe' }), /writer "Jane Doe" must be a short id/);
  assert.equal(fact().amends, null);
});

test('an amendment copies the original, changes only what was passed, and names what it amends', () => {
  const original = fact({ confidence: 0.4, valid_from: '2026-09-01T00:00:00Z' });
  const graph = new Map([[original.id, original]]);
  const fixed = amendment(graph, original.id, { o: 'stale session cache', agent_id: 'human:jane' }, PARSED);
  assert.notEqual(fixed.id, original.id);
  assert.equal(fixed.amends, original.id);
  assert.equal(fixed.o, 'stale session cache');
  assert.equal(fixed.s, original.s);
  assert.equal(fixed.source, original.source);
  assert.equal(fixed.confidence, 0.4);
  assert.equal(fixed.valid_from, original.valid_from);
  assert.equal(fixed.agent_id, 'human:jane');
  assert.equal(fixed.status, 'staging');
  assert.throws(() => amendment(graph, original.id, { agent_id: 'human:jane' }, PARSED), /nothing to change/);
  assert.throws(() => amendment(graph, 'a-nope', { o: 'x', agent_id: 'human:jane' }, PARSED), /a-nope: no such assertion/);
  assert.throws(() => amendment(graph, original.id, { s_type: 'module', agent_id: 'human:jane' }, PARSED), /s_type "module" is not in/);
  graph.set(original.id, { ...original, status: 'invalid' });
  assert.throws(() => amendment(graph, original.id, { o: 'x', agent_id: 'human:jane' }, PARSED), /is invalid; propose a new fact instead/);
});

// ----------------------------------------------------------------- fold

test('the graph is the fold of the log: propose, commit with supersede, invalidate', (t) => {
  const f = fixture(t);
  const a = propose({ file: f.log, assertion: fact(), by: 'seat:a' });
  const b = propose({ file: f.log, assertion: fact({ o: 'clock skew' }), by: 'seat:b' });
  let graph = foldLog(readLog(f.log));
  assert.equal(graph.size, 2);
  assert.equal(graph.get(a.id).status, 'staging');

  commit({ file: f.log, values: PARSED, id: a.id, by: 'human' });
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(a.id).status, 'active');

  // Same subject and predicate, another object: a conflict, refused.
  assert.throws(() => commit({ file: f.log, values: PARSED, id: b.id, by: 'human' }), new RegExp(`${b.id}: conflicts with active ${a.id}`));
  // And nothing was written by the refusal.
  assert.equal(readLog(f.log).length, 3);

  const { superseded } = commit({ file: f.log, values: PARSED, id: b.id, by: 'human', supersede: true });
  assert.deepEqual(superseded, [a.id]);
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(b.id).status, 'active');
  assert.equal(graph.get(a.id).status, 'invalid');
  assert.equal(graph.get(a.id).invalid_reason, `superseded by ${b.id}`);
  // The superseded fact stopped holding when its replacement began to hold.
  assert.equal(graph.get(a.id).valid_to, b.valid_from);

  // The same object again is a duplicate, not a conflict.
  const c = propose({ file: f.log, assertion: fact({ o: 'clock skew' }), by: 'seat:c' });
  graph = foldLog(readLog(f.log));
  assert.throws(() => commitPlan({ assertions: graph, id: c.id, values: PARSED }), new RegExp(`${b.id} already states issue-12 caused-by clock skew in auth`));
  assert.throws(() => commit({ file: f.log, values: PARSED, id: b.id, by: 'human' }), /is active, only staging can be committed/);

  invalidate({ file: f.log, id: b.id, by: 'human', reason: 'fixed in #41' });
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(b.id).status, 'invalid');
  assert.equal(graph.get(b.id).invalid_reason, 'fixed in #41');
  assert.throws(() => invalidate({ file: f.log, id: b.id, by: 'human', reason: 'again' }), /is already invalid/);
  assert.throws(() => invalidate({ file: f.log, id: c.id, by: 'human', reason: '' }), /invalidate requires --reason/);
  assert.throws(() => invalidate({ file: f.log, id: 'a-nope', by: 'human', reason: 'x' }), /a-nope: no such assertion/);

  // Every line carries the log version; a line without it is refused.
  const lines = readFileSync(f.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => JSON.parse(line).v === 1));
  writeFileSync(f.log, readFileSync(f.log, 'utf8') + '{"op":"commit","id":"x"}\n');
  assert.throws(() => readLog(f.log), /expected a version 1 event/);
  assert.deepEqual(counts(graph), { total: 3, staging: 1, active: 0, invalid: 2, staging_below_half: 0 });
});

test('committing an amendment closes the original with an empty interval, so no moment answers with both', (t) => {
  const f = fixture(t);
  const original = propose({ file: f.log, assertion: fact({ valid_from: '2026-09-01T00:00:00Z' }), by: 'seat:a' });
  let graph = foldLog(readLog(f.log));
  commit({ file: f.log, values: PARSED, id: original.id, by: 'human:jane' });
  graph = foldLog(readLog(f.log));
  const fixed = propose({ file: f.log, assertion: amendment(graph, original.id, { o: 'stale session cache', agent_id: 'human:jane' }, PARSED), by: 'human:jane' });
  graph = foldLog(readLog(f.log));
  // Same subject and predicate, another object: for an amendment that is the point, not a conflict.
  const plan = commitPlan({ assertions: graph, id: fixed.id, values: PARSED });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.amends, original.id);
  const result = commit({ file: f.log, values: PARSED, id: fixed.id, by: 'human:jane' });
  assert.equal(result.amended, original.id);
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(fixed.id).status, 'active');
  assert.equal(graph.get(original.id).status, 'invalid');
  assert.equal(graph.get(original.id).invalid_reason, `amended by ${fixed.id}`);
  assert.equal(graph.get(original.id).valid_to, graph.get(original.id).valid_from);
  assert.deepEqual(query(graph, { at: '2026-09-02T00:00:00Z' }).map((row) => row.id), [fixed.id]);
  // A staging original is closed the same way; an amendment of an amendment names the latest.
  const draft = propose({ file: f.log, assertion: fact({ s: 'issue-13', o: 'typo' }), by: 'seat:a' });
  graph = foldLog(readLog(f.log));
  const draftFixed = propose({ file: f.log, assertion: amendment(graph, draft.id, { o: 'type', agent_id: 'seat:a' }, PARSED), by: 'seat:a' });
  graph = foldLog(readLog(f.log));
  commit({ file: f.log, values: PARSED, id: draftFixed.id, by: 'human:jane' });
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(draft.id).status, 'invalid');
  assert.equal(graph.get(draftFixed.id).status, 'active');
  // An amendment that moves onto another active fact's subject and predicate is still a conflict.
  const moved = propose({ file: f.log, assertion: amendment(graph, draftFixed.id, { s: 'issue-12', agent_id: 'seat:a' }, PARSED), by: 'seat:a' });
  graph = foldLog(readLog(f.log));
  assert.throws(() => commit({ file: f.log, values: PARSED, id: moved.id, by: 'human:jane' }), new RegExp(`${moved.id}: conflicts with active ${fixed.id}`));
  assert.equal(graph.get(draftFixed.id).status, 'active');
});

// ---------------------------------------------------------------- query

test('query filters exactly, and --at answers what was held at a moment over committed facts only', (t) => {
  const f = fixture(t);
  const early = propose({ file: f.log, assertion: fact({ valid_from: '2026-09-01T00:00:00Z' }), by: 'seat:a' });
  const later = propose({ file: f.log, assertion: fact({ o: 'clock skew', valid_from: '2026-09-05T00:00:00Z' }), by: 'seat:b' });
  const other = propose({ file: f.log, assertion: fact({ s: 'sprint-3', p: 'done-when', o: 'login passes local QA', s_type: 'decision', domain: 'sprint', confidence: 0.3 }), by: 'seat:c' });
  let graph = foldLog(readLog(f.log));
  commit({ file: f.log, values: PARSED, id: early.id, by: 'human' });
  graph = foldLog(readLog(f.log));
  commit({ file: f.log, values: PARSED, id: later.id, by: 'human', supersede: true });
  graph = foldLog(readLog(f.log));

  assert.deepEqual(query(graph, { status: 'active' }).map((row) => row.id), [later.id]);
  assert.deepEqual(query(graph, { status: 'staging' }).map((row) => row.id), [other.id]);
  assert.deepEqual(query(graph, { status: 'staging', below: 0.5 }).map((row) => row.id), [other.id]);
  assert.deepEqual(query(graph, { status: 'staging', below: 0.2 }), []);
  assert.deepEqual(query(graph, { status: 'active', domain: 'sprint' }), []);
  assert.deepEqual(query(graph, { status: 'invalid', type: 'issue' }).map((row) => row.id), [early.id]);
  // Between the two valid_from dates the first fact held, even though it is invalid now.
  assert.deepEqual(query(graph, { at: '2026-09-03T00:00:00Z' }).map((row) => row.id), [early.id]);
  // Before either, nothing; at the second's valid_from, the second.
  assert.deepEqual(query(graph, { at: '2026-08-01T00:00:00Z' }), []);
  assert.deepEqual(query(graph, { at: '2026-09-05T00:00:00Z' }).map((row) => row.id), [later.id]);
  // Staging never answers a moment, whatever its valid_from.
  assert.deepEqual(query(graph, { at: '2100-01-01T00:00:00Z', domain: 'sprint' }), []);
  assert.throws(() => query(graph, { at: 'noon' }), /--at must be an ISO-8601 date-time/);
});

// ------------------------------------------------------------------ cli

test('the CLI parser knows each verb, its flags, and what propose must be given', () => {
  assert.equal(parseMyceliumCliArgs([]).help, true);
  assert.equal(parseMyceliumCliArgs(['help']).help, true);
  assert.throws(() => parseMyceliumCliArgs(['prune']), /unknown command "prune"/);
  const full = parseMyceliumCliArgs(['propose', '--s', 'x', '--p', 'is', '--o', 'y', '--s-type', 'issue', '--domain', 'auth', '--source', 'f:1', '--confidence', '0.8']);
  assert.equal(full.s_type, 'issue');
  assert.equal(full.confidence, '0.8');
  assert.throws(() => parseMyceliumCliArgs(['propose', '--s', 'x', '--p', 'is', '--o', 'y', '--s-type', 'issue', '--domain', 'auth']), /propose requires --source/);
  assert.throws(() => parseMyceliumCliArgs(['propose', '--s', 'x', '--p', 'is', '--o', 'y', '--source', 'f', '--domain', 'auth']), /propose requires --s-type/);
  assert.throws(() => parseMyceliumCliArgs(['propose', '--s', 'x', '--p', 'is', '--o', 'y', '--source', 'f', '--s-type', 'issue']), /propose requires --domain/);
  assert.throws(() => parseMyceliumCliArgs(['propose', '--from-seat', 'w1', '--s', 'x', '--s-type', 'seat', '--domain', 'auth']), /--from-seat sets --s from the seat's report/);
  assert.equal(parseMyceliumCliArgs(['propose', '--from-seat', 'w1', '--s-type', 'seat', '--domain', 'auth']).from_seat, 'w1');
  assert.throws(() => parseMyceliumCliArgs(['propose', '--s']), /--s requires a value/);
  assert.throws(() => parseMyceliumCliArgs(['propose', 'extra']), /propose takes no positional arguments/);
  assert.throws(() => parseMyceliumCliArgs(['commit']), /commit takes exactly 1 positional argument/);
  assert.equal(parseMyceliumCliArgs(['amend', 'a-1', '--o', 'y', '--confidence', '0.9']).o, 'y');
  assert.throws(() => parseMyceliumCliArgs(['amend']), /amend takes exactly 1 positional argument/);
  assert.throws(() => parseMyceliumCliArgs(['amend', 'a-1', '--from-seat', 'w1']), /--from-seat is not valid for amend/);
  assert.equal(parseMyceliumCliArgs(['commit', 'a-1', '--supersede']).supersede, true);
  assert.throws(() => parseMyceliumCliArgs(['commit', 'a-1', '--reason', 'x']), /--reason is not valid for commit/);
  assert.throws(() => parseMyceliumCliArgs(['invalidate', 'a-1']), /invalidate requires --reason/);
  assert.throws(() => parseMyceliumCliArgs(['query', '--status', 'done']), /--status must be one of staging, active, invalid/);
  assert.throws(() => parseMyceliumCliArgs(['query', '--status', 'active', '--at', '2026-09-08T00:00:00Z']), /pass --at or --status, not both/);
  assert.equal(parseMyceliumCliArgs(['query', '--ids']).ids, true);
  assert.throws(() => parseMyceliumCliArgs(['query', '--ids', '--json']), /pass one of --json, --ids, --brief/);
  assert.equal(parseMyceliumCliArgs(['status', '--project', '/x']).project, '/x');
});

test('the CLI round trip: status, propose, commit, query, invalidate at a real slug, with the log read back', (t) => {
  const f = fixture(t);
  let status = f.json(['status']);
  assert.equal(status.project, 'mycelium-test');
  assert.equal(status.file, f.log);
  assert.deepEqual(status.counts, { total: 0, staging: 0, active: 0, invalid: 0, staging_below_half: 0 });
  assert.equal(existsSync(f.log), false);

  // No writer, no write.
  const anonymous = f.run(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'stale cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'src/auth/cache.ts:40']);
  assert.equal(anonymous.status, 1);
  assert.match(anonymous.stderr, /pass --by <who>/);
  assert.equal(existsSync(f.log), false);

  // A seat names itself through DRYAD_ID.
  const proposed = f.json(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'stale cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'src/auth/cache.ts:40', '--model', 'example-model'], { DRYAD_ID: 'w1' });
  assert.equal(proposed.agent_id, 'seat:w1');
  assert.equal(proposed.model, 'example-model');
  assert.equal(proposed.status, 'staging');

  const refused = f.run(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'x', '--s-type', 'module', '--domain', 'auth', '--source', 'f', '--by', 'human']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /s_type "module" is not in/);

  const committed = f.run(['commit', proposed.id, '--by', 'human']);
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.stdout, new RegExp(`committed ${proposed.id} \\(active\\)`));

  const active = f.json(['query', '--domain', 'auth']);
  assert.deepEqual(active.map((row) => [row.id, row.status]), [[proposed.id, 'active']]);
  const text = f.run(['query', '--s', 'issue-12']);
  assert.match(text.stdout, /1 assertion \(active\)/);
  assert.match(text.stdout, new RegExp(`${proposed.id}  active   0.50  auth        issue-12 caused-by stale cache`));

  const invalidated = f.run(['invalidate', proposed.id, '--reason', 'fixed in #41', '--by', 'human']);
  assert.equal(invalidated.status, 0, invalidated.stderr);
  assert.deepEqual(f.json(['query']), []);
  assert.equal(f.json(['query', '--status', 'invalid'])[0].invalid_reason, 'fixed in #41');

  status = f.json(['status']);
  assert.deepEqual(status.counts, { total: 1, staging: 0, active: 0, invalid: 1, staging_below_half: 0 });
  const lines = readFileSync(f.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.op), ['propose', 'commit', 'invalidate']);
  assert.deepEqual(lines.map((line) => line.by), ['seat:w1', 'human', 'human']);

  const help = f.run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mycelium propose --s S --p P --o O/);
  assert.match(help.stdout, /mycelium amend <id>/);
  const unnamed = f.run(['commit', proposed.id, '--by', 'Jane Doe']);
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /writer "Jane Doe" must be a short id/);
  const missing = f.run(['status', '--project', f.root]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /dryad profile not found/);
});

test('with judges declared, only a judge commits or invalidates; anyone named still proposes and amends', (t) => {
  const f = fixture(t, { values: { ...VALUES, judges: ['human:jane'] } });
  const status = f.run(['status']);
  assert.match(status.stdout, /judges    human:jane/);
  const proposed = f.json(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'stale cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'src/auth/cache.ts:40'], { DRYAD_ID: 'w1' });
  const seatCommit = f.run(['commit', proposed.id], { DRYAD_ID: 'w1' });
  assert.equal(seatCommit.status, 1);
  assert.match(seatCommit.stderr, /seat:w1 is not a judge of this project \(judges: human:jane\)/);
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
  const amended = f.json(['amend', proposed.id, '--confidence', '0.8', '--source', 'src/auth/cache.ts:40-52'], { DRYAD_ID: 'w1' });
  assert.equal(amended.amends, proposed.id);
  assert.equal(amended.confidence, 0.8);
  assert.equal(amended.agent_id, 'seat:w1');
  const judgeCommit = f.run(['commit', amended.id, '--by', 'human:jane']);
  assert.equal(judgeCommit.status, 0, judgeCommit.stderr);
  assert.match(judgeCommit.stdout, new RegExp(`committed ${amended.id} \\(active\\), amended ${proposed.id}`));
  assert.deepEqual(f.json(['query']).map((row) => [row.id, row.confidence]), [[amended.id, 0.8]]);
  assert.equal(f.json(['query', '--status', 'invalid'])[0].invalid_reason, `amended by ${amended.id}`);
  const seatInvalidate = f.run(['invalidate', amended.id, '--reason', 'x'], { DRYAD_ID: 'w1' });
  assert.equal(seatInvalidate.status, 1);
  assert.match(seatInvalidate.stderr, /is not a judge/);
  const judgeInvalidate = f.run(['invalidate', amended.id, '--reason', 'fixed in #41', '--by', 'human:jane']);
  assert.equal(judgeInvalidate.status, 0, judgeInvalidate.stderr);
  assert.deepEqual(f.json(['query']), []);
});

test('a seat working in its own worktree is the writer, with no --by and no DRYAD_ID', (t) => {
  const f = fixture(t);
  const worktree = path.join(f.root, 'seats/api-endpoint');
  mkdirSync(path.join(worktree, 'src'), { recursive: true });
  // A sibling whose name merely starts with the worktree's must not match.
  mkdirSync(path.join(f.root, 'seats/api-endpoint-2'), { recursive: true });
  mkdirSync(path.join(f.root, 'state/dryads'), { recursive: true });
  const seat = { worktree, branch: 'dryad/api-endpoint', base: 'abc', task: 't', created_at: '2026-09-08T00:00:00.000Z', status: 'working', owned: true, env: null, by: null, session: null, journal: [] };
  writeFileSync(path.join(f.root, 'state/dryads/mycelium-test.yml'), stringify({ version: 1, project: 'mycelium-test', seats: { 'api-endpoint': seat, gone: { ...seat, worktree: path.join(f.root, 'seats/gone') } } }));

  assert.equal(seatAt('mycelium-test', path.join(worktree, 'src'), f.environment), 'api-endpoint');
  assert.equal(seatAt('mycelium-test', worktree, f.environment), 'api-endpoint');
  assert.equal(seatAt('mycelium-test', f.baseline, f.environment), null);
  assert.equal(seatAt('mycelium-test', path.join(f.root, 'seats/api-endpoint-2'), f.environment), null);
  assert.equal(seatAt('mycelium-test', path.join(f.root, 'nowhere'), f.environment), null);

  const inSeat = (args, env = {}) => spawnSync(process.execPath, [CLI, 'mycelium', ...args, '--project', f.baseline, '--json'], { cwd: path.join(worktree, 'src'), encoding: 'utf8', env: { ...f.environment, ...env } });
  const fromWorktree = inSeat(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'stale cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'src/auth/cache.ts:40']);
  assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
  assert.equal(JSON.parse(fromWorktree.stdout).agent_id, 'seat:api-endpoint');
  // DRYAD_ID still wins over the worktree, and --by over both.
  assert.equal(JSON.parse(inSeat(['propose', '--s', 'a', '--p', 'b', '--o', 'c', '--s-type', 'issue', '--domain', 'auth', '--source', 'f'], { DRYAD_ID: 'w9' }).stdout).agent_id, 'seat:w9');
  assert.equal(JSON.parse(inSeat(['propose', '--s', 'a', '--p', 'b', '--o', 'd', '--s-type', 'issue', '--domain', 'auth', '--source', 'f', '--by', 'human:jane'], { DRYAD_ID: 'w9' }).stdout).agent_id, 'human:jane');
  // Outside every worktree the refusal names the three ways in.
  const outside = f.run(['propose', '--s', 'a', '--p', 'b', '--o', 'e', '--s-type', 'issue', '--domain', 'auth', '--source', 'f']);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /runs from its worktree/);
  // --ids prints one id per line for a shell loop.
  const ids = f.run(['query', '--status', 'staging', '--ids']);
  assert.equal(ids.status, 0, ids.stderr);
  assert.equal(ids.stdout.trim().split('\n').length, 3);
  assert.ok(ids.stdout.trim().split('\n').every((line) => /^a-[0-9a-f]{10}$/.test(line)));
});

test('a many predicate takes a second object as another edge; a one predicate takes it as a conflict; duplicates are refused for both', (t) => {
  const f = fixture(t);
  const edge1 = propose({ file: f.log, assertion: fact({ s: 'web-panel', p: 'depends-on', o: 'define-shape', o_type: 'issue' }), by: 'seat:a' });
  const edge2 = propose({ file: f.log, assertion: fact({ s: 'web-panel', p: 'depends-on', o: 'api-endpoint', o_type: 'issue' }), by: 'seat:a' });
  const dup = propose({ file: f.log, assertion: fact({ s: 'web-panel', p: 'depends-on', o: 'api-endpoint', o_type: 'issue' }), by: 'seat:b' });
  commit({ file: f.log, values: PARSED, id: edge1.id, by: 'human' });
  const second = commit({ file: f.log, values: PARSED, id: edge2.id, by: 'human' });
  assert.deepEqual(second.superseded, []);
  let graph = foldLog(readLog(f.log));
  assert.deepEqual(query(graph, { status: 'active', s: 'web-panel' }).map((row) => row.o), ['define-shape', 'api-endpoint']);
  assert.throws(() => commit({ file: f.log, values: PARSED, id: dup.id, by: 'human' }), new RegExp(`${edge2.id} already states web-panel depends-on api-endpoint`));
  // The predicate was removed from the vocabulary after the proposal: refused at commit, not silently promoted.
  const narrowed = { ...VALUES, predicates: { 'caused-by': 'one' } };
  const late = propose({ file: f.log, assertion: fact({ s: 'web-panel', p: 'depends-on', o: 'docs-pass', o_type: 'issue' }), by: 'seat:a' });
  assert.throws(() => commit({ file: f.log, values: parseMyceliumValues(stringify(narrowed)), id: late.id, by: 'human' }), /predicate "depends-on" is no longer in/);
  graph = foldLog(readLog(f.log));
  assert.equal(graph.get(late.id).status, 'staging');
});

test('commit takes the log lock: two committers racing on one predicate leave exactly one active, and n proposers leave n whole lines', async (t) => {
  const f = fixture(t);
  const a = f.json(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'stale cache', '--s-type', 'issue', '--domain', 'auth', '--source', 'f', '--by', 'seat:a']);
  const b = f.json(['propose', '--s', 'issue-12', '--p', 'caused-by', '--o', 'clock skew', '--s-type', 'issue', '--domain', 'auth', '--source', 'f', '--by', 'seat:b']);
  const race = (id) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mycelium', 'commit', id, '--by', 'human'], { cwd: f.baseline, env: f.environment });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([race(a.id), race(b.id), race(a.id), race(b.id)]);
  const won = results.filter((result) => result.code === 0);
  assert.equal(won.length, 1, JSON.stringify(results));
  assert.ok(results.filter((result) => /conflicts with active/.test(result.stderr)).length >= 1, JSON.stringify(results));
  assert.deepEqual(f.json(['query']).length, 1);
  assert.equal(existsSync(`${f.log}.lock`), false);

  const proposers = Array.from({ length: 12 }, (_, index) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mycelium', 'propose', '--s', `issue-${index}`, '--p', 'depends-on', '--o', 'x'.repeat(200), '--s-type', 'issue', '--domain', 'auth', '--source', 'f', '--by', `seat:p${index}`], { cwd: f.baseline, env: f.environment });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  const outcomes = await Promise.all(proposers);
  // A failed proposer names itself: the assertion carries its stderr.
  assert.deepEqual(outcomes.map((o) => o.code), Array(12).fill(0), outcomes.filter((o) => o.code !== 0).map((o) => o.stderr).join('\n'));
  const lines = readFileSync(f.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2 + 4 - 3 + 12);
  assert.ok(lines.every((line) => JSON.parse(line).v === 1));
  assert.equal(foldLog(readLog(f.log)).size, 14);
});

test('query --all, --since, --brief and trace read the chain a fact belongs to', (t) => {
  const f = fixture(t);
  const first = propose({ file: f.log, assertion: fact({ valid_from: '2026-09-01T00:00:00Z', tx_at: '2026-09-01T10:00:00.000Z' }), by: 'seat:a' });
  commit({ file: f.log, values: PARSED, id: first.id, by: 'human' });
  const fixed = proposeAmendment({ file: f.log, id: first.id, overrides: { confidence: 0.9, agent_id: 'human:jane' }, values: PARSED, by: 'human:jane' });
  commit({ file: f.log, values: PARSED, id: fixed.id, by: 'human:jane' });
  const newer = propose({ file: f.log, assertion: fact({ o: 'clock skew', valid_from: '2026-09-05T00:00:00Z' }), by: 'seat:b' });
  commit({ file: f.log, values: PARSED, id: newer.id, by: 'human', supersede: true });
  const unrelated = propose({ file: f.log, assertion: fact({ s: 'sprint-3', p: 'done-when', o: 'x', s_type: 'decision', domain: 'sprint' }), by: 'seat:c' });
  const graph = foldLog(readLog(f.log));

  assert.deepEqual(query(graph, {}).map((row) => row.id).sort(), [first.id, fixed.id, newer.id, unrelated.id].sort());
  assert.deepEqual(query(graph, { status: 'active' }).map((row) => row.id), [newer.id]);
  // --since is the time of the last line that touched a row: the first fact
  // was written on Sep 1 but amended now, so it is news; a fact left alone
  // since Sep 1 is not.
  const sinceSep2 = query(graph, { since: '2026-09-02T00:00:00Z' }).map((row) => row.id);
  assert.ok(sinceSep2.includes(first.id), 'amended since counts as changed');
  const untouched = propose({ file: f.log, assertion: fact({ s: 'issue-1', o: 'old news', tx_at: '2026-09-01T09:00:00.000Z' }), by: 'seat:a' });
  const again = foldLog(readLog(f.log));
  assert.equal(again.get(untouched.id).changed_at, '2026-09-01T09:00:00.000Z');
  assert.ok(!query(again, { since: '2026-09-02T00:00:00Z' }).map((row) => row.id).includes(untouched.id));
  assert.equal(query(graph, { since: '2100-01-01T00:00:00Z' }).length, 0);
  assert.throws(() => query(graph, { since: 'lately' }), /--since must be an ISO-8601 date-time/);

  const chain = trace(graph, newer.id);
  assert.deepEqual(chain.map((row) => [row.id, row.link]), [
    [first.id, `amended by ${fixed.id}`],
    [fixed.id, `amends ${first.id}`],
    [newer.id, `supersedes ${fixed.id}`],
  ]);
  assert.deepEqual(trace(graph, first.id).map((row) => row.id), chain.map((row) => row.id));
  assert.deepEqual(trace(graph, unrelated.id).map((row) => [row.id, row.link]), [[unrelated.id, 'origin']]);
  assert.throws(() => trace(graph, 'a-nope'), /a-nope: no such assertion/);

  const text = brief(query(graph, { status: 'active' }));
  assert.equal(text, `- ${newer.id}  issue-12 caused-by clock skew  (auth, 0.50, src/auth/cache.ts:40)`);

  const cli = f.run(['query', '--all']);
  assert.match(cli.stdout, /5 assertions \(every status\)/);
  assert.equal(f.run(['query', '--brief', '--s', 'issue-12']).stdout.trim(), text);
  assert.equal(f.run(['query', '--brief', '--s', 'nobody']).stdout, '');
  const traced = f.run(['trace', newer.id]);
  assert.match(traced.stdout, new RegExp(`3 in the chain of ${newer.id}`));
  assert.match(traced.stdout, new RegExp(`supersedes ${fixed.id}`));
  assert.throws(() => parseMyceliumCliArgs(['query', '--all', '--status', 'active']), /--all takes every status/);
  assert.throws(() => parseMyceliumCliArgs(['query', '--brief', '--ids']), /pass one of --json, --ids, --brief/);
  assert.throws(() => parseMyceliumCliArgs(['trace']), /trace takes exactly 1 positional argument/);
});

// ------------------------------------------------------- forester seam

test('propose --from-seat turns a seat\'s done report into a staging fact, and refuses a seat that has not reported done', (t) => {
  const f = fixture(t);
  const seat = (status, journal) => ({ worktree: '/w', branch: 'dryad/x', base: 'abc', task: 't', created_at: '2026-09-08T00:00:00.000Z', status, owned: true, env: null, by: 'codex', session: null, journal });
  mkdirSync(path.join(f.root, 'state/dryads'), { recursive: true });
  writeFileSync(
    path.join(f.root, 'state/dryads/mycelium-test.yml'),
    stringify({
      version: 1,
      project: 'mycelium-test',
      seats: {
        'api-endpoint': seat('done', [
          { at: '2026-09-08T01:00:00.000Z', actor: 'dryad', event: 'plan', detail: 'worktree add' },
          { at: '2026-09-08T02:00:00.000Z', actor: 'seat', event: 'report', detail: 'working: halfway' },
          { at: '2026-09-08T03:00:00.000Z', actor: 'seat', event: 'report', detail: 'done: endpoint returns the shape, 4/4 tests' },
        ]),
        'web-panel': seat('blocked', [
          { at: '2026-09-08T01:00:00.000Z', actor: 'seat', event: 'report', detail: 'working' },
          { at: '2026-09-08T01:15:00.000Z', actor: 'seat', event: 'report', detail: 'done-ish: not the word' },
          { at: '2026-09-08T01:30:00.000Z', actor: 'seat', event: 'report', detail: 'blocked: waits for the shape' },
        ]),
      },
    })
  );
  writeFileSync(
    path.join(f.root, 'state/dryads/mycelium-test.finished.yml'),
    stringify({ version: 1, project: 'mycelium-test', seats: [{ id: 'docs-pass', finished_at: '2026-09-08T04:00:00.000Z', ...seat('done', [{ at: '2026-09-08T03:30:00.000Z', actor: 'seat', event: 'report', detail: 'done' }]) }] })
  );

  assert.deepEqual(seatDoneReport('mycelium-test', 'docs-pass', f.environment), { at: '2026-09-08T03:30:00.000Z', detail: 'done', by: 'codex' });
  // A retried item: an archived earlier seat reported blocked, the live seat reported blocked later. The live seat wins.
  const archive = parse(readFileSync(path.join(f.root, 'state/dryads/mycelium-test.finished.yml'), 'utf8'));
  archive.seats.push({ id: 'web-panel', finished_at: '2026-09-08T00:50:00.000Z', ...seat('blocked', [{ at: '2026-09-08T00:40:00.000Z', actor: 'seat', event: 'report', detail: 'blocked: first attempt, stale' }]) });
  writeFileSync(path.join(f.root, 'state/dryads/mycelium-test.finished.yml'), stringify(archive));
  assert.equal(seatReport('mycelium-test', 'web-panel', 'blocked', f.environment).detail, 'blocked: waits for the shape');
  // With no live seat, the newest archived record answers, not the oldest.
  archive.seats.push({ id: 'docs-pass', finished_at: '2026-09-08T05:00:00.000Z', ...seat('done', [{ at: '2026-09-08T04:30:00.000Z', actor: 'seat', event: 'report', detail: 'done: second run' }]) });
  writeFileSync(path.join(f.root, 'state/dryads/mycelium-test.finished.yml'), stringify(archive));
  assert.equal(seatDoneReport('mycelium-test', 'docs-pass', f.environment).detail, 'done: second run');
  assert.deepEqual(seatReport('mycelium-test', 'web-panel', 'blocked', f.environment), { at: '2026-09-08T01:30:00.000Z', detail: 'blocked: waits for the shape', by: 'codex' });
  assert.throws(() => seatReport('mycelium-test', 'api-endpoint', 'blocked', f.environment), /seat api-endpoint: has no blocked report/);
  assert.throws(() => seatReport('mycelium-test', 'web-panel', 'working', f.environment), /--report must be one of done, blocked/);
  // 'done-ish' does not match done: the report is the status, or the status and a colon.
  assert.throws(() => seatReport('mycelium-test', 'web-panel', 'done', f.environment), /has no done report/);
  assert.throws(() => seatDoneReport('mycelium-test', 'web-panel', f.environment), /seat web-panel: has no done report/);
  assert.throws(() => seatDoneReport('mycelium-test', 'nobody', f.environment), /seat nobody: not in the registry or the finished archive/);

  const row = f.json(['propose', '--from-seat', 'api-endpoint', '--s-type', 'seat', '--domain', 'sprint', '--by', 'human']);
  assert.equal(row.s, 'api-endpoint');
  assert.equal(row.p, 'reported');
  assert.equal(row.o, 'done: endpoint returns the shape, 4/4 tests');
  assert.equal(row.source, 'dryad seat api-endpoint report at 2026-09-08T03:00:00.000Z');
  assert.equal(row.valid_from, '2026-09-08T03:00:00.000Z');
  assert.equal(row.status, 'staging');
  const refused = f.run(['propose', '--from-seat', 'web-panel', '--s-type', 'seat', '--domain', 'sprint', '--by', 'human']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /has no done report/);
  const blocked = f.json(['propose', '--from-seat', 'web-panel', '--report', 'blocked', '--s-type', 'seat', '--domain', 'sprint', '--by', 'human']);
  assert.equal(blocked.o, 'blocked: waits for the shape');
  assert.equal(blocked.p, 'reported');
  assert.equal(blocked.valid_from, '2026-09-08T01:30:00.000Z');
  assert.throws(() => parseMyceliumCliArgs(['propose', '--from-seat', 'w', '--report', 'working', '--s-type', 'seat', '--domain', 'sprint']), /--report must be one of done, blocked/);
  assert.throws(() => parseMyceliumCliArgs(['propose', '--s', 'a', '--p', 'b', '--o', 'c', '--source', 'f', '--report', 'done', '--s-type', 'seat', '--domain', 'sprint']), /--report goes with --from-seat/);
  // The registry itself was only read.
  assert.match(readFileSync(path.join(f.root, 'state/dryads/mycelium-test.yml'), 'utf8'), /status: blocked/);
});
