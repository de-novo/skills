// The machine cap: one ceiling on managed seats across every project on
// this machine, taken as reservations under one lock, so two projects
// allocating at once never share a slot; stale reservations are reclaimed
// without touching any live seat; seats nobody reserved are shown as
// unmanaged and never counted or controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { allocate, machineView, reclaimStaleSlots, reserveSlots, slotsPath } from '../lib/forester.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Machine Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const plan = (prefix) => `version: 1\nparallel: 2\ntasks:\n  ${prefix}-one: { task: "one", owns: [one/**] }\n  ${prefix}-two: { task: "two", owns: [two/**] }\n  ${prefix}-three: { task: "three", owns: [three/**] }\n`;

// Two projects on one state directory: the machine is what they share.
function machine(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'machine-')));
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  const project = (slug) => {
    const baseline = path.join(root, slug);
    mkdirSync(path.join(baseline, '.agents'), { recursive: true });
    writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify({ project: { slug }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none' }));
    writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, worktrees: { root: `../${slug}-seats`, branch: 'dryad/{id}' } }));
    writeFileSync(path.join(baseline, '.agents/forester-plan.yml'), plan(slug));
    writeFileSync(path.join(baseline, 'app.txt'), `${slug}\n`);
    gitIn(baseline, ['init', '-b', 'main']);
    gitIn(baseline, ['add', '.']);
    gitIn(baseline, ['commit', '-m', slug]);
    const run = (args) => spawnSync(process.execPath, [CLI, ...args, '--project', baseline], { cwd: baseline, env: environment, encoding: 'utf8', timeout: 20000 });
    const good = (args) => { const r = run(args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
    const json = (args) => JSON.parse(good([...args, '--json']).stdout);
    return { slug, baseline, run, good, json };
  };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 20000 });
  const slots = () => (existsSync(slotsPath(environment)) ? parse(readFileSync(slotsPath(environment), 'utf8')).slots : {});
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, environment, project, cli, slots };
}

test('the machine cap bounds the sum of two projects; each project budget still bounds its own plan', (t) => {
  const m = machine(t);
  const a = m.project('alpha');
  const b = m.project('beta');
  assert.match(m.cli(['forester', 'machine']).stdout, /cap       none/);
  const refused = m.cli(['forester', 'machine', '--parallel', '3']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /rerun with --apply/);
  assert.equal(m.cli(['forester', 'machine', '--parallel', '3', '--apply']).status, 0);
  assert.equal(JSON.parse(m.cli(['forester', 'machine', '--json']).stdout).parallel, 3);

  // alpha takes its own budget of two; beta gets the one slot the machine has left.
  assert.match(a.good(['forester', 'assign', '--apply']).stdout, /assigned 2\/2 · slots 2\/2/);
  const before = b.json(['forester', 'next']);
  assert.deepEqual(before.machine, { parallel: 3, held_by_others: 2, unmanaged: 0 });
  assert.deepEqual(before.next, ['beta-one']);
  assert.deepEqual(before.held.map((row) => [row.id, row.reason]), [['beta-two', 'machine cap full (3; 2 held by other projects)'], ['beta-three', 'machine cap full (3; 2 held by other projects)']]);
  assert.match(b.good(['forester', 'assign', '--apply']).stdout, /assigned 1\/1 · slots 1\/2/);
  assert.match(b.good(['forester', 'status']).stdout, /machine  cap 3 · 2 held by other projects/);
  assert.deepEqual(Object.keys(m.slots()).sort(), ['alpha/alpha-one', 'alpha/alpha-two', 'beta/beta-one']);
  assert.match(m.cli(['forester', 'machine']).stdout, /held      3\/3 managed seats/);

  // A done report frees the slot for whoever asks next.
  a.good(['dryad', 'report', 'alpha-one', '--status', 'done']);
  assert.match(b.good(['forester', 'assign', '--apply']).stdout, /assigned 1\/1 · slots 2\/2/);
  assert.match(b.good(['forester', 'next']).stdout, /hold    beta-three  budget full \(2\)/);
  assert.deepEqual(Object.keys(m.slots()).sort(), ['alpha/alpha-two', 'beta/beta-one', 'beta/beta-two']);

  // The plan's own parallel may say four; the machine still says three.
  writeFileSync(path.join(a.baseline, '.agents/forester-plan.yml'), plan('alpha').replace('parallel: 2', 'parallel: 4'));
  const capped = a.json(['forester', 'next']);
  assert.deepEqual(capped.next, []);
  assert.match(capped.held[0].reason, /machine cap full \(3; 2 held by other projects\)/);
  assert.equal(m.cli(['forester', 'machine', '--parallel', 'none', '--apply']).status, 0);
  assert.deepEqual(a.json(['forester', 'next']).next, ['alpha-three']);
});

