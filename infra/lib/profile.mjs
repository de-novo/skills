// Full runtime-profile.yml document. Invariants are judged here only.
// data.infra: project is parsed too — separate from setup requiring machine.
import { parse } from 'yaml';

import { assertScheme, assertTld } from './addressing.mjs';
import { ALIASES, ENGINES } from './engines.mjs';

export const TOP_LEVEL_KEYS = Object.freeze([
  'version',
  'project',
  'addressing',
  'runtime',
  'services',
  'overlay',
  'data',
]);

const NS_PATTERN = /^[a-z][a-z0-9_-]*$/;
const DB_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROXY_VALUES = new Set(['none', 'machine', 'project', 'portless']);
const INFRA_VALUES = new Set(['machine', 'project']);
const PROFILE_VERSION = 1;
const VALIDATED_INVARIANTS = Object.freeze([
  'schema',
  'single_stack',
  'writers',
  'forbid_direct_db_writes',
  'engines',
]);

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, field, source) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(source, `${field} has unknown key ${JSON.stringify(key)}.`);
    }
  }
}

function nonEmptyString(value, field, source) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(source, `${field} must be a non-empty string.`);
  }
  return value;
}

function optionalMap(value, keys, field, source) {
  if (value == null) return;
  if (!isMap(value)) fail(source, `${field} must be a map.`);
  if (keys) assertOnlyKeys(value, keys, field, source);
}

function optionalString(value, field, source) {
  if (value != null) nonEmptyString(value, field, source);
}

function assertPort(value, field, source) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(source, `${field} must be an integer from 1 to 65535.`);
  }
}

function validateDocumentValues(doc, source) {
  assertOnlyKeys(doc.project, ['slug', 'namespace', 'host'], 'project', source);
  const runtime = doc.runtime ?? {};
  optionalMap(runtime, ['default', 'single_stack', 'writers', 'profiles', 'commands'], 'runtime', source);
  optionalMap(runtime.profiles, null, 'runtime.profiles', source);
  for (const [name, profile] of Object.entries(runtime.profiles ?? {})) {
    nonEmptyString(name, 'runtime profile name', source);
    // Backend-specific options belong to the chosen backend, not this parser.
    optionalMap(profile, null, `runtime.profiles.${name}`, source);
    if (profile == null) fail(source, `runtime.profiles.${name} must be a map.`);
    for (const field of ['backend', 'compose_file', 'cluster']) {
      optionalString(profile[field], `runtime.profiles.${name}.${field}`, source);
    }
  }
  if (runtime.default != null) {
    nonEmptyString(runtime.default, 'runtime.default', source);
    if (!Object.hasOwn(runtime.profiles ?? {}, runtime.default)) {
      fail(source, 'runtime.default must name a declared runtime profile.');
    }
  }
  optionalMap(runtime.commands, ['profile', 'status', 'up', 'overlay'], 'runtime.commands', source);
  for (const [name, command] of Object.entries(runtime.commands ?? {})) {
    nonEmptyString(command, `runtime.commands.${name}`, source);
  }
  const data = doc.data ?? {};
  assertOnlyKeys(data, ['infra', 'engines', 'migrate', 'fixtures', 'forbid_direct_db_writes'], 'data', source);
  optionalString(data.migrate, 'data.migrate', source);
  if (data.fixtures != null) {
    if (!Array.isArray(data.fixtures)) fail(source, 'data.fixtures must be a list.');
    for (const fixture of data.fixtures) nonEmptyString(fixture, 'data.fixtures entry', source);
    if (new Set(data.fixtures).size !== data.fixtures.length) fail(source, 'data.fixtures has duplicates.');
  }
}

function databasesOf(value, dbNamespace, engine, source) {
  const names = value === true ? [dbNamespace] : Array.isArray(value) ? value : null;
  if (!names || names.length === 0) {
    fail(source, `data.engines.${engine} must be true or a list of database names.`);
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.length > 63 || !DB_NAME_PATTERN.test(name)) {
      fail(source, `database name must match [a-z][a-z0-9_]* — ${JSON.stringify(name)}`);
    }
  }
  if (new Set(names).size !== names.length) {
    fail(source, `data.engines.${engine} has duplicate database names.`);
  }
  return [...names];
}

