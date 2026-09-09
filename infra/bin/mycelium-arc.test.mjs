// The Mycelium arc at its real boundary, every time the suite runs: a
// playground sandbox, a real Dryad seat in its worktree, the writes a
// sprint makes, the reads a person and Understory make, then down with
// the machine registries untouched. This is the run the evidence files
// describe, so nobody has to type it by hand after a merge again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { down, up } from '../lib/playground.mjs';
import { dryadStateDirectory } from '../lib/dryad.mjs';
import { myceliumLogPath } from '../lib/mycelium.mjs';

const catalog = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(catalog, 'infra/bin/cli.mjs');
const local = path.join(catalog, '.playground');
mkdirSync(local, { recursive: true });
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('DRYAD_') || key.startsWith('GIT_') || key.startsWith('PLAYGROUND_') || key === 'GROVE_STATE_DIR' || key === 'NODE_OPTIONS') delete environment[key];

const VALUES = `version: 1
domains: [sample]
types: [seat, item, decision, check]
predicates: { depends-on: many, uses: one, passed: many }
judges: [human:reader]
`;
const PLAN = `version: 1
parallel: 2
tasks:
  worker:
    task: "Change the sample web page"
  reviewer:
    task: "Review the page"
    depends_on: [worker]
`;

// The same synthetic sample the playground tests use: one loopback
// listener on a kernel port, a Grove profile, a Dryad profile. Nothing
// here needs Docker.
function fixture(t) {
  const root = mkdtempSync(path.join(local, 'arc-'));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'app'), { recursive: true });
  mkdirSync(path.join(source, 'tools'));
  mkdirSync(path.join(source, '.agents'));
  writeFileSync(path.join(source, 'app/server.mjs'), `import http from 'node:http';\nconst server = http.createServer((req, res) => res.end(process.env.PLAYGROUND_SANDBOX));\nserver.listen({port: 0, host: '127.0.0.1'});\n`);
  writeFileSync(path.join(source, 'tools/start.mjs'), `import { spawn } from 'node:child_process';\nimport { readFileSync, readdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nconst root = process.env.PLAYGROUND_SANDBOX;\nconst child = spawn(process.execPath, ['app/server.mjs'], { detached: true, stdio: 'ignore' });\nchild.unref();\nfor (let i = 0; i < 200; i++) {\n const files = readdirSync(path.join(root, 'run/processes'));\n const records = files.map(file => JSON.parse(readFileSync(path.join(root, 'run/processes', file))));\n if (records.some(record => record.pid === child.pid && record.ports.length)) {\n const file = path.join(root, 'run/sandbox.json'); const data = JSON.parse(readFileSync(file));\n data.names = ['web.playground.localhost']; writeFileSync(file, JSON.stringify(data)); process.exit(0);\n }\n await new Promise(resolve => setTimeout(resolve, 10));\n}\nprocess.kill(child.pid); throw Error('listener did not register');\n`);
  writeFileSync(path.join(source, '.agents/runtime-profile.yml'), `version: 1\nproject: {slug: playground}\naddressing: {tld: localhost}\nruntime:\n  commands:\n    up: node tools/start.mjs\nservices: {web: {}}\noverlay: none\ndata: {infra: project}\n`);
  writeFileSync(path.join(source, '.agents/dryad-profile.yml'), 'version: 1\nworktrees: {root: ../seats, branch: "playground/{id}"}\n');
  const sandbox = path.join(root, 'sandbox');
  const env = { ...environment, GROVE_STATE_DIR: path.join(sandbox, 'state') };
  t.after(async () => {
    if (existsSync(path.join(sandbox, 'run/sandbox.json'))) await down(sandbox, env);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, sandbox, env };
}

