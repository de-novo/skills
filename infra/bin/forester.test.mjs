import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import {
  allocate,
  claimSegments,
  claimsIntersect,
  itemStates,
  parseForesterCliArgs,
  parseForesterLocal,
  parseForesterPlan,
  resolveBudget,
} from '../lib/forester.mjs';
import { claudeSettings, launchCommand, screenAsksForInput, seedClaudeTrust, stateFromEvents } from '../lib/forester-serve.mjs';
import { HOOK_MARKER, applyHooks, hookStores, renderStore } from '../lib/forester-hooks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const TOOL = path.join(HERE, 'fixtures/forester-tool.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = `version: 1
tasks:
  define-shape:
    task: "Decide the response shape and write it into the reference"
    owns: [docs/reference/**]
  api-endpoint:
    task: "Add the endpoint returning that shape"
    owns: [src/api/**]
    depends_on: [define-shape]
  web-panel:
    task: "Show it in the page"
    owns: [src/web/**]
    depends_on: [define-shape]
    retry: { max_attempts: 2 }
  docs-pass:
    task: "Sweep the docs"
    owns: [docs/**]
`;

function gitIn(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Forester Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A disposable baseline with Grove (overlay: none) and Dryad profiles, its
// own state directory, and a plan. No overlay backend: allocation is the
// thing under test, seats are real Dryad worktrees.
function fixture(t, { plan = PLAN, local = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'forester-')));
  const baseline = path.join(root, 'baseline');
  mkdirSync(path.join(baseline, '.agents'), { recursive: true });
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  delete environment.DRYAD_ID;
  writeFileSync(path.join(baseline, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'forester-test' }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none' }));
  writeFileSync(path.join(baseline, '.agents/dryad-profile.yml'), stringify({ version: 1, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(baseline, '.agents/forester-plan.yml'), plan);
  if (local != null) writeFileSync(path.join(baseline, '.agents/forester.local.yml'), local);
  writeFileSync(path.join(baseline, 'app.txt'), 'baseline\n');
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, baseline, environment, run, good, bad, json };
}

test('plan parser accepts the documented shape and names the offending item on every rejection', () => {
  const plan = parseForesterPlan(PLAN);
  assert.equal(plan.parallel, null);
  assert.deepEqual(plan.tasks.map((item) => item.id), ['define-shape', 'api-endpoint', 'web-panel', 'docs-pass']);
  assert.deepEqual(plan.tasks[1].dependsOn, ['define-shape']);
  assert.deepEqual(plan.tasks[2].retry, { maxAttempts: 2 });
  assert.deepEqual(plan.tasks[3].retry, { maxAttempts: 1 });
  assert.equal(parseForesterPlan('version: 1\nparallel: 2\ntasks:\n  a: { task: x }\n').parallel, 2);

  const rejected = [
    ['version: 2\ntasks:\n  a: { task: x }\n', /version must be 1/],
    ['version: 1\nqueue: []\ntasks:\n  a: { task: x }\n', /unknown key "queue"/],
    ['version: 1\ntasks: []\n', /tasks must be a map/],
    ['version: 1\ntasks: {}\n', /at least one item/],
    ['version: 1\ntasks:\n  Bad_Id: { task: x }\n', /item id "Bad_Id"/],
    ['version: 1\ntasks:\n  a: { task: "" }\n', /tasks\.a\.task must be a non-empty string/],
    ['version: 1\ntasks:\n  a: { task: x, files: [y] }\n', /tasks\.a has unknown key "files"/],
    ['version: 1\ntasks:\n  a: { task: x, depends_on: [b] }\n', /tasks\.a depends on unknown item "b"/],
    ['version: 1\ntasks:\n  a: { task: x, depends_on: [a] }\n', /tasks\.a depends on itself/],
    ['version: 1\ntasks:\n  a: { task: x, depends_on: [c] }\n  b: { task: x, depends_on: [a] }\n  c: { task: x, depends_on: [b] }\n', /dependency cycle a -> c -> b -> a/],
    ['version: 1\ntasks:\n  a: { task: x }\n  a: { task: y }\n', /a/],
    ['version: 1\ntasks:\n  a: { task: x, retry: { max_attempts: 0 } }\n', /retry\.max_attempts must be an integer of at least 1/],
    ['version: 1\ntasks:\n  a: { task: x, retry: { until: ok } }\n', /tasks\.a\.retry has unknown key "until"/],
    ['version: 1\nparallel: 0\ntasks:\n  a: { task: x }\n', /parallel must be an integer of at least 1/],
  ];
  for (const [text, pattern] of rejected) assert.throws(() => parseForesterPlan(text), pattern, text);
});

test('the budget is the plan first, the local file second, and an error third', () => {
  assert.deepEqual(parseForesterLocal('version: 1\nparallel: 5\n'), { version: 1, parallel: 5, tool: null, tools: {} });
  const withTools = parseForesterLocal('version: 1\nparallel: 1\ntool: claude\ntools:\n  claude: { command: [claude, "{task}"] }\n  codex: { command: [codex, "{task}"] }\n');
  assert.deepEqual(withTools, { version: 1, parallel: 1, tool: 'claude', tools: { claude: { command: ['claude', '{task}'] }, codex: { command: ['codex', '{task}'] } } });
  assert.throws(() => parseForesterLocal('version: 1\nengines: {}\n'), /unknown key "engines"/);
  assert.throws(() => parseForesterLocal('version: 1\ntool: grok\ntools: {}\n'), /tool "grok" is not declared under tools/);
  assert.throws(() => parseForesterLocal('version: 1\ntools:\n  claude: { command: [] }\n'), /tools\.claude\.command must name the executable/);
  assert.throws(() => parseForesterLocal('version: 1\ntools:\n  claude: { command: [claude], mode: headless }\n'), /tools\.claude has unknown key "mode"/);
  const files = { planFile: '/p/.agents/forester-plan.yml', localFile: '/p/.agents/forester.local.yml' };
  assert.deepEqual(resolveBudget({ plan: { parallel: 2 }, local: { parallel: 5 }, ...files }), { parallel: 2, source: 'plan' });
  assert.deepEqual(resolveBudget({ plan: { parallel: null }, local: { parallel: 5 }, ...files }), { parallel: 5, source: 'local' });
  assert.throws(() => resolveBudget({ plan: { parallel: null }, local: null, ...files }), /no budget: set parallel in \/p\/.agents\/forester-plan.yml or in \/p\/.agents\/forester.local.yml/);
});

test('claims intersect by literal path segments, conservatively past the first wildcard', () => {
  assert.deepEqual(claimSegments('src/api/**'), ['src', 'api']);
  assert.deepEqual(claimSegments('./docs/reference/'), ['docs', 'reference']);
  assert.deepEqual(claimSegments('src/**/*.test.mjs'), ['src']);
  assert.deepEqual(claimSegments('src/api*'), ['src']);
  assert.equal(claimsIntersect('src/api/**', 'src/web/**'), false);
  assert.equal(claimsIntersect('docs/**', 'docs/reference/**'), true);
  assert.equal(claimsIntersect('src/**/*.test.mjs', 'src/api/**'), true);
  assert.equal(claimsIntersect('src/api', 'src/api-v2/**'), false);
  assert.equal(claimsIntersect('README.md', 'README.md'), true);
});

test('item states and allocation are a pure function of plan, seats, and budget', () => {
  const plan = parseForesterPlan(PLAN);
  const empty = { seats: {} };
  const none = { seats: [] };
  const states = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.state]));

  let rows = itemStates({ plan, state: empty, finished: none });
  assert.deepEqual(states(rows), { 'define-shape': 'ready', 'api-endpoint': 'blocked', 'web-panel': 'blocked', 'docs-pass': 'ready' });
  let out = allocate({ items: rows, budget: { parallel: 3 } });
  assert.deepEqual(out.chosen.map((item) => item.id), ['define-shape']);
  assert.deepEqual(out.held, [{ id: 'docs-pass', reason: 'claim docs/** intersects docs/reference/** of define-shape (ready)' }]);

  rows = itemStates({ plan, state: { seats: { 'define-shape': { status: 'working', worktree: '/w', env: null } } }, finished: none });
  assert.deepEqual(states(rows), { 'define-shape': 'active', 'api-endpoint': 'blocked', 'web-panel': 'blocked', 'docs-pass': 'ready' });
  out = allocate({ items: rows, budget: { parallel: 3 } });
  assert.deepEqual(out.chosen, []);
  assert.equal(out.held[0].reason, 'claim docs/** intersects docs/reference/** of define-shape (active)');

  rows = itemStates({ plan, state: { seats: { 'define-shape': { status: 'done', worktree: '/w', env: null } } }, finished: none });
  assert.deepEqual(states(rows), { 'define-shape': 'done', 'api-endpoint': 'ready', 'web-panel': 'ready', 'docs-pass': 'ready' });
  out = allocate({ items: rows, budget: { parallel: 2 } });
  assert.deepEqual(out.chosen.map((item) => item.id), ['api-endpoint', 'web-panel']);
  assert.deepEqual(out.held, [{ id: 'docs-pass', reason: 'budget full (2)' }]);
  assert.deepEqual({ active: out.active, free: out.free }, { active: 0, free: 2 });

  const finished = { seats: [{ id: 'define-shape', status: 'done' }, { id: 'docs-pass', status: 'blocked' }, { id: 'web-panel', status: 'working' }] };
  rows = itemStates({ plan, state: empty, finished });
  assert.deepEqual(states(rows), { 'define-shape': 'done', 'api-endpoint': 'ready', 'web-panel': 'ready', 'docs-pass': 'failed' });
  assert.equal(rows.find((row) => row.id === 'docs-pass').why, '1/1 attempt finished without done');
  assert.equal(rows.find((row) => row.id === 'web-panel').attempts, 1);
  rows = itemStates({ plan, state: empty, finished: { seats: [...finished.seats, { id: 'web-panel', status: 'planned' }] } });
  assert.equal(rows.find((row) => row.id === 'web-panel').state, 'failed');
});

