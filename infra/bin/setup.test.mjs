import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ENGINES,
  PROVISION,
  planSetup,
  readProfile,
  resolveProfilePath,
  stateFromInspect,
} from './setup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SETUP = path.join(REPO_ROOT, 'infra/bin/setup.mjs');

const FULL_PROFILE = `
version: 1
project: { slug: acme }
data:
  infra: machine
  engines:
    mysql: [acme, acme_audit]
    redis: { prefix: "acme:" }
    kafka: true
`;

test('multi-engine profile → service, compose-profile, provision plan', () => {
  const plan = planSetup(readProfile(FULL_PROFILE));
  assert.deepEqual(plan.services, ['mysql8', 'redis7', 'kafka']);
  assert.deepEqual(plan.composeProfiles, ['mysql', 'redis', 'kafka']);
  assert.deepEqual(plan.provisions, [
    { engine: 'mysql', name: 'acme' },
    { engine: 'mysql', name: 'acme_audit' },
  ]);
  assert.ok(plan.notes.some((n) => n.includes('"acme:"')));
  assert.ok(plan.notes.some((n) => n.includes('"acme."'))); // default prefix for kafka: true
});

test('true shorthand uses namespace (default = slug) as the database name', () => {
  const { engines } = readProfile(`
project: { slug: sideapp }
data: { infra: machine, engines: { pg: true } }
`);
  assert.deepEqual(engines.pg.databases, ['sideapp']);
});

test('an explicit namespace changes every default', () => {
  const { engines, namespace } = readProfile(`
project: { slug: acme, namespace: acme_dev }
data: { infra: machine, engines: { mysql: true, redis: true, kafka: true } }
`);
  assert.equal(namespace, 'acme_dev');
  assert.deepEqual(engines.mysql.databases, ['acme_dev']);
  assert.equal(engines.redis.prefix, 'acme_dev:');
  assert.equal(engines.kafka.topicPrefix, 'acme_dev.');
});

test('per-engine character rules are rewritten (database: -→_, bucket: _→-)', () => {
  const { engines } = readProfile(`
project: { slug: my-app }
data: { infra: machine, engines: { mysql: true, redis: true } }
`);
  assert.deepEqual(engines.mysql.databases, ['my_app']); // db names cannot contain hyphens
  assert.equal(engines.redis.prefix, 'my-app:'); // prefix keeps the original form

  const { engines: withMinio } = readProfile(`
project: { slug: acme, namespace: acme_dev }
data: { infra: machine, engines: { minio: true } }
`);
  assert.equal(withMinio.minio.bucket, 'acme-dev'); // buckets cannot contain underscores
});

test('postgres alias canonicalizes to pg', () => {
  const plan = planSetup(
    readProfile(`
project: { slug: sideapp }
data: { infra: machine, engines: { postgres: [sideapp] } }
`)
  );
  assert.deepEqual(plan.services, ['pg16']);
  assert.deepEqual(plan.provisions, [{ engine: 'pg', name: 'sideapp' }]);
});

test('infra: project is not a setup target — rejected clearly', () => {
  assert.throws(
    () =>
      readProfile(`
project: { slug: legacy }
data: { infra: project, engines: { mysql: true } }
`),
    /machine/
  );
});

test('unknown engines are rejected by name', () => {
  assert.throws(
    () =>
      readProfile(`
project: { slug: acme }
data: { infra: machine, engines: { oracle: true } }
`),
    /oracle/
  );
});

test('database names are validated', () => {
  assert.throws(
    () =>
      readProfile(`
project: { slug: acme }
data: { infra: machine, engines: { mysql: ["DROP TABLE"] } }
`),
    /database name/
  );
});

test('no engine declaration yields an empty plan', () => {
  const plan = planSetup(readProfile(`
project: { slug: acme }
data: { infra: machine }
`));
  assert.equal(plan.services.length, 0);
  assert.equal(plan.provisions.length, 0);
});

test('every ENGINES row has a container name', () => {
  for (const [name, spec] of Object.entries(ENGINES)) {
    assert.ok(spec.service, name);
    assert.match(spec.container, /^dev-/, name);
  }
});

