// Resolve hostnames from in-repo yaml. No home-directory config.
// Precedence for tld: project .local.yml → profile → grove .local.yml → grove addressing.yml → localhost.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const INFRA_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const GROVE_ADDRESSING_FILE = path.join(INFRA_DIR, 'addressing.yml');
export const GROVE_ADDRESSING_LOCAL_FILE = path.join(INFRA_DIR, 'addressing.local.yml');

export const DEFAULT_SCHEME = Object.freeze({
  shared: '{service}.{project}.{tld}',
  overlay: '{service}--{env}.{project}.{tld}',
});

const GROVE_KEYS = new Set(['tld', 'scheme']);
const SCHEME_KEYS = new Set(['shared', 'overlay']);
const SCHEME_TOKENS = new Set(['service', 'env', 'project', 'tld', 'namespace']);
function schemeToken() {
  return /\{([a-z]+)\}/g;
}
const DNS_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const TLD = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function readYamlFile(file) {
  if (!existsSync(file)) return null;
  const doc = parse(readFileSync(file, 'utf8'));
  if (doc == null) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    fail(file, 'must be a yaml map.');
  }
  return doc;
}

export function assertTld(value, source, field = 'tld') {
  if (typeof value !== 'string' || !TLD.test(value) || value.includes('*')) {
    fail(
      source,
      `${field} must be a lowercase DNS name (localhost or local.example.com), no wildcards — ${JSON.stringify(value)}`
    );
  }
  return value;
}

