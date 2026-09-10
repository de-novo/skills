// What a Canopy view costs, counted: one status and one bounded archive
// read per project and no second Grove probe, because Dryad's status
// carries the one observation it made; a detail page reads one seat of
// one project; a long archive is shown newest-first with its total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { collectSeat, collectState, renderState, startCanopy } from '../lib/canopy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const PROJECTS = path.join(HERE, 'fixtures/canopy-projects.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'canopy-cost-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state'), GROVE_PROCESS_TEST_ROOT: root };
  delete environment.DRYAD_PROJECT;
  writeFileSync(path.join(root, 'process-test-marker'), 'owned fixture');
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: environment, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const projects = [false, true].map((overlay, index) => {
    const slug = `cost-${index}`;
    const baseline = path.join(root, slug);
    mkdirSync(path.join(baseline, '.agents'), { recursive: true });
    const dryad = { version: 1, worktrees: { root: `../seats-${index}`, branch: 'dryad/{id}' } };
    if (overlay) {
      writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify({
        project: { slug }, services: { api: {} }, data: { infra: 'project' },
        addressing: { tld: 'localhost', scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
        runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } },
        overlay: { attachable: ['api'], stale_after: '1h' },
      }));
    } else dryad.project = { slug };
    writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify(dryad));
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Cost Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: baseline, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    run(['dryad', 'plan', 'w1', '--task', 'Counted', '--by', 'worker', '--apply', '--project', baseline]);
    return { slug, root: baseline, root_present: true, seats: 1, finished: 0, overlay, updated_at: new Date().toISOString() };
  });
  // A long archive for the first project: 25 finished records, written as
  // Dryad writes them, so the newest-first tail and the total can be read.
  const record = (n) => ({ id: `old-${n}`, finished_at: `2026-09-0${1 + (n % 9)}T00:00:${String(n).padStart(2, '0')}.000Z`, worktree: `/gone/${n}`, owned: true, branch: `dryad/old-${n}`, base: 'a'.repeat(40), task: `old ${n}`, env: null, by: 'worker', session: null, created_at: '2026-09-01T00:00:00.000Z', status: 'done', journal: [{ at: '2026-09-01T00:00:00.000Z', actor: 'seat', event: 'report', detail: `done: old ${n}` }] });
  writeFileSync(path.join(root, 'state/dryads/cost-0.finished.yml'), stringify({ version: 1, project: 'cost-0', seats: Array.from({ length: 25 }, (_, n) => record(n)) }));
  environment.CANOPY_TEST_PROJECTS = JSON.stringify(projects);
  return { root, projects, environment, projectsCli: PROJECTS, run };
}

test('a full view costs one status and one bounded archive read per project; Grove is not asked twice', async (t) => {
  const f = fixture(t);
  const trace = [];
  const state = await collectState({ ...f, trace });
  assert.equal(state.projects.length, 2);
  const calls = trace.map((line) => line.split(' --project ')[0]);
  assert.deepEqual(calls.filter((line) => line.startsWith('overlay status')), [], 'no second Grove probe: dryad status carries the report');
  assert.equal(calls.filter((line) => line === 'dryad status --json').length, 2);
  assert.equal(calls.filter((line) => line === 'dryad status --finished --json --tail 20').length, 2);
  assert.equal(trace.length, 5, 'discovery + two per project');
  const overlayProject = state.projects.find((p) => p.slug === 'cost-1');
  assert.equal(overlayProject.grove.observed_by, 'dryad status');
  assert.equal(overlayProject.grove.counts.environments, 1);
  assert.equal(overlayProject.grove.project_status.ok, true);
  const long = state.projects.find((p) => p.slug === 'cost-0');
  assert.deepEqual({ shown: long.finished.length, total: long.finished_total, partial: long.finished_partial }, { shown: 20, total: 25, partial: true });
  assert.equal(long.finished[0].id, 'old-5', 'the newest twenty, in archive order');
  assert.match(renderState(state), /<summary>finished 20 of 25 \(newest\)<\/summary>/);
});

test('a detail page reads one seat of one project, not every project on the machine', async (t) => {
  const f = fixture(t);
  const trace = [];
  const one = await collectSeat({ slug: 'cost-1', id: 'w1' }, { ...f, trace });
  assert.equal(one.seat.id, 'w1');
  assert.deepEqual(trace.map((line) => line.split(' --project ')[0]), ['dryad projects --json', 'dryad status w1 --json']);
  assert.match(one.observed_at, /^\d{4}-/);
  assert.match((await collectSeat({ slug: 'nope', id: 'w1' }, f)).error, /no project nope/);
  assert.match((await collectSeat({ slug: 'cost-0', id: 'w9' }, f)).error, /not registered|no seat/);

  const pageTrace = [];
  const server = await startCanopy({ ...f, trace: pageTrace, port: 0 });
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const diff = await fetch(url + '/diff/cost-0/w1');
  assert.equal(diff.status, 200);
  assert.deepEqual(pageTrace.map((line) => line.split(' --project ')[0]), ['dryad projects --json', 'dryad status w1 --json', 'dryad diff w1'], 'discovery, one seat, one diff');
  pageTrace.length = 0;
  assert.equal((await fetch(url + '/chat/cost-0/w1')).status, 404);
  assert.deepEqual(pageTrace.map((line) => line.split(' --project ')[0]), ['dryad projects --json', 'dryad status w1 --json']);
});
