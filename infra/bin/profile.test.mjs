import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatValidateReport, parseProfile, projectHostOf } from '../lib/profile.mjs';
import { readProfile } from './setup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(REPO_ROOT, 'skills/grove/examples');

function parse(text, source = 't.yml') {
  return parseProfile(text, source);
}

test('every example yaml passes parseProfile', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 2, `${files.length} example files`);
  let passed = 0;
  for (const file of files) {
    const full = path.join(EXAMPLES, file);
    parseProfile(readFileSync(full, 'utf8'), full);
    passed += 1;
  }
  assert.equal(passed, files.length);
});

test('minimal example is overlay none, omitted proxy = none', () => {
  const full = path.join(EXAMPLES, 'minimal.runtime-profile.yml');
  const p = parseProfile(readFileSync(full, 'utf8'), full);
  assert.equal(p.overlay.mode, 'off');
  assert.equal(p.overlay.explicitNone, true);
  assert.equal(p.addressing.proxy, 'none');
  assert.equal(p.project.host, 'sideapp');
  const report = formatValidateReport(p);
  assert.match(report, /invariants {2}5\/5/);
  assert.match(report, /overlay inactive \(overlay: none\)/);
  assert.match(report, /proxy none/);
});

test('multi-service example is overlay active, proxy project', () => {
  const full = path.join(EXAMPLES, 'multi-service.runtime-profile.yml');
  const p = parseProfile(readFileSync(full, 'utf8'), full);
  assert.equal(p.overlay.mode, 'on');
  assert.equal(p.overlay.attachable.length, 5);
  assert.equal(p.overlay.sharedOnly.length, 2);
  assert.ok(p.overlay.command);
  assert.equal(p.overlay.staleAfter, '1d');
  assert.equal(p.overlay.imageTag, 'full-git-sha');
  assert.equal(p.addressing.proxy, 'project');
  const report = formatValidateReport(p);
  assert.match(
    report,
    /overlay active \(attachable 5, shared_only 2, command present, stale_after 1d\)/
  );
});

test('an engines-only profile passes with overlay omitted', () => {
  const p = parse(`
project: { slug: acme }
data: { infra: machine, engines: { mysql: true } }
`);
  assert.equal(p.overlay.mode, 'off');
  assert.equal(p.overlay.explicitNone, false);
  assert.equal(p.addressing, null);
  assert.equal(p.runtime.writers, 1);
  assert.equal(p.runtime.singleStack, true);
  assert.equal(p.data.forbidDirectDbWrites, true);
  assert.deepEqual(p.engines.mysql.databases, ['acme']);
});

test('underscores in slug become hyphens in host', () => {
  const p = parse(`
project: { slug: my_app }
data: { infra: machine }
`);
  assert.equal(p.project.host, 'my-app');
  assert.equal(projectHostOf('my_app'), 'my-app');
});

test('infra: project parses; setup readProfile rejects it', () => {
  const yaml = `
project: { slug: legacy }
data: { infra: project, engines: { mysql: true } }
`;
  const p = parse(yaml);
  assert.equal(p.data.infra, 'project');
  assert.throws(() => readProfile(yaml), /machine/);
});

test('writers: 2 is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
runtime: { writers: 2 }
data: { infra: machine }
`),
    /writers/
  );
});

test('single_stack: false is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
runtime: { single_stack: false }
data: { infra: machine }
`),
    /single_stack/
  );
});

test('forbid_direct_db_writes: false is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machine, forbid_direct_db_writes: false }
`),
    /forbid_direct_db_writes/
  );
});

test('qa as a top-level key is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machine }
qa: { auth_file: e2e-auth.yml }
`),
    /unknown top-level key "qa"/
  );
});

test('overlay: none plus an overlay command is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
runtime: { commands: { overlay: node tools/dev-overlay.mjs } }
overlay: none
data: { infra: machine }
`),
    /overlay: none/
  );
});

test('an overlay command without an overlay block is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
runtime: { commands: { overlay: node tools/dev-overlay.mjs } }
data: { infra: machine }
`),
    /overlay block/
  );
});