test('two projects allocating at the same instant never share a slot', async (t) => {
  const m = machine(t);
  const a = m.project('alpha');
  const b = m.project('beta');
  assert.equal(m.cli(['forester', 'machine', '--parallel', '1', '--apply']).status, 0);
  for (let round = 0; round < 3; round += 1) {
    const results = await Promise.all([a, b].map((p) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'forester', 'assign', '--apply', '--project', p.baseline], { env: m.environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('exit', () => resolve({ slug: p.slug, out }));
    })));
    const assigned = results.map((r) => Number((/assigned (\d+)\//.exec(r.out) ?? [])[1]));
    assert.equal(assigned.reduce((x, y) => x + y, 0), 1, `round ${round}: exactly one seat across both projects (${assigned})`);
    assert.equal(Object.keys(m.slots()).length, 1);
    const [holder] = Object.values(m.slots());
    const winner = holder.slug === 'alpha' ? a : b;
    winner.good(['dryad', 'report', holder.id, '--status', 'done']);
    winner.good(['dryad', 'finish', holder.id, '--apply']);
  }
});

test('stale reservations are reclaimed without touching a live seat; unmanaged seats are shown, never counted', (t) => {
  const m = machine(t);
  const a = m.project('alpha');
  assert.equal(m.cli(['forester', 'machine', '--parallel', '2', '--apply']).status, 0);
  // A seat nobody reserved: planned by hand, outside Forester.
  a.good(['dryad', 'plan', 'stray', '--task', 'by hand', '--apply']);
  // A reservation whose owner died before it seated anything, and one for a
  // project that does not exist here.
  const file = slotsPath(m.environment);
  writeFileSync(file, stringify({ version: 1, slots: {
    'alpha/alpha-two': { slug: 'alpha', id: 'alpha-two', pid: 2147483646, host: hostname(), at: '2026-09-10T00:00:00.000Z' },
    'ghost/ghost-one': { slug: 'ghost', id: 'ghost-one', pid: 2147483645, host: hostname(), at: '2026-09-10T00:00:00.000Z' },
    'alpha/alpha-three': { slug: 'alpha', id: 'alpha-three', pid: process.pid, host: hostname(), at: new Date().toISOString() },
  } }));
  const view = machineView({ slug: 'alpha', environment: m.environment });
  assert.deepEqual(view.stale.map((row) => row.key).sort(), ['alpha/alpha-two', 'ghost/ghost-one'], 'dead owners with no seat are stale');
  assert.deepEqual(view.held.map((row) => row.id), ['alpha-three'], 'a live owner between reservation and plan still holds its slot');
  assert.deepEqual(view.unmanaged, [{ slug: 'alpha', id: 'stray' }]);
  assert.equal(view.held_by_others, 0, 'stale reservations hold nothing');
  assert.match(m.cli(['forester', 'machine']).stdout, /unmanaged 1 live seat no reservation names \(shown, not counted\)\n    alpha\/stray/);

  // An in-flight reservation is bounded in time, and one whose seat was
  // finished after it was taken is stale even while its owner lives: a
  // serve daemon reserves, plans, and outlives the seat (seen 2026-09-10).
  const old = { slug: 'alpha', id: 'alpha-one', pid: process.pid, host: hostname(), at: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
  writeFileSync(file, stringify({ version: 1, slots: { 'alpha/alpha-one': old, 'alpha/alpha-three': { slug: 'alpha', id: 'alpha-three', pid: process.pid, host: hostname(), at: new Date().toISOString() } } }));
  assert.deepEqual(machineView({ slug: 'alpha', environment: m.environment }).stale.map((row) => row.key), ['alpha/alpha-one'], 'ten minutes is past in flight');
  a.good(['dryad', 'plan', 'alpha-one', '--task', 'by hand', '--apply']);
  a.good(['dryad', 'finish', 'alpha-one', '--apply']);
  writeFileSync(file, stringify({ version: 1, slots: { 'alpha/alpha-one': { ...old, at: new Date(Date.now() - 1000).toISOString() } } }));
  assert.deepEqual(machineView({ slug: 'alpha', environment: m.environment }).held, [], 'a seat finished after the reservation was taken releases it although the reserving process lives');
  // serve drops it each poll instead of waiting for the next allocation.
  assert.deepEqual(reclaimStaleSlots({ environment: m.environment }).dropped, ['alpha/alpha-one']);
  assert.deepEqual(m.slots(), {});
  assert.deepEqual(reclaimStaleSlots({ environment: m.environment }).dropped, []);
  writeFileSync(file, stringify({ version: 1, slots: {
    'alpha/alpha-two': { slug: 'alpha', id: 'alpha-two', pid: 2147483646, host: hostname(), at: '2026-09-10T00:00:00.000Z' },
    'ghost/ghost-one': { slug: 'ghost', id: 'ghost-one', pid: 2147483645, host: hostname(), at: '2026-09-10T00:00:00.000Z' },
    'alpha/alpha-three': { slug: 'alpha', id: 'alpha-three', pid: process.pid, host: hostname(), at: new Date().toISOString() },
  } }));

  const reserved = reserveSlots({ slug: 'alpha', ids: ['alpha-one', 'alpha-two', 'alpha-three'], environment: m.environment });
  assert.deepEqual(reserved.granted, ['alpha-one', 'alpha-three'], 'the in-flight reservation is kept, one more fits, the third is refused');
  assert.deepEqual(reserved.refused.map((row) => row.id), ['alpha-two']);
  assert.deepEqual(Object.keys(m.slots()).sort(), ['alpha/alpha-one', 'alpha/alpha-three'], 'stale entries dropped, new ones written');
  assert.equal(a.json(['dryad', 'status']).seats.find((seat) => seat.id === 'stray').status, 'planned', 'the unmanaged seat is untouched');
  // A pure allocation sees the machine as loadForester hands it in.
  const rows = [{ id: 'x', state: 'ready', owns: [] }, { id: 'y', state: 'ready', owns: [] }];
  const out = allocate({ items: rows, budget: { parallel: 5 }, machine: { parallel: 2, held_by_others: 1 } });
  assert.deepEqual(out.chosen.map((item) => item.id), ['x']);
  assert.deepEqual(out.held, [{ id: 'y', reason: 'machine cap full (2; 1 held by other projects)' }]);
});
