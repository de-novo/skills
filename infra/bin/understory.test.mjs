import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    { id: 'define-shape', state: 'active', why: 'seat working', task: 'x', owns: ['docs/reference/**'], depends_on: [], tool: null, attempts: 0, max_attempts: 1, seat: { id: 'define-shape', status: 'working' }, session: { state: 'needs-input' } },
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
    ['define-shape', 'someone is working on it and the session is waiting for a person'],
    ['api-endpoint', 'cannot start yet: waits for define-shape'],
    ['web-panel', 'cannot start yet: waits for define-shape'],
    ['docs-pass', 'could start, but claim docs/** intersects docs/reference/** of define-shape (active)'],
  ]);
  const later = understoryReading({ ...MOMENT, next: ['docs-pass'], held: [], items: MOMENT.items.map((item) => (item.id === 'define-shape' ? { ...item, state: 'done', why: 'seat reported done', session: null } : item)) });
  assert.equal(later.find((row) => row.id === 'define-shape').line, 'finished (seat reported done)');
  assert.equal(later.find((row) => row.id === 'docs-pass').line, 'would be assigned now');
  const failed = understoryReading({ ...MOMENT, items: [{ ...MOMENT.items[3], state: 'failed', why: '1/1 attempt finished without done' }] });
  assert.equal(failed[0].line, 'gave up: 1/1 attempt finished without done');
  assert.equal(understorySummary(MOMENT), '4 items: 0 done, 1 active, 1 ready, 2 blocked, 0 failed. Slots 1/2 (budget from local).');
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
