import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, down, status, assertTree, alive, nextCommands } from '../lib/playground.mjs';

const catalog = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(catalog, 'infra/bin/cli.mjs');
const local = path.join(catalog, '.playground');
mkdirSync(local, { recursive: true });
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('DRYAD_') || key.startsWith('GIT_') || key.startsWith('PLAYGROUND_') || key === 'GROVE_STATE_DIR' || key === 'NODE_OPTIONS') delete environment[key];

function fixture(t) {
  const root = mkdtempSync(path.join(local, 'test-'));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'app'), { recursive: true });
  mkdirSync(path.join(source, 'tools'));
  mkdirSync(path.join(source, '.agents'));
  writeFileSync(path.join(source, 'app/server.mjs'), `import http from 'node:http';\nconst server = http.createServer((req, res) => res.end(process.env.PLAYGROUND_SANDBOX));\nserver.listen({port: 0, host: '127.0.0.1'});\n`);
  writeFileSync(path.join(source, 'tools/start.mjs'), `import { spawn } from 'node:child_process';\nimport { readFileSync, readdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nconst root = process.env.PLAYGROUND_SANDBOX;\nconst child = spawn(process.execPath, ['app/server.mjs'], { detached: true, stdio: 'ignore' });\nchild.unref();\nfor (let i = 0; i < 200; i++) {\n const files = readdirSync(path.join(root, 'run/processes'));\n const records = files.map(file => JSON.parse(readFileSync(path.join(root, 'run/processes', file))));\n if (records.some(record => record.pid === child.pid && record.ports.length)) {\n const file = path.join(root, 'run/sandbox.json'); const data = JSON.parse(readFileSync(file));\n data.names = ['web.playground.localhost']; writeFileSync(file, JSON.stringify(data)); process.exit(0);\n }\n await new Promise(resolve => setTimeout(resolve, 10));\n}\nprocess.kill(child.pid); throw Error('listener did not register');\n`);
  writeFileSync(path.join(source, '.agents/runtime-profile.yml'), `version: 1\nproject: {slug: playground}\naddressing: {tld: localhost}\nruntime:\n  commands:\n    up: node tools/start.mjs\nservices: {web: {}}\noverlay: none\ndata: {infra: project}\n`);
  writeFileSync(path.join(source, '.agents/dryad-profile.yml'), 'version: 1\nworktrees: {root: ../seats, branch: "playground/{id}"}\n');
  const sandboxes = [];
  const env = sandbox => ({ ...environment, GROVE_STATE_DIR: path.join(sandbox, 'state') });
  const start = async (name = 'sandbox') => {
    const sandbox = path.join(root, name);
    sandboxes.push(sandbox);
    return up(sandbox, { source, environment });
  };
  t.after(async () => {
    for (const sandbox of sandboxes) if (existsSync(path.join(sandbox, 'run/sandbox.json'))) await down(sandbox, env(sandbox));
    rmSync(root, { recursive: true, force: true });
  });
  const run = (args, sandbox, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env(sandbox), ...extra }, cwd: catalog, encoding: 'utf8' });
  return { root, source, start, env, run };
}
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test('isolation 1: one directory contains the layout and refuses symlink escapes', async t => {
  const f = fixture(t);
  const data = await f.start();
  for (const name of ['project', 'state', 'seats', 'run']) assert.equal(data[name], path.join(data.sandbox, name));
  assertTree(data.sandbox);
  const link = path.join(data.run, 'escape');
  symlinkSync(f.source, link);
  try { assert.throws(() => status(data.sandbox, f.env(data.sandbox)), /symlinks/); }
  finally { rmSync(link); }
  assert.equal(existsSync(path.join(data.project, 'app/server.mjs')), true);
  assert.equal(existsSync(path.join(data.project, '.agents/dryad-profile.yml')), true);
  const out = await down(data.sandbox, f.env(data.sandbox));
  assert.equal(out.removed, true);
});

test('isolation 2: every sandbox CLI call requires its own state directory', async t => {
  const f = fixture(t);
  const data = await f.start();
  const before = f.run(['dryad', 'projects', '--json'], data.sandbox, { GROVE_STATE_DIR: undefined });
  for (const state of [undefined, '', path.join(f.root, 'elsewhere')]) {
    const result = f.run(['validate', data.project], data.sandbox, { GROVE_STATE_DIR: state });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GROVE_STATE_DIR must be/);
  }
  assert.equal(f.run(['validate', data.project], data.sandbox).status, 0);
  const inherited = f.run(['dryad', 'plan', 'reader', '--task', 'Refuse machine state'], data.sandbox, { GROVE_STATE_DIR: undefined, DRYAD_PROJECT: data.project });
  assert.notEqual(inherited.status, 0);
  assert.match(inherited.stderr, /GROVE_STATE_DIR must be/);
  const planned = f.run(['dryad', 'plan', 'reader', '--project', data.project, '--task', 'Test isolation', '--by', 'test', '--apply'], data.sandbox);
  assert.equal(planned.status, 0, planned.stderr);
  const listing = JSON.parse(f.run(['dryad', 'projects', '--json'], data.sandbox).stdout);
  assert.deepEqual(listing.projects.map(p => p.root), [data.project]);
  const after = f.run(['dryad', 'projects', '--json'], data.sandbox, { GROVE_STATE_DIR: undefined });
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual(status(data.sandbox, f.env(data.sandbox)).machine, { dryad: [], overlays: [] });
  for (const line of nextCommands(data).split('\n')) assert.match(line, /^GROVE_STATE_DIR=/);
});

