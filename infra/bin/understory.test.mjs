import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUnderstoryCliArgs, understoryGraph, understoryReading, understorySummary } from '../lib/understory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const FIXTURE = path.join(HERE, 'fixtures/understory-plan.json');

// The four-item plan at the moment define-shape is active: one dependency
// edge each for two items, a claim hold, and a budget hold.
const MOMENT = {
  project: 'acme',
  budget: { parallel: 2, source: 'local' },
  counts: { done: 0, active: 1, failed: 0, blocked: 2, ready: 1 },
  items: [
    { id: 'define-shape', state: 'active', why: 'seat working', task: 'x', owns: ['docs/reference/**'], depends_on: [], tool: null, attempts: 0, max_attempts: 1, seat: { id: 'define-shape', status: 'working' }, session: { state: 'needs-input', doing: 'Edit docs/reference.md' } },
    { id: 'api-endpoint', state: 'blocked', why: 'waits for define-shape', task: 'x', owns: ['src/api/**'], depends_on: ['define-shape'], tool: 'codex', attempts: 0, max_attempts: 1, seat: null, session: null },
    { id: 'web-panel', state: 'blocked', why: 'waits for define-shape', task: 'x', owns: ['src/web/**'], depends_on: ['define-shape'], tool: null, attempts: 0, max_attempts: 2, seat: null, session: null },
    { id: 'docs-pass', state: 'ready', why: 'no dependencies', task: 'x', owns: ['docs/**'], depends_on: [], tool: null, attempts: 0, max_attempts: 1, seat: null, session: null },
  ],
  next: [],
  held: [{ id: 'docs-pass', reason: 'claim docs/** intersects docs/reference/** of define-shape (active)' }],
  slots: { active: 1, free: 1, parallel: 2 },
  seats_outside_plan: [],
  serve: null,
};