function assertHostname(value, source, field = 'hostname') {
  if (typeof value !== 'string' || value.length > 253 || !TLD.test(value)) {
    fail(source, `${field} is not a valid lowercase hostname — ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertScheme(value, field, source, requiredTokens = []) {
  if (typeof value !== 'string') {
    fail(source, `scheme.${field} must be a string.`);
  }
  const tokens = new Set();
  for (const match of value.matchAll(schemeToken())) {
    if (!SCHEME_TOKENS.has(match[1])) {
      fail(source, `scheme.${field} has unknown token {${match[1]}}`);
    }
    tokens.add(match[1]);
  }
  if (/[{}]/.test(value.replaceAll(schemeToken(), 'x'))) {
    fail(source, `scheme.${field} has malformed token braces.`);
  }
  for (const token of requiredTokens) {
    if (!tokens.has(token)) {
      fail(source, `scheme.${field} must contain {${token}}.`);
    }
  }
  const sample = value.replaceAll(schemeToken(), (_, name) =>
    name === 'tld' ? 'localhost' : 'x'
  );
  assertHostname(sample, source, `scheme.${field} sample hostname`);
  return value;
}

function validateSchemeMap(raw, source, field = 'scheme') {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, `${field} must be a map.`);
  }
  for (const key of Object.keys(raw)) {
    if (!SCHEME_KEYS.has(key)) fail(source, `${field} has unknown key ${JSON.stringify(key)}.`);
  }
  if (raw.shared != null) {
    assertScheme(raw.shared, 'shared', source, ['service', 'tld']);
  }
  if (raw.overlay != null) {
    assertScheme(raw.overlay, 'overlay', source, ['service', 'env', 'tld']);
  }
  return raw;
}

export function projectLocalProfilePath(profilePath) {
  if (profilePath.endsWith('.local.yml')) return profilePath;
  return profilePath.replace(/(\.ya?ml)$/i, '.local$1');
}

export function loadGroveAddressing(infraDir = INFRA_DIR) {
  const committedPath = path.join(infraDir, 'addressing.yml');
  const localPath = path.join(infraDir, 'addressing.local.yml');
  const committed = readYamlFile(committedPath) ?? {};
  const local = readYamlFile(localPath) ?? {};
  for (const doc of [
    [committed, committedPath],
    [local, localPath],
  ]) {
    const [body, file] = doc;
    if (!existsSync(file) && Object.keys(body).length === 0) continue;
    for (const key of Object.keys(body)) {
      if (!GROVE_KEYS.has(key)) fail(file, `unknown key "${key}"`);
    }
  }
  const committedScheme = validateSchemeMap(committed.scheme, committedPath);
  const localScheme = validateSchemeMap(local.scheme, localPath);
  const tld = local.tld != null ? assertTld(local.tld, localPath) : null;
  const committedTld = committed.tld != null ? assertTld(committed.tld, committedPath) : null;
  const scheme = {
    shared: assertScheme(
      localScheme.shared ?? committedScheme.shared ?? DEFAULT_SCHEME.shared,
      'shared',
      localScheme.shared != null ? localPath : committedPath,
      ['service', 'tld']
    ),
    overlay: assertScheme(
      localScheme.overlay ?? committedScheme.overlay ?? DEFAULT_SCHEME.overlay,
      'overlay',
      localScheme.overlay != null ? localPath : committedPath,
      ['service', 'env', 'tld']
    ),
  };
  return {
    tld: committedTld,
    localTld: tld,
    scheme,
    committedPath,
    localPath,
    hasLocal: existsSync(localPath),
  };
}

export function loadProjectLocalAddressing(profilePath) {
  const file = projectLocalProfilePath(profilePath);
  const doc = readYamlFile(file);
  if (doc == null) return { tld: null, scheme: null, file };
  const raw = doc.addressing;
  if (raw == null) return { tld: null, scheme: null, file };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(file, 'addressing must be a map.');
  }
  const scheme = raw.scheme == null
    ? null
    : validateSchemeMap(raw.scheme, file, 'addressing.scheme');
  return {
    tld: raw.tld != null ? assertTld(raw.tld, file) : null,
    scheme,
    file,
  };
}

function firstDefined(pairs) {
  for (const [value, source] of pairs) {
    if (value != null && value !== '') return { value, source };
  }
  return { value: 'localhost', source: 'default' };
}

export function resolveAddressing(profile, options = {}) {
  const infraDir = options.infraDir ?? INFRA_DIR;
  const grove = loadGroveAddressing(infraDir);
  const projectLocal = options.profilePath
    ? loadProjectLocalAddressing(options.profilePath)
    : { tld: null, scheme: null };

  const tldPick = firstDefined([
    [projectLocal.tld, 'project.local'],
    [profile.addressing?.tld, 'profile'],
    [grove.localTld, 'grove.local'],
    [grove.tld, 'grove'],
  ]);
  assertTld(tldPick.value, tldPick.source);

  const shared =
    projectLocal.scheme?.shared ??
    profile.addressing?.scheme?.shared ??
    grove.scheme.shared;
  const overlayScheme =
    projectLocal.scheme?.overlay ??
    profile.addressing?.scheme?.overlay ??
    grove.scheme.overlay;
  assertScheme(shared, 'shared', tldPick.source, ['service', 'tld']);
  if (overlayScheme) {
    assertScheme(overlayScheme, 'overlay', tldPick.source, ['service', 'env', 'tld']);
  }
  if (profile.overlay?.mode === 'on' && !overlayScheme) {
    fail(tldPick.source, 'overlay is on but scheme.overlay is missing.');
  }

  return {
    tld: tldPick.value,
    tldSource: tldPick.source,
    scheme: { shared, overlay: overlayScheme ?? null },
    proxy: profile.addressing?.proxy ?? 'none',
  };
}

export function renderHost(scheme, tokens) {
  assertScheme(scheme, 'render', 'render');
  const rendered = scheme.replaceAll(schemeToken(), (_, name) => {
    const rawValue = tokens[name];
    const value = name === 'namespace' && typeof rawValue === 'string'
      ? rawValue.replaceAll('_', '-')
      : rawValue;
    if (value == null || value === '') {
      throw new Error(`scheme token {${name}} has no value.`);
    }
    if (name !== 'tld' && (typeof value !== 'string' || !DNS_LABEL.test(value))) {
      throw new Error(`{${name}} is not a DNS label — ${JSON.stringify(value)}`);
    }
    if (name === 'tld') assertTld(value, 'render');
    return value;
  });
  return assertHostname(rendered, 'render');
}

export function renderProjectUrls(profile, addressing, { env } = {}) {
  const tokens = {
    project: profile.project.host,
    tld: addressing.tld,
    namespace: profile.project.namespace,
  };
  const names = Object.keys(profile.services);
  const shared = names.map((service) => ({
    service,
    role: 'shared',
    host: renderHost(addressing.scheme.shared, { ...tokens, service }),
  }));
  let overlay = null;
  if (env != null) {
    if (profile.overlay?.mode !== 'on') {
      throw new Error('urls --env requires overlay to be on in the profile.');
    }
    if (!addressing.scheme.overlay) {
      throw new Error('urls --env needs addressing.scheme.overlay.');
    }
    overlay = names.map((service) => ({
      service,
      role: 'overlay',
      env,
      host: renderHost(addressing.scheme.overlay, { ...tokens, service, env }),
    }));
  }
  return { shared, overlay };
}

export function formatUrlsReport(profile, addressing, urls) {
  const serviceCount = Object.keys(profile.services).length;
  const lines = [
    `■ ${profile.project.slug} — urls`,
    `  tld      ${addressing.tld}  (${addressing.tldSource})`,
    `  shared   ${urls.shared.length}/${serviceCount}`,
  ];
  for (const row of urls.shared) {
    lines.push(`           ${row.host}`);
  }
  if (urls.overlay) {
    lines.push(`  overlay  ${urls.overlay.length}/${serviceCount}  env ${urls.overlay[0]?.env ?? ''}`);
    for (const row of urls.overlay) {
      lines.push(`           ${row.host}`);
    }
  }
  return lines.join('\n');
}

// Machine-readable urls. Overlay is an empty list without --env so a reader
// never has to distinguish null from absent.
export function formatUrlsJson(addressing, urls) {
  return JSON.stringify(
    {
      tld: addressing.tld,
      shared: urls.shared.map((row) => ({ service: row.service, host: row.host })),
      overlay: (urls.overlay ?? []).map((row) => ({ service: row.service, env: row.env, host: row.host })),
    },
    null,
    2
  );
}

export function parseUrlsArgs(args) {
  let root;
  let env = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      if (json) throw new Error('--json may be passed only once.');
      json = true;
      continue;
    }
    if (arg === '--env') {
      const value = args[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error('--env needs a value.');
      }
      i += 1;
      env = value;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown option "${arg}"`);
    }
    if (root != null) {
      throw new Error(`only one project root — ${JSON.stringify(arg)}`);
    }
    root = arg;
  }
  return { root, env, json };
}