function probe(data, source, before = null) {
  const file = path.join(data.run, 'probe.cjs');
  writeFileSync(file, source);
  const preload = path.join(data.run, 'before.cjs');
  if (before) writeFileSync(preload, before);
  return spawnSync(process.execPath, [...(before ? ['--require', preload] : []), '--require', path.join(data.run, 'guard.cjs'), file], {
    env: { ...environment, PATH: `${path.join(data.run, 'bin')}:${environment.PATH}`, PLAYGROUND_SANDBOX: data.sandbox, GROVE_STATE_DIR: data.state }, encoding: 'utf8', timeout: 1000,
  });
}

test('isolation 3: source has no literal listener port and two live sandboxes get distinct ports', async t => {
  const f = fixture(t);
  const a = await f.start('a');
  const b = await f.start('b');
  assert.ok(a.ports.length && b.ports.length);
  assert.equal(new Set([...a.ports, ...b.ports]).size, a.ports.length + b.ports.length);
  for (const data of [a, b]) assert.equal(await (await fetch(`http://127.0.0.1:${data.ports[0]}`)).text(), data.sandbox);
  const scan = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scan(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  const sample = existsSync(path.join(catalog, 'playground/app')) ? scan(path.join(catalog, 'playground/app')).concat(scan(path.join(catalog, 'playground/tools'))) : scan(f.source);
  const files = [...sample, cli, path.join(catalog, 'infra/lib/playground.mjs')].filter(file => /\.(mjs|cjs|js|yml)$/.test(file));
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:\bport\s*[:=]\s*|\.listen\(\s*)[1-9]\d*\b|https?:\/\/[^\s'"`]+:\d{2,5}\b/i, file);
  const result = probe(a, `require('node:net').createServer().listen({port: ${a.ports[0]}, host: '127.0.0.1'});`);
  assert.match(result.stderr, /listeners must request port 0/);
});

test('isolation 4: adapter children cannot invoke shared engine commands', async t => {
  const f = fixture(t);
  const data = await f.start();
  mkdirSync(path.join(data.run, 'bin'));
  for (const command of ['docker', 'kubectl']) {
    const fake = path.join(data.run, 'bin', command);
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const result = probe(data, `require('node:child_process').spawnSync('${command}', ['--version']);`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only Node, git and process inspection/);
  }
  const refused = f.run(['infra', 'status'], data.sandbox, { PLAYGROUND_SANDBOX: data.sandbox });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not available inside a sandbox/);
});

test('isolation 5: sandbox commits and seats belong to their own git', async t => {
  const f = fixture(t);
  const before = git(catalog, ['log', '--all', '--format=%H']);
  const data = await f.start();
  assert.equal(git(data.project, ['rev-parse', '--show-toplevel']), data.project);
  assert.equal(git(data.project, ['rev-list', '--count', 'HEAD']), '1');
  assert.ok(!before.split('\n').includes(data.revision));
  assert.equal(git(catalog, ['log', '--all', '--format=%H']), before);
});

test('isolation 6: every Node process is recorded and down leaves zero processes and listeners', async t => {
  const f = fixture(t);
  const data = await f.start();
  assert.equal(data.processes.length, 2);
  assert.equal(data.processes.filter(p => p.alive).length, 1);
  const extra = probe(data, 'process.exit(0)');
  assert.equal(extra.status, 0, extra.stderr);
  const current = status(data.sandbox, f.env(data.sandbox));
  assert.equal(current.processes.length, 3);
  const result = await down(data.sandbox, f.env(data.sandbox));
  assert.deepEqual(result, { sandbox: data.sandbox, processes: 0, ports: 0, machine: { dryad: [], overlays: [] }, removed: true, ok: true });
  assert.equal(current.processes.filter(alive).length, 0);
});

test('isolation 7: non-loopback and implicit wildcard binds are refused', async t => {
  const f = fixture(t);
  const data = await f.start();
  for (const host of ['0.0.0.0', '::', 'localhost', undefined]) {
    const result = probe(data, `require('node:net').createServer().listen(${JSON.stringify({port: 0, host})});`, `require('node:net').Server.prototype.listen = () => { throw Error('unsafe bind reached the listener boundary'); };`);
    assert.match(result.stderr, /only 127.0.0.1 may bind/);
  }
  await assert.rejects(up(path.join(f.root, 'wide'), { source: f.source, host: '0.0.0.0' }), /only 127.0.0.1/);
});