function parseEngines(raw, namespace, source) {
  const dbNamespace = namespace.replaceAll('-', '_');
  const engines = {};
  if (raw == null) return engines;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, 'data.engines must be a map.');
  }
  for (const [key, value] of Object.entries(raw)) {
    const canon = ALIASES[key] ?? key;
    if (!(canon in ENGINES)) {
      fail(source, `unknown engine "${key}" — supported: ${Object.keys(ENGINES).join(', ')}`);
    }
    if (canon in engines) {
      fail(source, `engine ${JSON.stringify(canon)} is declared more than once (including aliases).`);
    }
    switch (canon) {
      case 'mysql':
      case 'pg':
      case 'mongo':
        engines[canon] = { databases: databasesOf(value, dbNamespace, key, source) };
        break;
      case 'redis': {
        if (value === true) {
          engines.redis = { prefix: `${namespace}:` };
          break;
        }
        if (!isMap(value)) {
          fail(source, 'data.engines.redis must be true or { prefix: string }.');
        }
        assertOnlyKeys(value, ['prefix'], 'data.engines.redis', source);
        engines.redis = {
          prefix: nonEmptyString(value.prefix, 'data.engines.redis.prefix', source),
        };
        break;
      }
      case 'kafka': {
        if (value === true) {
          engines.kafka = { topicPrefix: `${namespace}.` };
          break;
        }
        if (!isMap(value)) {
          fail(source, 'data.engines.kafka must be true or { topic_prefix: string }.');
        }
        assertOnlyKeys(value, ['topic_prefix'], 'data.engines.kafka', source);
        engines.kafka = {
          topicPrefix: nonEmptyString(
            value.topic_prefix,
            'data.engines.kafka.topic_prefix',
            source
          ),
        };
        break;
      }
      case 'minio': {
        const bucket = value === true
          ? namespace.replaceAll('_', '-')
          : isMap(value)
            ? value.bucket
            : null;
        if (isMap(value)) assertOnlyKeys(value, ['bucket'], 'data.engines.minio', source);
        if (
          typeof bucket !== 'string' ||
          bucket.length < 3 ||
          bucket.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(bucket)
        ) {
          fail(source, 'data.engines.minio must be true or { bucket: lowercase-name }.');
        }
        engines.minio = { bucket };
        break;
      }
      case 'mail':
        if (value !== true) fail(source, 'data.engines.mail must be true.');
        engines.mail = {};
        break;
      default:
        if (value !== true) fail(source, `data.engines.${key} must be true.`);
        engines[canon] = {};
    }
  }
  return engines;
}

function assertDnsLabel(value, source, field) {
  if (typeof value !== 'string' || !DNS_LABEL.test(value)) {
    fail(
      source,
      `${field} must be a DNS label [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])? — ${JSON.stringify(value)}`
    );
  }
}

function parseOverlay(doc, serviceNames, source) {
  const configuredCommand = doc?.runtime?.commands?.overlay;
  if (
    configuredCommand != null &&
    (typeof configuredCommand !== 'string' || configuredCommand.trim().length === 0)
  ) {
    fail(source, 'runtime.commands.overlay must be a non-empty string.');
  }
  const command = configuredCommand ?? null;
  const raw = doc?.overlay;
  if (raw == null) {
    if (command) fail(source, 'runtime.commands.overlay requires an overlay block.');
    return { mode: 'off', explicitNone: false, attachable: [], sharedOnly: [], command: null, planFirst: true };
  }
  if (raw === 'none') {
    if (command) fail(source, 'overlay: none but runtime.commands.overlay is set.');
    return { mode: 'off', explicitNone: true, attachable: [], sharedOnly: [], command: null, planFirst: true };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, 'overlay must be none or an object.');
  }
  assertOnlyKeys(
    raw,
    ['attachable', 'shared_only', 'plan_first', 'image_tag', 'stale_after', 'create_on'],
    'overlay',
    source
  );
  const attachable = raw.attachable;
  if (!Array.isArray(attachable) || attachable.length === 0) {
    fail(source, 'overlay.attachable must be a non-empty list.');
  }
  for (const name of attachable) {
    if (typeof name !== 'string' || !serviceNames.has(name)) {
      fail(source, `overlay.attachable names a missing service ${JSON.stringify(name)}`);
    }
  }
  if (new Set(attachable).size !== attachable.length) {
    fail(source, 'overlay.attachable has duplicate service names.');
  }
  if (raw.shared_only != null && !Array.isArray(raw.shared_only)) {
    fail(source, 'overlay.shared_only must be a list.');
  }
  const sharedOnly = raw.shared_only ?? [];
  for (const name of sharedOnly) {
    if (typeof name !== 'string') fail(source, 'overlay.shared_only entries must be strings.');
    if (!serviceNames.has(name)) {
      fail(source, `overlay.shared_only names a missing service ${JSON.stringify(name)}`);
    }
    if (attachable.includes(name)) {
      fail(source, `overlay.shared_only overlaps attachable: ${name}`);
    }
  }
  if (new Set(sharedOnly).size !== sharedOnly.length) {
    fail(source, 'overlay.shared_only has duplicate service names.');
  }
  let planFirst = true;
  if (raw.plan_first != null) {
    if (raw.plan_first !== true && raw.plan_first !== false) {
      fail(source, 'overlay.plan_first must be true or false.');
    }
    planFirst = raw.plan_first;
  }
  const imageTag = raw.image_tag ?? 'full-git-sha';
  if (imageTag !== 'full-git-sha') {
    fail(source, 'overlay.image_tag must be full-git-sha.');
  }
  const staleAfter = raw.stale_after ?? null;
  if (staleAfter != null && !/^[1-9][0-9]*(?:s|m|h|d|w)$/.test(staleAfter)) {
    fail(source, 'overlay.stale_after must be a positive duration such as 12h or 7d.');
  }
  // create_on: plan (default) creates the environment when a seat is planned;
  // attach defers creation to the first applied attach, run from the caller's
  // worktree, for backends that bind an environment to a worktree revision.
  const createOn = raw.create_on ?? 'plan';
  if (createOn !== 'plan' && createOn !== 'attach') {
    fail(source, 'overlay.create_on must be plan or attach.');
  }
  return {
    mode: 'on',
    explicitNone: false,
    attachable: [...attachable],
    sharedOnly,
    command,
    planFirst,
    imageTag,
    staleAfter,
    createOn,
  };
}