test('cli args accept the seven verbs, and only attach takes a positional', () => {
  assert.deepEqual(parseForesterCliArgs(['assign', '--apply', '--project', '/p']), { help: false, verb: 'assign', project: '/p', json: false, apply: true, remove: false, id: null });
  assert.equal(parseForesterCliArgs(['attach', 'web-panel']).id, 'web-panel');
  assert.throws(() => parseForesterCliArgs(['attach']), /attach requires a seat id/);
  assert.throws(() => parseForesterCliArgs(['attach', 'a', 'b']), /attach takes one seat id/);
  assert.throws(() => parseForesterCliArgs(['serve', '--json']), /--json is not valid for serve/);
  assert.equal(parseForesterCliArgs(['hooks', '--remove', '--apply']).remove, true);
  assert.throws(() => parseForesterCliArgs(['hooks', '--project', '/p']), /--project is not valid for hooks/);
  assert.equal(parseForesterCliArgs([]).help, true);
  assert.throws(() => parseForesterCliArgs(['plan', 'x']), /takes no positional/);
  assert.throws(() => parseForesterCliArgs(['plan', '--apply']), /--apply is not valid for plan/);
  assert.throws(() => parseForesterCliArgs(['seat']), /unknown command "seat"/);
  assert.throws(() => parseForesterCliArgs(['next', '--project']), /--project requires a value/);
});

