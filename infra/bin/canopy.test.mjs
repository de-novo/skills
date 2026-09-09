import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { stringify } from 'yaml';
import { cliJson, collectState, renderPage, renderState, startCanopy } from '../lib/canopy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const PROJECTS = path.join(HERE, 'fixtures/canopy-projects.mjs');
const RUNNER = path.join(HERE, 'fixtures/canopy-runner.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'canopy-')));
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
    const slug = `canopy-${index}`;
    const baseline = path.join(root, slug);
    mkdirSync(path.join(baseline, '.agents'), { recursive: true });
    const dryad = { version: 1, worktrees: { root: `../seats-${index}`, branch: 'dryad/{id}' } };
    if (overlay) {
      writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify({
        project: { slug }, services: { api: {} }, data: { infra: 'project' },
        addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
        runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } },
        overlay: { attachable: ['api'], stale_after: '1h' },
      }));
    } else dryad.project = { slug };
    writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify(dryad));
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Canopy Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: baseline, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    run(['dryad', 'plan', 'w1', '--task', 'Read-only overview', '--by', 'worker', '--apply', '--project', baseline]);
    run(['dryad', 'report', 'w1', '--status', 'blocked', '--note', 'Waiting <script>alert(1)</script>', '--session', 'session-fixture', '--project', baseline]);
    // Exercise the public finished archive with a disposable no-overlay seat.
    if (!overlay) {
      run(['dryad', 'plan', 'w2', '--task', 'Archived task', '--apply', '--project', baseline]);
      run(['dryad', 'report', 'w2', '--status', 'done', '--note', 'Archive journal proof', '--session', 'archive-session', '--project', baseline]);
      run(['dryad', 'finish', 'w2', '--apply', '--project', baseline]);
    }
    return { slug, root: baseline, root_present: true, seats: 1, finished: overlay ? 0 : 1, overlay, updated_at: new Date().toISOString() };
  });
  environment.CANOPY_TEST_PROJECTS = JSON.stringify(projects);
  return { root, projects, environment, projectsCli: PROJECTS, run };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

test('--once aggregates real seated projects, Grove, problems and finished journals', async (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [RUNNER, '--once'], { env: f.environment, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.projects.length, 2);
  assert.equal(state.projects.reduce((n, p) => n + p.seats.length, 0), 2);
  assert.equal(state.projects[0].counts.worktrees_present, 1);
  assert.deepEqual(state.projects.map(p => p.problems), [['w1: blocked'], ['w1: blocked']]);
  assert.equal(state.projects[0].finished.length, 1);
  assert.ok(state.projects[0].finished[0].journal.some(entry => entry.detail.includes('Archive journal proof')));
  assert.equal(state.projects[1].grove.counts.environments, 1);
  assert.equal(state.projects[1].grove.project_status.ok, true);
  assert.equal(state.projects[1].seats[0].env_state, 'tracked');
  // Compare rendered counts to the public status values, without registry access.
  assert.equal(state.projects[1].counts.envs_tracked, 1);
  t.diagnostic('projects 2/2; live seats 2/2; finished seats 1/1; propagated problems 2/2; process overlay environments 1/1');
});

test('GET / and /api/state serve real CLI reports over an ephemeral loopback socket', async (t) => {
  const f = fixture(t);
  const server = await startCanopy({ ...f, port: 0 });
  t.after(() => closeServer(server));
  assert.equal(server.address().address, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  const firstRender = html.split('<script>')[0];
  // The header carries every count in one line; with the worktrees seam live
  // it names unseated worktrees and overlaps too.
  assert.match(firstRender, /seats 1 · worktrees 2 \(1 unseated\) · envs 1\/1 · overlaps 0/);
  assert.match(firstRender, /Waiting &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(firstRender, /Archive journal proof/);
  assert.match(firstRender, /<summary>finished 1<\/summary>/);
  assert.doesNotMatch(firstRender, /<details[^>]* open/);
  assert.match(firstRender, /session-fixture/);
  const stateResponse = await fetch(url + '/api/state');
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).projects.length, 2);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/missing')).status, 404);
  t.diagnostic('real socket: HTML + JSON 2/2; server-rendered project sections 2/2; write/unknown routes refused 2/2');
});

