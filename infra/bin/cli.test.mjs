import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEngines, resolveInvocation } from './cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'infra/bin/cli.mjs');
const MINIMAL = path.join(
  REPO_ROOT,
  'skills/ground/examples/minimal.runtime-profile.yml'
);

test('no args → start nothing (compose catalog, ask via setup or names)', () => {
  const { services, profiles } = resolveEngines([]);
  assert.deepEqual(services, []);
  assert.deepEqual(profiles, []);
});

test('named engines bring compose profiles from docker-compose.yml', () => {
  const { services, profiles } = resolveEngines(['kafka', 'mail']);
  assert.deepEqual(services, ['kafka', 'mailpit']);
  assert.deepEqual(profiles, ['kafka', 'mail']);
});

test('aliases and duplicates are canonicalized', () => {
  const { services } = resolveEngines(['postgres', 'pg', 'mysql']);
  assert.deepEqual(services, ['pg16', 'mysql8']);
});

test('unknown engines are rejected by name', () => {
  assert.throws(() => resolveEngines(['oracle']), /oracle/);
});

test('de-novo requires the skills namespace', () => {
  assert.deepEqual(resolveInvocation(['infra', 'status'], 'cli'), {
    args: ['infra', 'status'],
    error: null,
  });
  assert.deepEqual(resolveInvocation(['skills', 'infra', 'status'], 'de-novo'), {
    args: ['infra', 'status'],
    error: null,
  });
  assert.deepEqual(resolveInvocation(['infra', 'status'], 'de-novo-skills'), {
    args: ['infra', 'status'],
    error: null,
  });
  const miss = resolveInvocation(['infra', 'status'], 'de-novo');
  assert.match(miss.error, /de-novo skills/);
  assert.equal(miss.args, null);
});

test('validate counts invariants 5/5 on an example profile', () => {
  const result = spawnSync(process.execPath, [CLI, 'validate', MINIMAL], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /invariants {2}5\/5/);
  assert.match(result.stdout, /overlay: none/);
});

test('de-novo skills infra status via the de-novo bin name', () => {
  const dir = path.join(tmpdir(), `de-novo-bin-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'de-novo');
  try {
    symlinkSync(CLI, bin);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const result = spawnSync(process.execPath, [bin, 'skills', 'infra', 'status'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ground — machine infra/);
});

test('infra status prints Ground catalog and tld', () => {
  const result = spawnSync(process.execPath, [CLI, 'infra', 'status'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ground — machine infra/);
  assert.match(result.stdout, /tld {6}localhost/);
  assert.match(result.stdout, /catalog {2}mysql pg redis kafka mongo mail minio/);
  assert.match(result.stdout, /ready {4}\d+\/7/);
});

test('infra with no subcommand is status', () => {
  const result = spawnSync(process.execPath, [CLI, 'infra'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ground — machine infra/);
});

test('seat, plan, and facts are the commands; retired names are unknown', () => {
  for (const [command, marker] of [
    ['seat', /Seat: worktree/],
    ['plan', /plan plan/],
    ['facts', /Facts: the assertion log/],
  ]) {
    const result = spawnSync(process.execPath, [CLI, command, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, marker);
  }
  const help = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' });
  assert.match(help.stdout, /seat <verb>/);
  assert.match(help.stdout, /plan <verb>/);
  assert.match(help.stdout, /facts <verb>/);
  assert.match(help.stdout, /plan plan/);
  assert.doesNotMatch(help.stdout, /alias of/);
  // Retired product verbs, spelled so this file does not keep the old words.
  for (const former of ['gr' + 'ove', 'dr' + 'yad', 'for' + 'ester', 'my' + 'celium', 'ground']) {
    const unknown = spawnSync(process.execPath, [CLI, former], { encoding: 'utf8' });
    assert.notEqual(unknown.status, 0, former);
    assert.match(unknown.stderr, new RegExp(`unknown command "${former}"`));
  }
});

test('infra k3d connect requires --cluster', () => {
  const result = spawnSync(process.execPath, [CLI, 'infra', 'k3d', 'connect'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--cluster/);
});

test('infra unknown subcommand is non-zero', () => {
  const result = spawnSync(process.execPath, [CLI, 'infra', 'down'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command "down"/);
});

test('validate is non-zero when the profile is missing', () => {
  const result = spawnSync(
    process.execPath,
    [CLI, 'validate', '/no-such-dir'],
    { encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found/);
});

test('validate rejects extra positional arguments', () => {
  const result = spawnSync(process.execPath, [CLI, 'validate', MINIMAL, 'ignored-extra'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected argument/);
});

test('setup rejects options instead of silently ignoring them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ground-cli-'));
  mkdirSync(path.join(root, '.agents'));
  writeFileSync(
    path.join(root, '.agents', 'runtime-profile.yml'),
    'version: 1\nproject: { slug: acme }\ndata: { infra: machine }\n'
  );
  const result = spawnSync(process.execPath, [CLI, 'setup', root, '--dry-run'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected argument|unknown option/);
});

test('infra status rejects extra positional arguments', () => {
  const result = spawnSync(process.execPath, [CLI, 'infra', 'status', 'ignored-extra'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected argument/);
});

test('k3d status reads cluster resources and avoids a predictable kubeconfig path', () => {
  const text = readFileSync(CLI, 'utf8');
  assert.match(text, /kubectl[\s\S]*get/);
  assert.doesNotMatch(text, /path\.join\('\/tmp', `ground-k3d-/);
});