test('assign --apply seats exactly the budget through Dryad, and a done report frees exactly one slot', (t) => {
  const f = fixture(t, { local: 'version: 1\nparallel: 2\n' });
  let plan = f.json(['forester', 'plan']);
  assert.deepEqual(plan.budget, { parallel: 2, source: 'local' });
  assert.deepEqual(plan.next, ['define-shape']);
  assert.match(f.good(['forester', 'plan']).stdout, /items 4 · done 0 · active 0 · ready 2 · blocked 2 · failed 0/);
  assert.match(f.good(['forester', 'next']).stdout, /would assign 1\/2; changes nothing/);

  let out = f.good(['forester', 'assign', '--apply']).stdout;
  assert.match(out, /assigned 1\/1 · slots 1\/2/);
  assert.match(f.good(['dryad', 'status']).stdout, /define-shape/);
  assert.match(f.good(['dryad', 'seat', 'define-shape', '--task']).stdout, /Decide the response shape/);

  // Nothing else can go while define-shape holds docs/reference/**.
  out = f.good(['forester', 'assign', '--apply']).stdout;
  assert.match(out, /assigned 0\/0 · slots 1\/2/);

  f.good(['dryad', 'report', 'define-shape', '--status', 'done', '--note', 'shape written']);
  plan = f.json(['forester', 'plan']);
  assert.equal(plan.items.find((item) => item.id === 'define-shape').state, 'done');
  assert.deepEqual(plan.next, ['api-endpoint', 'web-panel']);
  out = f.good(['forester', 'assign', '--apply']).stdout;
  assert.match(out, /assigned 2\/2 · slots 2\/2/);
  const status = f.good(['forester', 'status']).stdout;
  assert.match(status, /slots    2\/2/);
  assert.match(status, /waiting  1 ready · 0 blocked/);

  // One done report, one slot, one more item — docs-pass, since define-shape's claim is released.
  f.good(['dryad', 'report', 'api-endpoint', '--status', 'done']);
  assert.match(f.good(['forester', 'next']).stdout, /assign  docs-pass/);
  assert.match(f.good(['forester', 'assign', '--apply']).stdout, /assigned 1\/1 · slots 2\/2/);
});