test('a running container without a health result is not ready', () => {
  assert.deepEqual(stateFromInspect('true|healthy\n'), { ready: true, label: 'healthy' });
  assert.deepEqual(stateFromInspect('true|\n'), {
    ready: false,
    label: 'healthcheck missing',
  });
  assert.deepEqual(stateFromInspect('true|unhealthy\n'), {
    ready: false,
    label: 'unhealthy',
  });
});

test('resolveProfilePath: a directory finds .agents/runtime-profile.yml', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'setup-test-'));
  mkdirSync(path.join(root, '.agents'));
  const file = path.join(root, '.agents', 'runtime-profile.yml');
  writeFileSync(file, 'version: 1\n');
  assert.equal(resolveProfilePath(root), file);
  assert.equal(resolveProfilePath(file), file);
  assert.throws(() => resolveProfilePath(path.join(root, 'no-such-dir')), /de-novo skills init/);
});

test('pg provision revokes PUBLIC connect on the project database', () => {
  const text = readFileSync(PROVISION, 'utf8');
  assert.match(text, /REVOKE ALL ON DATABASE \$\{name\} FROM PUBLIC/);
  assert.match(text, /GRANT ALL ON DATABASE \$\{name\} TO \$\{name\}/);
});

test('provision does not print connection URLs containing credentials', () => {
  const text = readFileSync(PROVISION, 'utf8');
  assert.doesNotMatch(text, /echo "(?:mysql|postgres):\/\//);
});

test('provision updates credentials when an account already exists', () => {
  const text = readFileSync(PROVISION, 'utf8');
  assert.match(text, /ALTER USER/);
  assert.match(text, /ALTER ROLE/);
});

test('provision remediation uses the profiled Grove command', () => {
  const text = readFileSync(PROVISION, 'utf8');
  assert.match(text, /de-novo skills infra up/);
  assert.doesNotMatch(text, /docker compose .* up -d --wait/);
});

test('direct setup invocation rejects extra arguments before any engine action', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'setup-args-'));
  mkdirSync(path.join(root, '.agents'));
  writeFileSync(
    path.join(root, '.agents', 'runtime-profile.yml'),
    'version: 1\nproject: { slug: acme }\ndata: { infra: machine }\n'
  );
  const result = spawnSync(process.execPath, [SETUP, root, 'ignored-extra'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected argument/);
});

// Compose up must never recreate a running shared engine. A docker shim on
// PATH records every argv so both entry points (setup, infra up) are measured
// at the command boundary without a daemon.
function dockerShim(t) {
  const bin = mkdtempSync(path.join(tmpdir(), 'docker-shim-'));
  const log = path.join(bin, 'docker.log');
  writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$DOCKER_SHIM_LOG"\ncase "$1" in inspect) echo "true|healthy";; esac\nexit 0\n',
    { mode: 0o755 }
  );
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_SHIM_LOG: log }, log };
}

test('setup and infra up pass --no-recreate so running shared engines are never recreated', (t) => {
  const shim = dockerShim(t);
  const root = mkdtempSync(path.join(tmpdir(), 'setup-norecreate-'));
  mkdirSync(path.join(root, '.agents'));
  writeFileSync(
    path.join(root, '.agents', 'runtime-profile.yml'),
    'project: { slug: norecreate }\nservices: { api: {} }\noverlay: none\ndata: { infra: machine, engines: { pg: true, redis: true } }\n'
  );
  const setup = spawnSync(process.execPath, [SETUP, root], { env: shim.env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  const infraUp = spawnSync(process.execPath, [path.join(REPO_ROOT, 'infra/bin/cli.mjs'), 'infra', 'up', 'pg'], { env: shim.env, encoding: 'utf8' });
  assert.equal(infraUp.status, 0, infraUp.stderr + infraUp.stdout);
  const ups = readFileSync(shim.log, 'utf8').split('\n').filter((line) => / up /.test(line));
  assert.equal(ups.length, 2, `expected one compose up per entry point, got:\n${ups.join('\n')}`);
  for (const line of ups) {
    assert.match(line, /^compose -f .* up -d --no-recreate --wait /);
  }
  t.diagnostic('compose up invocations 2/2 carry --no-recreate');
});
