import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import { ALIASES, COMPOSE_NETWORK, ENGINES, parseComposeEngines } from '../lib/engines.mjs';

test('docker-compose.yml is the engine catalog', () => {
  assert.equal(ENGINES.mysql.service, 'mysql8');
  assert.equal(ENGINES.mysql.container, 'dev-mysql8');
  assert.equal(ENGINES.mysql.composeProfile, 'mysql');
  assert.equal(ENGINES.mysql.provision, 'mysql');
  assert.equal(ENGINES.pg.provision, 'pg');
  assert.equal(ENGINES.redis.provision, undefined);
  assert.equal(ENGINES.kafka.composeProfile, 'kafka');
  assert.equal(ENGINES.mysql.port, 3306);
  assert.equal(ENGINES.kafka.port, 19092);
  assert.equal(ALIASES.postgres, 'pg');
  assert.equal(ALIASES.postgresql, 'pg');
  assert.equal(ALIASES.mailpit, 'mail');
  assert.equal(ALIASES.s3, 'minio');
});

test('parseComposeEngines reads profile, container, provision, aliases', () => {
  const doc = parse(`
services:
  mysql8:
    container_name: dev-mysql8
    profiles: [mysql]
    healthcheck: { test: [CMD, "true"] }
    labels:
      ground.provision: mysql
      ground.port: "3306"
  pg16:
    container_name: dev-pg16
    profiles: [pg]
    healthcheck: { test: [CMD, "true"] }
    labels:
      ground.provision: pg
      ground.aliases: postgres,postgresql
      ground.port: "5432"
`);
  const { engines, aliases } = parseComposeEngines(doc, 't.yml');
  assert.deepEqual(Object.keys(engines), ['mysql', 'pg']);
  assert.equal(engines.mysql.container, 'dev-mysql8');
  assert.equal(engines.pg.provision, 'pg');
  assert.equal(aliases.postgres, 'pg');
});

test('a service without a profile is not an engine', () => {
  const doc = parse(`
services:
  proxy:
    container_name: dev-proxy
  mysql8:
    container_name: dev-mysql8
    profiles: [mysql]
    healthcheck: { test: [CMD, "true"] }
    labels:
      ground.port: "3306"
`);
  const { engines } = parseComposeEngines(doc, 't.yml');
  assert.deepEqual(Object.keys(engines), ['mysql']);
});

test('two profiles on one service are rejected', () => {
  const doc = parse(`
services:
  db:
    container_name: dev-db
    profiles: [mysql, pg]
`);
  assert.throws(() => parseComposeEngines(doc, 't.yml'), /exactly one compose profile/);
});

test('every catalog engine has an explicit healthcheck', () => {
  for (const [name, spec] of Object.entries(ENGINES)) {
    assert.equal(spec.hasHealthcheck, true, name);
  }
});

test('a profiled service without a healthcheck is rejected', () => {
  const doc = parse(`
services:
  db:
    container_name: dev-db
    profiles: [mysql]
    labels: { ground.port: "3306" }
`);
  assert.throws(() => parseComposeEngines(doc, 't.yml'), /healthcheck/);
});

test('engine ports must fit the TCP port range', () => {
  const doc = parse(`
services:
  db:
    container_name: dev-db
    profiles: [mysql]
    healthcheck: { test: [CMD, "true"] }
    labels: { ground.port: "70000" }
`);
  assert.throws(() => parseComposeEngines(doc, 't.yml'), /port/);
});

test('an alias cannot shadow a canonical engine name', () => {
  const doc = parse(`
services:
  mysql8:
    container_name: dev-mysql8
    profiles: [mysql]
    healthcheck: { test: [CMD, "true"] }
    labels: { ground.port: "3306" }
  pg16:
    container_name: dev-pg16
    profiles: [pg]
    healthcheck: { test: [CMD, "true"] }
    labels: { ground.port: "5432", ground.aliases: mysql }
`);
  assert.throws(() => parseComposeEngines(doc, 't.yml'), /alias/);
});

test('the stable shared Docker network cannot be renamed', () => {
  assert.equal(COMPOSE_NETWORK, 'dev-infra');
  const doc = parse(`
services: {}
networks:
  default: { name: renamed-network }
`);
  assert.throws(() => parseComposeEngines(doc, 't.yml'), /dev-infra/);
});