test('the plan budget beats the local one, and no budget is an error naming both files', (t) => {
  const f = fixture(t, { plan: PLAN.replace('version: 1\n', 'version: 1\nparallel: 1\n'), local: 'version: 1\nparallel: 5\n' });
  assert.deepEqual(f.json(['forester', 'status']).budget, { parallel: 1, source: 'plan' });
  const g = fixture(t);
  const result = g.bad(['forester', 'plan']);
  assert.match(result.stderr, /no budget: set parallel in .*forester-plan\.yml or in .*forester\.local\.yml/);
});

test('a seat finished without done spends an attempt; failed shows in status and exits non-zero', (t) => {
  const f = fixture(t, { local: 'version: 1\nparallel: 3\n' });
  f.good(['forester', 'assign', '--apply']);
  f.good(['dryad', 'finish', 'define-shape', '--apply']);
  const plan = f.json(['forester', 'plan']);
  const row = plan.items.find((item) => item.id === 'define-shape');
  assert.deepEqual({ state: row.state, attempts: row.attempts }, { state: 'failed', attempts: 1 });
  const status = f.bad(['forester', 'status']);
  assert.match(status.stdout, /failed   1  define-shape/);
  // web-panel has two attempts: after one finished seat it is ready again.
  f.good(['dryad', 'plan', 'web-panel', '--task', 'manual', '--apply']);
  f.good(['dryad', 'finish', 'web-panel', '--apply']);
  const again = f.json(['forester', 'plan']).items.find((item) => item.id === 'web-panel');
  assert.deepEqual({ state: again.state, attempts: again.attempts }, { state: 'blocked', attempts: 1 });
  // A seat the plan does not name takes no slot but is counted as outside.
  f.good(['dryad', 'plan', 'stray', '--task', 'somebody else', '--apply']);
  // status still exits non-zero here: define-shape is failed.
  const withStray = JSON.parse(f.bad(['forester', 'status', '--json']).stdout);
  assert.deepEqual(withStray.seats_outside_plan, ['stray']);
  assert.equal(withStray.slots.active, 0);
  assert.match(f.bad(['forester', 'status']).stdout, /outside  1 seat not in the plan  stray/);
});