function parseAddressing(raw, overlayOn, source) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, 'addressing must be a map.');
  }
  assertOnlyKeys(raw, ['tld', 'proxy', 'scheme', 'ports'], 'addressing', source);
  optionalMap(raw.ports, ['blocks', 'registry'], 'addressing.ports', source);
  optionalMap(raw.ports?.blocks, null, 'addressing.ports.blocks', source);
  for (const [name, port] of Object.entries(raw.ports?.blocks ?? {})) {
    nonEmptyString(name, 'port block name', source);
    assertPort(port, `addressing.ports.blocks.${name}`, source);
  }
  optionalString(raw.ports?.registry, 'addressing.ports.registry', source);
  let proxy = 'none';
  if (raw.proxy != null) {
    if (!PROXY_VALUES.has(raw.proxy)) {
      fail(source, `addressing.proxy must be none|machine|project|portless — ${JSON.stringify(raw.proxy)}`);
    }
    proxy = raw.proxy;
  }
  const scheme = raw.scheme ?? null;
  if (scheme != null) {
    if (typeof scheme !== 'object' || Array.isArray(scheme)) {
      fail(source, 'addressing.scheme must be a map.');
    }
    assertOnlyKeys(scheme, ['shared', 'overlay'], 'addressing.scheme', source);
    if (scheme.shared != null) {
      assertScheme(scheme.shared, 'shared', source, ['service', 'tld']);
    }
    if (scheme.overlay != null) {
      assertScheme(scheme.overlay, 'overlay', source, ['service', 'env', 'tld']);
    }
  }
  if (overlayOn && !scheme?.overlay) {
    fail(source, 'overlay is an object but addressing.scheme.overlay is missing.');
  }
  return {
    tld: raw.tld == null ? null : assertTld(raw.tld, source, 'addressing.tld'),
    scheme,
    proxy,
    ports: raw.ports ?? null,
  };
}

function parseServices(raw, source) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, 'services must be a map.');
  }
  const services = {};
  for (const [name, spec] of Object.entries(raw)) {
    assertDnsLabel(name, source, 'services key');
    if (!isMap(spec)) {
      fail(source, `services.${name} must be a map.`);
    }
    assertOnlyKeys(spec, ['kind', 'port', 'health', 'reflect'], `services.${name}`, source);
    optionalString(spec.kind, `services.${name}.kind`, source);
    if (spec.port != null) assertPort(spec.port, `services.${name}.port`, source);
    if (spec.health != null) {
      nonEmptyString(spec.health, `services.${name}.health`, source);
      if (!spec.health.startsWith('/') || spec.health.startsWith('//') || /\s/.test(spec.health)) {
        fail(source, `services.${name}.health must be an absolute HTTP path.`);
      }
    }
    if (spec.reflect != null && !['source', 'rebuild', 'restart'].includes(spec.reflect)) {
      fail(source, `services.${name}.reflect must be source|rebuild|restart.`);
    }
    services[name] = { ...spec };
  }
  return services;
}

function parseInvariantBool(value, omitDefault, field, source) {
  if (value == null) return omitDefault;
  if (value !== true) fail(source, `${field} must be true (got ${JSON.stringify(value)}).`);
  return true;
}