test('overlay.attachable naming a missing service is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
services:
  api: { kind: api }
overlay:
  attachable: [ghost]
data: { infra: machine }
`),
    /attachable/
  );
});

test('shared_only overlapping attachable is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{tld}"
    overlay: "{service}--{env}.{tld}"
services:
  api: { kind: api }
overlay:
  attachable: [api]
  shared_only: [api]
data: { infra: machine }
`),
    /overlaps/
  );
});

test('overlay object without scheme.overlay is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{tld}"
services:
  api: { kind: api }
overlay:
  attachable: [api]
data: { infra: machine }
`),
    /scheme.overlay/
  );
});

test('unknown scheme tokens are rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{foo}.{tld}"
data: { infra: machine }
`),
    /\{foo\}/
  );
});

test('underscores in project.host are rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme, host: my_app }
data: { infra: machine }
`),
    /project.host/
  );
});

test('underscores in a services key are rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
services:
  my_api: { kind: api }
data: { infra: machine }
`),
    /services key/
  );
});

test('addressing.proxy outside the allowed set is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing: { proxy: caddy }
data: { infra: machine }
`),
    /addressing.proxy/
  );
});

test('unknown engines are rejected by name', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machine, engines: { oracle: true } }
`),
    /oracle/
  );
});

test('an unsupported explicit profile version is rejected', () => {
  assert.throws(
    () =>
      parse(`
version: 999
project: { slug: acme }
data: { infra: machine }
`),
    /version/
  );
});

test('omitted data.infra uses the documented machine default', () => {
  const profile = parse(`
project: { slug: acme }
data: {}
`);
  assert.equal(profile.data.infra, 'machine');
  assert.equal(readProfile('project: { slug: acme }\ndata: {}\n').engines.mysql, undefined);
});

test('data.infra rejects misspelled authority values', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machien }
`),
    /data\.infra/
  );
});

test('engine false is rejected instead of enabling a default', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machine, engines: { redis: false } }
`),
    /data\.engines\.redis/
  );
});

test('engine-specific maps reject unknown keys and wrong value types', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data: { infra: machine, engines: { kafka: { prefix: 42 } } }
`),
    /data\.engines\.kafka/
  );
});

test('canonical and alias engine declarations cannot silently overwrite', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
data:
  infra: machine
  engines:
    pg: true
    postgres: true
`),
    /declared more than once/
  );
});

test('a scalar service spec is rejected instead of becoming an empty map', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
services: { api: disabled }
data: { infra: machine }
`),
    /services\.api/
  );
});

test('overlay.shared_only naming a missing service is rejected', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{tld}"
    overlay: "{service}--{env}.{tld}"
services:
  api: { kind: api }
overlay:
  attachable: [api]
  shared_only: [ghost]
data: { infra: machine }
`),
    /shared_only/
  );
});

test('overlay lifecycle policy rejects invalid duration, image mode, and unknown keys', () => {
  const profile = (overlayFields) => `
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{tld}"
    overlay: "{service}--{env}.{tld}"
services:
  api: { kind: api }
overlay:
  attachable: [api]
${overlayFields}
data: { infra: machine }
`;
  assert.throws(() => parse(profile('  stale_after: tomorrow')), /stale_after/);
  assert.throws(() => parse(profile('  image_tag: latest')), /image_tag/);
  assert.throws(() => parse(profile('  ttl: 1d')), /unknown key "ttl"/);
});

test('runtime.commands.overlay must be a non-empty command string', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme:
    shared: "{service}.{tld}"
    overlay: "{service}--{env}.{tld}"
runtime: { commands: { overlay: "" } }
services: { api: { kind: api } }
overlay: { attachable: [api] }
data: { infra: machine }
`),
    /non-empty string/
  );
});

test('addressing.tld must be a string DNS name', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing: { tld: 123 }
data: { infra: machine }
`),
    /addressing\.tld/
  );
});