test('launch templates, Claude hook settings, event states, and trust seeding', (t) => {
  const tool = { command: ['claude', '{task}', '--model', 'x'] };
  assert.deepEqual(launchCommand({ toolName: 'claude', tool, task: 'do it', settingsFile: '/s.json' }), { file: 'claude', args: ['do it', '--model', 'x', '--settings', '/s.json'], tool: 'claude' });
  assert.deepEqual(launchCommand({ toolName: 'codex', tool: { command: ['codex', '{task}'] }, task: 'do it', settingsFile: '/s.json' }).args, ['do it']);

  const settings = claudeSettings("/tmp/it's.events");
  assert.deepEqual(Object.keys(settings.hooks), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'Notification']);
  assert.equal(stateFromEvents('{"hook_event_name":"Notification","notification_type":"permission_prompt"}\n{"hook_event_name":"PreToolUse"}\n'), 'running');
  assert.match(settings.hooks.Stop[0].hooks[0].command, /cat >> '\/tmp\/it'\\''s\.events'/);

  assert.equal(stateFromEvents(''), null);
  assert.equal(stateFromEvents('{"hook_event_name":"UserPromptSubmit"}\n'), 'running');
  assert.equal(stateFromEvents('{"hook_event_name":"UserPromptSubmit"}\n{"hook_event_name":"Stop"}\n'), 'idle');
  assert.equal(stateFromEvents('{"hook_event_name":"Stop"}\n{"hook_event_name":"Notification","notification_type":"idle_prompt"}\n'), 'needs-input');
  assert.equal(stateFromEvents('{"hook_event_name":"Stop"}\n{"hook_event_name":"Notification","notification_type":"auth_success"}\n'), 'idle');
  assert.equal(stateFromEvents('not json\n{"hook_event_name":"SessionEnd"}\n'), 'exited');
  // Grok, as recorded on 2026-09-08: camelCase key, snake_case lowercase value.
  assert.equal(stateFromEvents('{"hookEventName":"user_prompt_submit","sessionId":"x"}\n{"hookEventName":"pre_tool_use"}\n'), 'running');
  assert.equal(stateFromEvents('{"hookEventName":"user_prompt_submit"}\n{"hookEventName":"stop","reason":"end_turn"}\n'), 'idle');

  // The screen fallback for a session parked before its first prompt.
  assert.equal(screenAsksForInput('\x1b[2J  Allow external CLAUDE.md file imports?\r\n ❯ No, disable\r\n   Yes, allow\r\n Enter to confirm · Esc to cancel\r\n\x1b[>0q'), true);
  assert.equal(screenAsksForInput('Welcome to Claude Code\r\n> \r\n'), false);
  // Spaces drawn by cursor movement are absent from the byte stream.
  assert.equal(screenAsksForInput('Quicksafetycheck\r\n❯No,exit\r\nYes,Itrustthisfolder\r\nEntertoconfirm·Esctocancel\r\n\x1b[>0q'), true);
  assert.equal(screenAsksForInput(''), false);
  // Cursor Agent, not logged in, as recorded on 2026-09-08.
  assert.equal(screenAsksForInput('Cursor Agent\r\nv2026.09.02\r\nPress any key to log in...\r\n'), true);
  assert.equal(screenAsksForInput('│ [q] Quit │\r\n│ Use arrow keys to navigate, Enter to select, or press the key shown │\r\n'), true);

  const configDir = mkdtempSync(path.join(tmpdir(), 'forester-claude-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const environment = { CLAUDE_CONFIG_DIR: configDir };
  assert.equal(seedClaudeTrust('/w/one', environment).result, 'absent');
  writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ projects: { '/w/other': { allowedTools: ['x'] } }, theme: 'dark' }));
  assert.equal(seedClaudeTrust('/w/one', environment).result, 'seeded');
  assert.equal(seedClaudeTrust('/w/one', environment).result, 'already');
  const written = JSON.parse(readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  assert.deepEqual(written, { projects: { '/w/other': { allowedTools: ['x'] }, '/w/one': { hasTrustDialogAccepted: true } }, theme: 'dark' });
  writeFileSync(path.join(configDir, '.claude.json'), '{ broken');
  assert.equal(seedClaudeTrust('/w/one', environment).result, 'unreadable');
});