function parseWriters(value, source) {
  if (value == null) return 1;
  if (value !== 1) fail(source, `runtime.writers must be 1 (got ${JSON.stringify(value)}).`);
  return 1;
}

export function projectHostOf(slug, explicit) {
  return explicit ?? slug.replaceAll('_', '-');
}

export function parseProfile(yamlText, source = 'runtime-profile.yml') {
  const doc = parse(yamlText);
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(source, 'profile is not an object.');
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      fail(source, `unknown top-level key "${key}"`);
    }
  }

  if (doc.version != null && doc.version !== PROFILE_VERSION) {
    fail(source, `version must be ${PROFILE_VERSION} (got ${JSON.stringify(doc.version)}).`);
  }
  if (!isMap(doc.project)) {
    fail(source, 'project must be a map.');
  }
  if (doc.runtime != null && !isMap(doc.runtime)) {
    fail(source, 'runtime must be a map.');
  }
  const data = doc.data == null ? {} : doc.data;
  if (!isMap(data)) {
    fail(source, 'data must be a map.');
  }
  validateDocumentValues(doc, source);
  const infra = data.infra ?? 'machine';
  if (!INFRA_VALUES.has(infra)) {
    fail(source, `data.infra must be machine|project — ${JSON.stringify(infra)}`);
  }

  const slug = doc.project?.slug;
  if (typeof slug !== 'string' || !NS_PATTERN.test(slug)) {
    fail(source, 'project.slug is missing or malformed.');
  }
  const namespace = doc.project?.namespace ?? slug;
  if (typeof namespace !== 'string' || !NS_PATTERN.test(namespace)) {
    fail(source, 'project.namespace must match [a-z][a-z0-9_-]*.');
  }
  const host = projectHostOf(slug, doc.project?.host);
  assertDnsLabel(host, source, 'project.host');

  const singleStack = parseInvariantBool(
    doc.runtime?.single_stack,
    true,
    'runtime.single_stack',
    source
  );
  const writers = parseWriters(doc.runtime?.writers, source);
  const forbidDirectDbWrites = parseInvariantBool(
    data.forbid_direct_db_writes,
    true,
    'data.forbid_direct_db_writes',
    source
  );

  const services = parseServices(doc.services, source);
  const overlay = parseOverlay(doc, new Set(Object.keys(services)), source);
  const addressing = parseAddressing(doc.addressing, overlay.mode === 'on', source);
  const engines = parseEngines(data.engines, namespace, source);

  return {
    version: doc.version ?? PROFILE_VERSION,
    project: { slug, namespace, host },
    addressing,
    runtime: {
      default: doc.runtime?.default ?? null,
      singleStack,
      writers,
      profiles: doc.runtime?.profiles ?? null,
      commands: doc.runtime?.commands ?? null,
    },
    services,
    overlay,
    data: {
      infra,
      enginesRaw: data.engines ?? null,
      migrate: data.migrate ?? null,
      fixtures: data.fixtures ?? null,
      forbidDirectDbWrites,
    },
    engines,
  };
}

export function formatValidateReport(profile, resolvedAddressing = null) {
  const { overlay, addressing, project } = profile;
  let overlayLine;
  if (overlay.mode === 'off') {
    overlayLine = overlay.explicitNone ? 'inactive (overlay: none)' : 'inactive (omitted)';
  } else {
    const cmd = overlay.command ? 'command present' : 'command absent';
    const stale = overlay.staleAfter
      ? `stale_after ${overlay.staleAfter}`
      : 'stale_after not configured';
    overlayLine = `active (attachable ${overlay.attachable.length}, shared_only ${overlay.sharedOnly.length}, ${cmd}, ${stale})`;
  }
  let addrLine = 'omitted';
  if (resolvedAddressing) {
    const scheme = resolvedAddressing.scheme?.shared ? 'scheme ok' : 'scheme omitted';
    addrLine = `${scheme}, tld ${resolvedAddressing.tld} (${resolvedAddressing.tldSource}), proxy ${resolvedAddressing.proxy}`;
  } else if (addressing) {
    const tld = addressing.tld ?? '(inherited)';
    const scheme = addressing.scheme ? 'scheme ok' : 'scheme omitted';
    addrLine = `${scheme}, tld ${tld}, proxy ${addressing.proxy}`;
  }
  const invariantCount = VALIDATED_INVARIANTS.length;
  return [
    `■ ${project.slug} — profile`,
    `  invariants  ${invariantCount}/${invariantCount}: ${VALIDATED_INVARIANTS.join(' ')}`,
    '  scope     configuration only; runtime ownership, health, and routing notMeasured',
    `  overlay ${overlayLine}`,
    `  address   ${addrLine}`,
  ].join('\n');
}