test('the arc: a seat proposes from its worktree, a judge commits, the reads answer, Understory points, down leaves no trace', async (t) => {
  const f = fixture(t);
  const data = await up(f.sandbox, { source: f.source, environment });
  const project = data.project;
  const worktree = path.join(data.seats, 'worker');
  writeFileSync(path.join(project, '.agents/mycelium.yml'), VALUES);
  writeFileSync(path.join(project, '.agents/forester-plan.yml'), PLAN);

  // Seat-context variables are absent on purpose: inside the sandbox the
  // guard strips them, and a seat is found by its worktree.
  const run = (args, { cwd = catalog, extra = {} } = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...f.env, ...extra }, encoding: 'utf8' });
  const ok = (args, opts) => {
    const result = run(args, opts);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  const refused = (args, pattern, opts) => {
    const result = run(args, opts);
    assert.equal(result.status, 1, `${args.join(' ')} should have been refused\n${result.stdout}`);
    assert.match(result.stderr, pattern);
  };
  const seat = (args) => ok(['mycelium', ...args], { cwd: worktree });
  const seatId = (args) => JSON.parse(seat([...args, '--json'])).id;
  const judge = (args) => ok(['mycelium', ...args, '--project', project, '--by', 'human:reader']);
  const machineBefore = { dryad: dryadStateDirectory({}), log: myceliumLogPath('playground', {}) };
  const mentions = () => [machineBefore.dryad, path.dirname(machineBefore.log)]
    .filter(existsSync)
    .flatMap((dir) => spawnSync('grep', ['-rl', f.sandbox, dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  assert.deepEqual(mentions(), [], 'the machine state holds the sandbox path before the arc');

  // B1, B5: the seat is a writer by its worktree and not a judge.
  ok(['dryad', 'plan', 'worker', '--project', project, '--task', 'Change the sample web page', '--by', 'reader', '--apply']);
  assert.equal(existsSync(worktree), true);
  const e1 = seatId(['propose', '--s', 'reviewer', '--p', 'depends-on', '--o', 'worker', '--s-type', 'item', '--o-type', 'item', '--domain', 'sample', '--source', '.agents/forester-plan.yml']);
  assert.equal(JSON.parse(seat(['query', '--status', 'staging', '--json']))[0].agent_id, 'seat:worker');
  refused(['mycelium', 'commit', e1], /seat:worker is not a judge of this project \(judges: human:reader\)/, { cwd: worktree });
  refused(['mycelium', 'propose', '--s', 'x', '--p', 'y', '--o', 'z', '--s-type', 'item', '--domain', 'sample', '--source', 'f', '--project', project], /pass --by <who>/);

  // A13: an undeclared predicate; A14: an undeclared type.
  refused(['mycelium', 'propose', '--s', 'worker', '--p', 'caused_by', '--o', 'x', '--s-type', 'item', '--domain', 'sample', '--source', 'f'], /predicate "caused_by" is not in .*\(depends-on, uses, passed, reported\)/, { cwd: worktree });
  refused(['mycelium', 'propose', '--s', 'worker', '--p', 'uses', '--o', 'x', '--s-type', 'module', '--domain', 'sample', '--source', 'f'], /s_type "module" is not in/, { cwd: worktree });

  // A10, C4, A5: a many predicate takes two edges and refuses a duplicate.
  const e2 = seatId(['propose', '--s', 'reviewer', '--p', 'depends-on', '--o', 'design-note', '--s-type', 'item', '--o-type', 'decision', '--domain', 'sample', '--source', 'docs/design.md']);
  const dup = seatId(['propose', '--s', 'reviewer', '--p', 'depends-on', '--o', 'worker', '--s-type', 'item', '--o-type', 'item', '--domain', 'sample', '--source', 'plan']);
  assert.match(judge(['commit', e1]), new RegExp(`committed ${e1} \\(active\\)$`, 'm'));
  assert.match(judge(['commit', e2]), new RegExp(`committed ${e2} \\(active\\)$`, 'm'));
  refused(['mycelium', 'commit', dup, '--project', project, '--by', 'human:reader'], new RegExp(`${e1} already states reviewer depends-on worker`));

  // A4, A7: a one predicate conflicts, then supersedes; the old fact closes at the new valid_from.
  const u1 = seatId(['propose', '--s', 'sample-web', '--p', 'uses', '--o', 'plain html', '--s-type', 'decision', '--domain', 'sample', '--source', 'web/index.html', '--valid-from', '2026-09-01T00:00:00Z']);
  const u2 = seatId(['propose', '--s', 'sample-web', '--p', 'uses', '--o', 'html plus script', '--s-type', 'decision', '--domain', 'sample', '--source', 'web/index.html', '--valid-from', '2026-09-05T00:00:00Z']);
  judge(['commit', u1]);
  refused(['mycelium', 'commit', u2, '--project', project, '--by', 'human:reader'], new RegExp(`conflicts with active ${u1}`));
  assert.match(judge(['commit', u2, '--supersede']), new RegExp(`superseded ${u1}`));

  // A2, A9: the seat amends, the judge commits, the original never held.
  const fixed = seatId(['amend', u2, '--confidence', '0.9']);
  assert.match(judge(['commit', fixed]), new RegExp(`amended ${u2}`));

  // C5, C2, C1: a check fact; a blocked report through the seam; the done form refused until done.
  const check = seatId(['propose', '--s', 'local-qa', '--p', 'passed', '--o', '3/3 pages', '--s-type', 'check', '--domain', 'sample', '--source', 'playground status']);
  ok(['dryad', 'report', 'worker', '--project', project, '--status', 'blocked', '--note', 'waits for review']);
  const blocked = JSON.parse(judge(['propose', '--from-seat', 'worker', '--report', 'blocked', '--s-type', 'seat', '--domain', 'sample', '--json']));
  assert.equal(blocked.o, 'blocked: waits for review');
  assert.equal(blocked.p, 'reported');
  refused(['mycelium', 'propose', '--from-seat', 'worker', '--s-type', 'seat', '--domain', 'sample', '--project', project, '--by', 'human:reader'], /has no done report/);
  ok(['dryad', 'report', 'worker', '--project', project, '--status', 'done', '--note', 'page changed']);
  const done = JSON.parse(judge(['propose', '--from-seat', 'worker', '--s-type', 'seat', '--domain', 'sample', '--json']));
  assert.equal(done.o, 'done: page changed');

  // D1, D2, D3, D5, D6, D7, C6: the reads.
  const active = JSON.parse(ok(['mycelium', 'query', '--project', project, '--json']));
  assert.deepEqual(active.map((row) => row.id).sort(), [e1, e2, fixed].sort());
  assert.deepEqual(JSON.parse(ok(['mycelium', 'query', '--project', project, '--at', '2026-09-03T00:00:00Z', '--json'])).map((row) => row.id), [u1]);
  assert.deepEqual(JSON.parse(ok(['mycelium', 'query', '--project', project, '--at', '2026-09-06T00:00:00Z', '--json'])).map((row) => row.id), [fixed]);
  assert.equal(JSON.parse(ok(['mycelium', 'query', '--project', project, '--s', 'sample-web', '--all', '--json'])).length, 3);
  const chain = JSON.parse(ok(['mycelium', 'trace', fixed, '--project', project, '--json']));
  assert.deepEqual(chain.map((row) => [row.id, row.link]), [[u1, `superseded by ${u2}`], [u2, `supersedes ${u1}`], [fixed, `amends ${u2}`]]);
  assert.equal(JSON.parse(ok(['mycelium', 'query', '--project', project, '--since', '2100-01-01T00:00:00Z', '--json'])).length, 0);
  // Staging: the duplicate edge, the check, the blocked report, the done report.
  assert.equal(ok(['mycelium', 'query', '--project', project, '--status', 'staging', '--ids']).trim().split('\n').length, 4);
  const brief = ok(['mycelium', 'query', '--project', project, '--brief', '--s', 'reviewer']);
  assert.match(brief, new RegExp(`^- ${e1}  reviewer depends-on worker  \\(sample, 0.50, .agents/forester-plan.yml\\)$`, 'm'));
  assert.match(brief, new RegExp(`^- ${e2}  reviewer depends-on design-note`, 'm'));
  const status = JSON.parse(ok(['mycelium', 'status', '--project', project, '--json']));
  assert.deepEqual(status.counts, { total: 9, staging: 4, active: 3, invalid: 2, staging_below_half: 0 });
  assert.equal(status.file, path.join(f.sandbox, 'state/mycelium/playground.jsonl'));

  // C7: Understory points at the active facts about each item.
  const reading = JSON.parse(ok(['understory', 'reading', '--project', project, '--json'])).reading;
  assert.deepEqual(reading.map((row) => [row.id, row.facts.sort()]), [['worker', []], ['reviewer', [e1, e2].sort()]]);
  assert.match(ok(['understory', 'reading', '--project', project]), new RegExp(`reviewer .*· facts `));

  // E3: the log is whole, one versioned object per line, in the sandbox only.
  const lines = readFileSync(status.file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 14);
  assert.ok(lines.every((line) => JSON.parse(line).v === 1));
  assert.equal(existsSync(`${status.file}.lock`), false);

  // Herbarium: the sample's own documents pass a first check, and a copied
  // paragraph in a seat's README is counted at the project root.
  writeFileSync(path.join(project, '.agents/herbarium.yml'), 'version: 1\nlanguage: en\npublic: ["**/*.md"]\npages:\n  globs: [README.md]\n  max_words: 450\nignore: [".agents/skills/**", ".claude/**", "app/**", "run/**"]\n');
  const paragraph = 'The sample has one api, one web page, and one router; every listener binds port zero and reports what the kernel gave it, so no port is ever chosen in advance.';
  writeFileSync(path.join(project, 'README.md'), `# Sample\n\n${paragraph}\n\nPlan: [forester](.agents/forester-plan.yml).\n`);
  const first = run(['herbarium', 'check', '--project', project]);
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /links     1\/1 resolve/);
  assert.match(first.stdout, /copies    0 exact · 0 near/);
  writeFileSync(path.join(project, 'docs-copy.md'), `# Copy\n\n${paragraph}\n`);
  const second = run(['herbarium', 'check', '--project', project]);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /copies    [1-9]/);

  // F1: down, and the machine state never learned the sandbox's name.
  const out = await down(f.sandbox, f.env);
  assert.equal(out.removed, true);
  assert.equal(out.ports, 0);
  assert.equal(out.machine.dryad.length + out.machine.overlays.length, 0);
  assert.deepEqual(mentions(), []);
  assert.equal(existsSync(f.sandbox), false);
});