test('canopy CLI keeps its server alive, prints its URL and shuts down on SIGTERM', async (t) => {
  const child = spawn(process.execPath, [CLI, 'canopy', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('URL not printed')), 5000);
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  assert.equal((await fetch(url)).status, 200);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('canopy refuses --host including non-loopback and equals syntax', () => {
  for (const args of [['--host', '0.0.0.0'], ['--host=192.0.2.1'], ['--host', '127.0.0.1']]) {
    const result = spawnSync(process.execPath, [CLI, 'canopy', ...args, '--once'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--host is refused.*127\.0\.0\.1/);
  }
});

test('canopy validates ports and unknown arguments at the CLI boundary', () => {
  for (const args of [['--port'], ['--port', '-1'], ['--port', '65536'], ['--port', '1.5'], ['--port', 'abc'], ['unexpected']]) {
    const result = spawnSync(process.execPath, [CLI, 'canopy', ...args, '--once'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canopy:/);
  }
});

test('CLI failures, malformed JSON, timeouts and excess output become error documents', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'canopy-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'cli.mjs');
  for (const [source, pattern, timeoutMs] of [
    ['console.log("not JSON"); process.exitCode = 1;', /invalid JSON/, 2000],
    ['console.log("null")', /invalid JSON/, 2000],
    ['setInterval(() => {}, 1000)', /timed out/, 100],
    ['console.log("x".repeat(5 * 1024 * 1024))', /output limit/, 2000],
  ]) {
    writeFileSync(script, source);
    const started = Date.now();
    assert.match((await cliJson(['status'], { cli: script, timeoutMs })).error, pattern);
    assert.ok(Date.now() - started < timeoutMs + 1500, 'subprocess timeout is bounded');
  }
  const result = await collectState({ projectsCli: '/missing/canopy-cli.mjs' });
  assert.equal(result.projects.length, 0);
  assert.match(result.error, /invalid JSON/);
  // Valid discovery + missing root must isolate the failure to that project.
  const environment = { ...process.env, CANOPY_TEST_PROJECTS: JSON.stringify([{ slug: 'missing', root: path.join(root, 'absent'), root_present: false, seats: 0, finished: 0, overlay: true, updated_at: null }]) };
  const state = await collectState({ projectsCli: PROJECTS, environment });
  assert.equal(state.projects.length, 1);
  assert.ok(state.projects[0].error);
  assert.ok(state.projects[0].grove.error);
  assert.ok(state.projects[0].finished_error);
});

test('renderer preserves pending liveness, hostnames and null measurements without active markup', () => {
  const state = { updated_at: '2026-01-01T00:00:00Z', projects: [{
    slug: 'example', root: '/example', overlay: true,
    counts: { seats: 1, worktrees_present: 1, envs_tracked: 1, envs_wanted: 1, envs_in_flight: 1, reported: { working: 1 } },
    seats: [{ id: 'w1', branch: 'task', ahead: 2, env: 'w1', env_state: 'in-flight', status: 'working', by: 'worker', session: '<session>', journal: [], hostnames: ['api--w1.example.localhost', 'https://example.invalid/path', 'javascript://example.invalid', 'http://user:pass@example.invalid'], activity: { state: 'running', doing: 'Edit <src>/x.ts', changed_at: new Date().toISOString() } }],
    finished: [], problems: ['<unsafe>'], grove: { counts: { environments: 1, attachments: 1, pending: 2, stale: null, drift: null }, pending: [{ env: 'w1', verb: 'attach', liveness: 'in-flight' }, { env: 'w2', verb: 'create', liveness: 'stalled' }] },
  }] };
  const html = renderPage(state).split('<script>')[0];
  assert.match(html, /envs 1\/1/);
  assert.match(html, /w1 attach in-flight/);
  assert.match(html, /w2 create stalled/);
  assert.match(html, /stale notMeasured · drift notMeasured/);
  assert.match(html, /href="http:\/\/api--w1.example.localhost\/"/);
  assert.match(html, /href="https:\/\/example.invalid\/path"/);
  assert.doesNotMatch(html, /href="javascript:|href="http:\/\/user:pass/);
  assert.match(html, /&lt;session&gt;/);
  assert.match(html, /problem · &lt;unsafe&gt;/);
  assert.equal((html.match(/<article class="card seat"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="files"|class="overlap"|undefined/);
  assert.match(html, /<p class="doing">now Edit &lt;src&gt;\/x\.ts · running · /, 'the card says what the session is doing, escaped');
});


test('second-screen --once and socket first paint agree on worktrees, skills, files and overlaps', async (t) => {
  const environment = { ...process.env, CANOPY_TEST_SCREEN: '1', CANOPY_TEST_PROJECTS: JSON.stringify([{ slug: 'example', root: '/fixture/main', overlay: true }]) };
  const result = spawnSync(process.execPath, [RUNNER, '--once'], { env: environment, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const aggregate = JSON.parse(result.stdout).projects[0];
  assert.equal(aggregate.worktrees.length, 3);
  assert.deepEqual(aggregate.overlaps, [{ path: 'shared.txt', seats: ['w1', 'w2'] }]);
  assert.equal(aggregate.seats[0].changes.counts.committed, 14);
  assert.equal(aggregate.seats[0].journal.at(-1).event, 'cli');
  assert.equal(aggregate.seats[0].hostnames[1].attached, false);
  const server = await startCanopy({ port: 0, cli: PROJECTS, projectsCli: PROJECTS, environment });
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url)).text();
  const first = html.split('<script>')[0];
  const project = (await (await fetch(url + '/api/state')).json()).projects[0];
  assert.equal((first.match(/<article class="card /g) ?? []).length, project.worktrees.length);
  assert.equal((first.match(/class="overlap"/g) ?? []).length, project.overlaps.length);
  assert.match(first, /example — seats 2 · worktrees 3 \(1 unseated\) · envs 2\/2 · overlaps 1/);
  assert.match(first, /Grove · environments 2 · attachments 2 · pending 1 · w1 attach in-flight · stale 0 · drift 0/);
  assert.ok(first.indexOf('class="grove"') < first.indexOf('problem · w1: attachment pending'));
  assert.ok(first.indexOf('data-seat="w2"') < first.indexOf('data-seat="w1"'));
  assert.ok(first.indexOf('data-seat="w1"') < first.indexOf('class="card unseated"'));
  const cards = [...first.matchAll(/<article class="card seat"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, 2);
  for (let i = 0; i < cards.length; i++) {
    const seat = project.seats[1 - i];
    const card = cards[i][1];
    assert.ok(card.includes(`+${seat.changes.counts.committed} committed · ${seat.changes.counts.uncommitted} open`));
    assert.match(card, /skills · plan 1 · report 1 · cli 1/);
    assert.ok(card.includes(`working · Report ${seat.id}`));
    assert.match(card, /last cli · 2026-09-07T/);
    assert.match(card, /<time datetime="2026-09-07T/);
    assert.match(card, /<ul><li class="shared">.*shared.txt/);
    assert.ok(card.includes(`href="http://api--${seat.id}.example.localhost/"`));
    assert.ok(card.includes(`web--${seat.id}.example.localhost <span class="muted">(unattached)</span>`));
    assert.ok(!card.includes(`href="http://web--${seat.id}`));
  }
  assert.equal((cards[1][1].match(/<li/g) ?? []).length, 12);
  assert.match(cards[1][1], /3 more files/);
  assert.doesNotMatch(first, /Hidden second task line/);
  const unseated = first.match(/<article class="card unseated">([\s\S]*?)<\/article>/)[1];
  assert.match(unseated, /Not a seat/);
  assert.match(unseated, /main/);
  assert.match(unseated, /HEAD 1234567/);
  assert.doesNotMatch(unseated, /class="files"|skills/);
  t.diagnostic('fixture socket first paint: worktree cards 3/3; overlap lines 1/1; seat file counts 2/2; unattached hosts unlinked 2/2; file cap 12/12');
});

test('a long report note is cut on the card and never printed twice in one card', () => {
  const note = `NOTEMARK${'x'.repeat(400)}`;
  const at = new Date().toISOString();
  const html = renderState({
    updated_at: at,
    projects: [{
      slug: 'clip', root: '/tmp/clip', counts: { seats: 1 },
      seats: [{ id: 'w1', by: 'worker', status: 'done', branch: 'dryad/w1', worktree: '/tmp/clip/w1',
        journal: [{ at, actor: 'seat', event: 'report', detail: `done: ${note}` }] }],
    }],
  });
  assert.doesNotMatch(html, new RegExp('x'.repeat(300)), 'the note is cut');
  assert.match(html, /…/);
  assert.equal((html.match(/NOTEMARK/g) ?? []).length, 1, 'the same note is not repeated on one card');

});

test('/chat/<slug>/<id> renders the seat\'s transcript as turns, escaped, and refuses a seat or transcript that is not there', async (t) => {
  const f = fixture(t);
  const server = await startCanopy({ ...f, port: 0 });
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Before any tool has named a transcript, the seat has no chat and the card has no link.
  assert.equal((await fetch(url + '/chat/canopy-0/w1')).status, 404);
  assert.doesNotMatch((await (await fetch(url)).text()).split('<script>')[0], /href="\/chat\//);
  // A Claude Code transcript, as the tool writes it, and an events file that names it.
  const transcript = path.join(f.root, 'w1.jsonl');
  const at = new Date().toISOString();
  writeFileSync(transcript, [
    JSON.stringify({ type: 'custom-title', title: 'ignored' }),
    JSON.stringify({ type: 'system', timestamp: at, message: { content: [{ type: 'text', text: 'ignored system note' }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: 'Add POST /notes <b>' } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the api first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'app/api/server.mjs' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'const server = createServer(...)' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done: POST /notes added.' }] } }),
  ].join('\n') + '\n');
  const events = path.join(f.environment.GROVE_STATE_DIR, 'dryads/events/canopy-0/w1.events');
  mkdirSync(path.dirname(events), { recursive: true });
  writeFileSync(events, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: transcript, tool_name: 'Read', tool_input: { file_path: 'app/api/server.mjs' } }) + '\n');
  const page = await fetch(url + '/chat/canopy-0/w1');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div class="turn user">.*Add POST \/notes &lt;b&gt;/s);
  assert.match(html, /<div class="turn assistant">.*Reading the api first\./s);
  assert.match(html, /<details class="tool"><summary>Read app\/api\/server\.mjs<\/summary>/);
  assert.match(html, /<pre class="result">const server = createServer/);
  assert.match(html, /Done: POST \/notes added\./);
  assert.doesNotMatch(html, /ignored/);
  assert.match(html, /now Read app\/api\/server\.mjs · running · 4 turns/);
  // The card now links to it.
  assert.match((await (await fetch(url)).text()).split('<script>')[0], /href="\/chat\/canopy-0\/w1">chat<\/a>/);
  assert.equal((await fetch(url + '/chat/canopy-0/nope')).status, 404);
  writeFileSync(events, JSON.stringify({ hook_event_name: 'PreToolUse', transcript_path: path.join(f.root, 'gone.jsonl'), tool_name: 'Read', tool_input: {} }) + '\n');
  const gone = await fetch(url + '/chat/canopy-0/w1');
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /not there/);
});

test('/diff/<slug>/<id> shows the seat\'s patch from dryad diff, per file, escaped, and links both ways with the chat page', async (t) => {
  const f = fixture(t);
  const server = await startCanopy({ ...f, port: 0 });
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  const seatRoot = path.join(f.root, 'seats-0', 'w1');
  writeFileSync(path.join(seatRoot, 'notes.md'), '# notes\n\n<script>alert(1)</script> added\n');
  const page = await fetch(url + '/diff/canopy-0/w1');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /untracked: notes\.md/, 'a new file is untracked until git knows it');
  assert.doesNotMatch(html, /<script>alert/);
  const tracked = spawnSync('git', ['-C', seatRoot, 'add', 'notes.md'], { encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const staged = await (await fetch(url + '/diff/canopy-0/w1')).text();
  assert.match(staged, /<summary>notes\.md<\/summary>/);
  assert.match(staged, /<span class="add">\+&lt;script&gt;alert\(1\)&lt;\/script&gt; added<\/span>/);
  assert.match(staged, /1 file changed since/);
  assert.match(staged, /href="\/chat\/canopy-0\/w1"/);
  assert.match((await (await fetch(url)).text()).split('<script>')[0], /href="\/diff\/canopy-0\/w1">diff<\/a>/);
  assert.equal((await fetch(url + '/diff/canopy-0/nope')).status, 404);
});