test('the graph has one coloured node per item, an edge per dependency, and a dotted edge per claim hold', () => {
  const graph = understoryGraph(MOMENT);
  assert.match(graph, /^flowchart LR\n/);
  for (const state of ['done', 'active', 'ready', 'blocked', 'failed']) assert.match(graph, new RegExp(`classDef ${state} fill:`));
  assert.match(graph, /n_define_shape\["define-shape<br\/>docs\/reference\/\*\*<br\/>needs-input"\]:::active/);
  assert.match(graph, /n_api_endpoint\["api-endpoint<br\/>src\/api\/\*\*<br\/>codex"\]:::blocked/);
  assert.match(graph, /n_define_shape --> n_api_endpoint/);
  assert.match(graph, /n_define_shape --> n_web_panel/);
  assert.match(graph, /n_docs_pass -\. "claim docs\/\*\*" \.-> n_define_shape/);
  assert.equal((graph.match(/-->/g) ?? []).length, 2);
  // The legend shows only the states present.
  assert.match(graph, /l_active\["active"\]/);
  assert.doesNotMatch(graph, /l_done\[/);
  // A budget hold is drawn as a self-note, not as an edge to another item.
  const budget = understoryGraph({ ...MOMENT, held: [{ id: 'docs-pass', reason: 'budget full (2)' }] });
  assert.match(budget, /n_docs_pass ---\|"budget full \(2\)"\| n_docs_pass/);
  assert.throws(() => understoryGraph({}), /expected forester plan --json/);
});

test('the reading says, per item, what a person should take from it', () => {
  const rows = understoryReading(MOMENT);
  assert.deepEqual(rows.map((row) => [row.id, row.line]), [
    ['define-shape', 'someone is working on it and the session is waiting for a person, now Edit docs/reference.md'],
    ['api-endpoint', 'cannot start yet: waits for define-shape'],
    ['web-panel', 'cannot start yet: waits for define-shape'],
    ['docs-pass', 'could start, but claim docs/** intersects docs/reference/** of define-shape (active)'],
  ]);
  const later = understoryReading({ ...MOMENT, next: ['docs-pass'], held: [], items: MOMENT.items.map((item) => (item.id === 'define-shape' ? { ...item, state: 'done', why: 'seat reported done', session: null } : item)) });
  assert.equal(later.find((row) => row.id === 'define-shape').line, 'finished (seat reported done)');
  assert.equal(later.find((row) => row.id === 'docs-pass').line, 'would be assigned now');
  const failed = understoryReading({ ...MOMENT, items: [{ ...MOMENT.items[3], state: 'failed', why: '1/1 attempt finished without done' }] });
  assert.equal(failed[0].line, 'gave up: 1/1 attempt finished without done');
  assert.equal(understorySummary(MOMENT), '4 items: 0 done, 1 active, 1 ready, 0 waiting for integration, 2 blocked, 0 failed. Slots 1/2 (budget from local).');
});

test('the cli draws and reads a saved plan without a project', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const graph = spawnSync(process.execPath, [CLI, 'understory', 'graph', '--from', FIXTURE], { encoding: 'utf8' });
  assert.equal(graph.status, 0, graph.stderr);
  assert.equal((graph.stdout.match(/:::(done|active|ready|blocked|failed)/g) ?? []).length, fixture.items.length + new Set(fixture.items.map((item) => item.state)).size);
  const reading = spawnSync(process.execPath, [CLI, 'understory', 'reading', '--from', FIXTURE, '--json'], { encoding: 'utf8' });
  assert.equal(reading.status, 0, reading.stderr);
  const parsed = JSON.parse(reading.stdout);
  assert.equal(parsed.reading.length, fixture.items.length);
  assert.match(parsed.summary, /^10 items: 9 done, 1 active/);
  const text = spawnSync(process.execPath, [CLI, 'understory', 'reading', '--from', FIXTURE], { encoding: 'utf8' });
  assert.match(text.stdout, /support-cursor\s+active\s+someone is working on it/);
  assert.throws(() => parseUnderstoryCliArgs(['graph', '--from', 'a', '--project', 'b']), /not both/);
  assert.throws(() => parseUnderstoryCliArgs(['draw']), /unknown command "draw"/);
  const missing = spawnSync(process.execPath, [CLI, 'understory', 'graph', '--from', '/nonexistent.json'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /nonexistent\.json/);
});

// The reading lines point at what was proven: active Mycelium facts whose
// subject is the item. A project without a values file gets no pointer and
// no error; --from has no project and gets none either.
test('the reading points at the active facts about each item, and only when the project has Mycelium', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'understory-facts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, project: { slug: 'understory-facts' }, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/forester-plan.yml'), 'version: 1\nparallel: 2\ntasks:\n  define-shape:\n    task: "Decide the shape"\n  api-endpoint:\n    task: "Add the endpoint"\n    depends_on: [define-shape]\n');
  const run = (args, extra = []) => spawnSync(process.execPath, [CLI, ...args, '--project', baseline, ...extra], { cwd: root, encoding: 'utf8', env: environment });

  // No values file: plain reading, no facts key filled, exit 0.
  const before = run(['understory', 'reading'], ['--json']);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout).reading.map((row) => row.facts), [[], []]);

  writeFileSync(path.join(baseline, '.agents/mycelium.yml'), stringify({ version: 1, domains: ['sprint'], types: ['issue', 'decision'], predicates: { 'done-when': 'one', 'depends-on': 'many' } }));
  const propose = (args) => {
    const result = run(['mycelium', 'propose', ...args, '--by', 'human:jane'], ['--json']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).id;
  };
  const active = propose(['--s', 'define-shape', '--p', 'done-when', '--o', 'the reference names the shape', '--s-type', 'issue', '--domain', 'sprint', '--source', 'docs/reference.md']);
  const staging = propose(['--s', 'define-shape', '--p', 'depends-on', '--o', 'nothing', '--s-type', 'issue', '--domain', 'sprint', '--source', 'plan']);
  const other = propose(['--s', 'api-endpoint', '--p', 'depends-on', '--o', 'define-shape', '--s-type', 'issue', '--o-type', 'issue', '--domain', 'sprint', '--source', 'plan']);
  for (const id of [active, other]) assert.equal(run(['mycelium', 'commit', id, '--by', 'human:jane']).status, 0);

  const after = run(['understory', 'reading'], ['--json']);
  assert.equal(after.status, 0, after.stderr);
  const reading = JSON.parse(after.stdout).reading;
  assert.deepEqual(reading.map((row) => [row.id, row.facts]), [['define-shape', [active]], ['api-endpoint', [other]]]);
  assert.ok(!reading[0].facts.includes(staging), 'staging is not proven');
  const text = run(['understory', 'reading']);
  assert.match(text.stdout, new RegExp(`define-shape .*· facts ${active}`));
  // --from has no project and therefore no facts.
  const saved = run(['forester', 'plan'], ['--json']);
  const savedFile = path.join(root, 'plan.json');
  writeFileSync(savedFile, saved.stdout);
  const from = spawnSync(process.execPath, [CLI, 'understory', 'reading', '--from', savedFile, '--json'], { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(from.status, 0, from.stderr);
  assert.deepEqual(JSON.parse(from.stdout).reading.map((row) => row.facts), [[], []]);
});
