// Engine catalog is docker-compose.yml. Do not keep a second name list.
// Engine id = the compose profile. container_name, ground.provision, ground.aliases
// are read from the service. CLI paints compose; it does not own the catalog.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const INFRA_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const COMPOSE_FILE = path.join(INFRA_DIR, 'docker-compose.yml');

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function labelsOf(spec) {
  const raw = spec?.labels;
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (!Array.isArray(raw)) return {};
  const out = {};
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cut = item.indexOf('=');
    if (cut < 1) continue;
    out[item.slice(0, cut)] = item.slice(cut + 1);
  }
  return out;
}

function validPort(value, source, service) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(source, `service ${service}: port must be an integer from 1 to 65535.`);
  }
  return port;
}

export function parseComposeEngines(doc, source = 'docker-compose.yml') {
  const services = doc?.services;
  if (services == null || typeof services !== 'object' || Array.isArray(services)) {
    fail(source, 'compose services must be a map.');
  }
  const engines = {};
  const aliases = {};
  for (const [service, spec] of Object.entries(services)) {
    if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const profiles = spec.profiles;
    if (profiles == null) continue;
    if (!Array.isArray(profiles) || profiles.length !== 1 || typeof profiles[0] !== 'string') {
      fail(source, `service ${service}: exactly one compose profile (the engine name).`);
    }
    const name = profiles[0];
    if (engines[name]) {
      fail(source, `engine "${name}" declared twice (${engines[name].service} and ${service}).`);
    }
    const container = spec.container_name;
    if (typeof container !== 'string' || container.length === 0) {
      fail(source, `service ${service}: container_name is required.`);
    }
    if (
      spec.healthcheck == null ||
      typeof spec.healthcheck !== 'object' ||
      Array.isArray(spec.healthcheck) ||
      spec.healthcheck.disable === true ||
      spec.healthcheck.test == null
    ) {
      fail(source, `service ${service}: an explicit enabled healthcheck is required.`);
    }
    const labels = labelsOf(spec);
    const provision = labels['ground.provision'] || null;
    if (provision != null && provision !== 'mysql' && provision !== 'pg') {
      fail(source, `service ${service}: ground.provision must be mysql or pg.`);
    }
    const port = clusterPortOf(spec, labels, source, service);
    engines[name] = {
      service,
      container,
      composeProfile: name,
      port,
      hasHealthcheck: true,
      ...(provision ? { provision } : {}),
    };
    const aliasCsv = labels['ground.aliases'];
    if (typeof aliasCsv === 'string' && aliasCsv.trim()) {
      for (const alias of aliasCsv.split(',').map((item) => item.trim()).filter(Boolean)) {
        if (aliases[alias] && aliases[alias] !== name) {
          fail(source, `alias "${alias}" maps to both ${aliases[alias]} and ${name}.`);
        }
        aliases[alias] = name;
      }
    }
  }
  for (const [alias, name] of Object.entries(aliases)) {
    if (alias in engines) {
      fail(source, `alias "${alias}" for ${name} shadows the canonical engine "${alias}".`);
    }
  }
  const network = doc?.networks?.default?.name ?? 'dev-infra';
  if (network !== 'dev-infra') {
    fail(source, `networks.default.name must remain "dev-infra" (got ${JSON.stringify(network)}).`);
  }
  return { engines, aliases, network };
}

function clusterPortOf(spec, labels, source, service) {
  const labeled = labels['ground.port'];
  if (labeled != null && labeled !== '') {
    return validPort(labeled, source, service);
  }
  const ports = spec.ports;
  if (!Array.isArray(ports) || ports.length === 0) {
    fail(source, `service ${service}: ground.port or ports is required.`);
  }
  const first = ports[0];
  if (typeof first === 'number') return validPort(first, source, service);
  if (typeof first === 'object' && first != null && first.target != null) {
    return validPort(first.target, source, service);
  }
  if (typeof first === 'string') {
    const parts = first.split(':');
    const last = Number(parts[parts.length - 1]);
    if (Number.isInteger(last)) return validPort(last, source, service);
  }
  fail(source, `service ${service}: cannot read cluster port from ports.`);
}

export function loadComposeEngines(composeFile = COMPOSE_FILE) {
  if (!existsSync(composeFile)) {
    fail(composeFile, 'docker-compose.yml not found.');
  }
  const doc = parse(readFileSync(composeFile, 'utf8'));
  return parseComposeEngines(doc, composeFile);
}

const loaded = loadComposeEngines(COMPOSE_FILE);
export const ENGINES = loaded.engines;
export const ALIASES = loaded.aliases;
export const COMPOSE_NETWORK = loaded.network;

export function canonicalizeEngine(name, source = 'engines') {
  const canon = ALIASES[name] ?? name;
  if (!(canon in ENGINES)) {
    fail(source, `unknown engine "${name}" — supported: ${Object.keys(ENGINES).join(', ')}`);
  }
  return canon;
}