test('address schemes reject malformed braces and invalid literal labels', () => {
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme: { shared: "bad_{service}.{tld}" }
data: { infra: machine }
`),
    /scheme\.shared/
  );
  assert.throws(
    () =>
      parse(`
project: { slug: acme }
addressing:
  scheme: { shared: "{service}.{tld" }
data: { infra: machine }
`),
    /scheme\.shared/
  );
});

for (const [name, fragment, error] of [
  ['negative service port', 'services: {web: {port: -1}}', /port/],
  ['out of range service port', 'services: {web: {port: 65536}}', /port/],
  ['invalid reflect', 'services: {web: {reflect: typo}}', /reflect/],
  ['numeric health', 'services: {web: {health: 123}}', /health/],
  ['relative health', 'services: {web: {health: health}}', /health/],
  ['writer typo', 'runtime: {writer: 9}', /unknown key/],
  ['missing default profile', 'runtime: {default: missing, profiles: {}}', /runtime.default/],
  ['numeric command', 'runtime: {commands: {up: 123}}', /commands.up/],
  ['blank command', 'runtime: {commands: {status: " "}}', /commands.status/],
  ['non-map profile', 'runtime: {profiles: {local: false}}', /profiles.local/],
  ['non-string backend', 'runtime: {profiles: {local: {backend: 123}}}', /backend/],
  ['service field typo', 'services: {web: {refelct: rebuild}}', /unknown key/],
  ['addressing typo', 'addressing: {porxy: project}', /unknown key/],
  ['invalid port block', 'addressing: {ports: {blocks: {web: -1}}}', /ports.blocks/],
  ['data policy typo', 'data: {fixture: [ui]}', /unknown key/],
  ['invalid fixture entry', 'data: {fixtures: [123]}', /fixtures/],
  ['project field typo', 'project: {slug: validation, namespce: other}', /unknown key/],
  ['command name typo', 'runtime: {commands: {stats: inspect}}', /unknown key/],
  ['commands list', 'runtime: {commands: []}', /commands/],
  ['profiles list', 'runtime: {profiles: []}', /profiles/],
  ['ports list', 'addressing: {ports: []}', /ports/],
  ['port registry type', 'addressing: {ports: {registry: 123}}', /registry/],
  ['port field typo', 'addressing: {ports: {block: {web: 5000}}}', /unknown key/],
  ['scheme field typo', 'addressing: {scheme: {share: "{service}.{tld}"}}', /unknown key/],
  ['duplicate fixtures', 'data: {fixtures: [ui, ui]}', /duplicates/],
  ['numeric migration', 'data: {migrate: 123}', /migrate/],
  ['numeric kind', 'services: {web: {kind: 123}}', /kind/],
]) {
  test(`documented profile values reject ${name}`, () => {
    assert.throws(() => parse(`${fragment.startsWith('project:') ? '' : 'project: {slug: validation}\n'}${fragment}\n`), error);
  });
}

test('schema reference complete YAML block passes the actual profile parser', () => {
  const file = path.join(REPO_ROOT, 'skills/grove/references/runtime-profile.md');
  const blocks = [...readFileSync(file, 'utf8').matchAll(/```yaml\n([\s\S]*?)```/g)];
  assert.equal(blocks.length, 1, 'one complete canonical profile block');
  for (const [, yaml] of blocks) parseProfile(yaml, file);
});

test('validation reports configuration scope without claiming runtime ownership', () => {
  assert.match(formatValidateReport(parse('project: {slug: scope}')), /configuration only.*notMeasured/);
});

test('custom runtime backend options remain owned by the project', () => {
  const profile = parse('project: {slug: custom}\nruntime: {default: local, profiles: {local: {backend: custom, socket_path: /tmp/example}}}');
  assert.equal(profile.runtime.profiles.local.socket_path, '/tmp/example');
});