// serve holds the fixture tool in a real pseudo-terminal, a viewer types the
// answer through the socket, the tool reports done, the slot refills.
test('serve seats the budget, holds real sessions, relays a viewer, and refills after done', async (t) => {
  const f = fixture(t, {
    plan: PLAN,
    local: `version: 1\nparallel: 1\ntool: fixture\ntools:\n  fixture: { command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(TOOL)}, "{task}"] }\n`,
  });
  const snapshot = path.join(f.root, 'state', 'foresters', 'forester-test.yml');
  // A previous session's last event must not become this session's state.
  const staleEvents = path.join(f.root, 'state', 'foresters', 'forester-test', 'define-shape.events');
  mkdirSync(path.dirname(staleEvents), { recursive: true });
  writeFileSync(staleEvents, '{"hook_event_name":"SessionEnd"}\n');
  const serve = spawn(process.execPath, [CLI, 'forester', 'serve', '--project', f.baseline], { env: { ...f.environment, FORESTER_POLL_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.on('data', (chunk) => { log += chunk; });
  serve.stderr.on('data', (chunk) => { log += chunk; });
  t.after(() => { if (serve.exitCode == null) serve.kill('SIGKILL'); });
  const until = async (pred, what, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (pred()) return; await sleep(100); }
    let last = null;
    try { last = f.run(['forester', 'status', '--json']); } catch {}
    assert.fail(`${what}\n${log}\n--- status: ${last?.stdout}\n${last?.stderr}`);
  };
  const sessions = () => (existsSync(snapshot) ? f.json(['forester', 'status']).items.map((item) => [item.id, item.session?.state ?? null]) : []);
  await until(() => sessions().some(([id, state]) => id === 'define-shape' && state === 'needs-input'), 'define-shape session reached needs-input');
  const status = f.json(['forester', 'status']);
  assert.equal(status.serve.alive, true);
  assert.doesNotMatch(readFileSync(staleEvents, 'utf8'), /SessionEnd/, 'events file starts empty per launch');
  assert.deepEqual(status.slots, { active: 1, free: 0, parallel: 1 });
  const text = f.good(['forester', 'status']).stdout;
  assert.match(text, /serve    pid \d+ · sessions 1/);
  assert.match(text, /define-shape  fixture  needs-input/);

  // A viewer attaches over the socket, sees the prompt, and answers it.
  const seen = await new Promise((resolve, reject) => {
    const socket = createConnection(status.serve.socket);
    let out = '';
    socket.on('data', (chunk) => { out += chunk; if (out.includes('allow? (y/N)') && !socket.answered) { socket.answered = true; socket.write('y\r'); } if (out.includes('report exit 0')) { socket.end(); resolve(out); } });
    socket.once('connect', () => socket.write(JSON.stringify({ attach: 'define-shape', cols: 100, rows: 30 }) + '\n'));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('viewer timed out\n' + out)), 15000);
  });
  assert.match(seen, /"ok":true/);
  assert.match(seen, /fixture tool · seat define-shape · task: Decide the response shape/);
  assert.equal(readFileSync(path.join(f.root, 'seats', 'define-shape', 'done.txt'), 'utf8'), 'Decide the response shape and write it into the reference\n');

  // Done closes that session and the freed slot goes to the next ready item.
  await until(() => { const s = Object.fromEntries(sessions()); return s['define-shape'] === 'closed' && s['api-endpoint'] === 'needs-input'; }, 'slot refilled with api-endpoint after define-shape reported done');
  const after = f.json(['forester', 'status']);
  assert.equal(after.items.find((item) => item.id === 'define-shape').state, 'done');
  assert.deepEqual(after.slots, { active: 1, free: 0, parallel: 1 });
  // A closed session has nothing to attach to; the daemon says so by name.
  assert.match(f.bad(['forester', 'attach', 'define-shape']).stderr, /no live session for "define-shape"/);

  serve.kill('SIGINT');
  await until(() => serve.exitCode != null, 'serve exits on SIGINT', 8000);
  assert.equal(existsSync(snapshot), false, 'snapshot removed on stop');
  assert.equal(existsSync(after.serve.socket), false, 'socket removed on stop');
});

test('hooks installs one marked entry per event in each tool store, keeps the person\'s entries, and removes exactly its own', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'forester-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = { HOME: home, CODEX_HOME: path.join(home, '.codex'), OPENCODE_CONFIG_DIR: path.join(home, 'opencode') };
  // Nothing installed: every store is skipped and nothing is written.
  let rows = applyHooks({ environment, apply: true });
  assert.deepEqual(rows.map((row) => row.action), Array(4).fill('skip: tool not installed'));
  assert.equal(existsSync(path.join(home, '.cursor')), false);

  // Three tools present; cursor and codex already carry the person's own entries.
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.cursor'), { recursive: true });
  mkdirSync(path.join(home, '.grok'), { recursive: true });
  writeFileSync(path.join(home, '.cursor/hooks.json'), JSON.stringify({ hooks: { stop: [{ command: 'their-stop.sh', timeout: 5 }] }, version: 1 }));
  writeFileSync(path.join(home, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'theirs' }] }] } }));
  rows = applyHooks({ environment });
  assert.deepEqual(rows.map((row) => [row.tool, row.before, row.action]), [
    ['codex', 'present', 'would install'], ['grok', 'absent', 'would install'], ['cursor-agent', 'present', 'would install'], ['opencode', 'absent', 'skip: tool not installed'],
  ]);
  assert.equal(readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8').includes(HOOK_MARKER), false, 'nothing written without --apply');

  rows = applyHooks({ environment, apply: true });
  assert.deepEqual(rows.map((row) => row.action), ['installed', 'installed', 'installed', 'skip: tool not installed']);
  const cursor = JSON.parse(readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.equal(cursor.version, 1);
  assert.deepEqual(cursor.hooks.stop[0], { command: 'their-stop.sh', timeout: 5 });
  assert.match(cursor.hooks.stop[1].command, /FORESTER_EVENTS.*"hook_event_name":"Stop"/s);
  assert.match(cursor.hooks.beforeSubmitPrompt[0].command, /"hook_event_name":"UserPromptSubmit"/);
  const codex = JSON.parse(readFileSync(path.join(home, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.hooks.Stop[0].hooks[0].command, 'theirs');
  assert.match(codex.hooks.Stop[1].hooks[0].command, /cat >> "\$FORESTER_EVENTS"/);
  assert.deepEqual(Object.keys(codex.hooks), ['Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest']);
  const grok = JSON.parse(readFileSync(path.join(home, '.grok/hooks/de-novo-forester.json'), 'utf8'));
  assert.deepEqual(Object.keys(grok.hooks), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd', 'Notification']);
  // Every command is gated: without FORESTER_EVENTS it consumes stdin and exits 0.
  for (const command of [cursor.hooks.stop[1].command, codex.hooks.Stop[1].hooks[0].command]) {
    const gated = spawnSync('sh', ['-c', command], { input: '{"x":1}', env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(gated.status, 0);
    const events = path.join(home, 'events.log');
    spawnSync('sh', ['-c', command], { input: '{"hook_event_name":"Stop"}', env: { PATH: process.env.PATH, FORESTER_EVENTS: events }, encoding: 'utf8' });
    assert.match(readFileSync(events, 'utf8'), /"hook_event_name":"Stop"/);
  }

  // Idempotent: a second apply changes nothing; a remove takes back only ours.
  rows = applyHooks({ environment, apply: true });
  assert.deepEqual(rows.map((row) => row.action), ['already installed', 'already installed', 'already installed', 'skip: tool not installed']);
  rows = applyHooks({ environment, apply: true, remove: true });
  assert.deepEqual(rows.map((row) => row.action), ['removed', 'removed', 'removed', 'skip: tool not installed']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8')), { hooks: { stop: [{ command: 'their-stop.sh', timeout: 5 }] }, version: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.codex/hooks.json'), 'utf8')), { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'theirs' }] }] } });
  assert.equal(existsSync(path.join(home, '.grok/hooks/de-novo-forester.json')), false);

  // OpenCode: the plugin file is written whole and removed whole.
  mkdirSync(path.join(home, 'opencode'), { recursive: true });
  rows = applyHooks({ environment, apply: true });
  assert.equal(rows[3].action, 'installed');
  assert.match(readFileSync(path.join(home, 'opencode/plugins/de-novo-forester.js'), 'utf8'), /FORESTER_EVENTS/);
  // A store that is not JSON is refused by name, not clobbered.
  writeFileSync(path.join(home, '.codex/hooks.json'), '{ broken');
  assert.throws(() => applyHooks({ environment, apply: true }), /hooks\.json: not JSON/);
  assert.equal(readFileSync(path.join(home, '.codex/hooks.json'), 'utf8'), '{ broken');
  assert.equal(hookStores(environment).length, 4);
  assert.equal(renderStore({ kind: 'plugin' }, null, { remove: true }), null);
});
