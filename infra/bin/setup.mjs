#!/usr/bin/env node
// Read a project's .agents/runtime-profile.yml (data.engines) and prepare
// only those engines on machine-shared infra:
//   start engines (--wait) → provision databases (idempotent) → counted summary.
// yaml is source of truth; this script paints it — do not pick engines by hand.
//
//   node infra/bin/setup.mjs <project-root | profile-file>
//   (no arg: current directory is the project root)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALIASES, ENGINES } from '../lib/engines.mjs';
import { parseProfile } from '../lib/profile.mjs';

export { ALIASES, ENGINES };

const INFRA_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const COMPOSE_FILE = path.join(INFRA_DIR, 'docker-compose.yml');
export const PROVISION = path.join(INFRA_DIR, 'bin', 'provision');
// Engines already running are never recreated: several projects live on them,
// and a compose config-hash drift must not restart their containers under a
// project's setup. Measured 2026-09-06: without --no-recreate, `setup` on a
// throwaway profile recreated dev-pg16 and dev-redis7 (container IDs changed).
export const COMPOSE_UP_FLAGS = Object.freeze(['-d', '--no-recreate', '--wait']);
const PROFILE_RELPATH = path.join('.agents', 'runtime-profile.yml');

export function resolveProfilePath(arg, cwd = process.cwd()) {
  const target = path.resolve(cwd, arg ?? '.');
  if (existsSync(target) && statSync(target).isFile()) return target;
  const nested = path.join(target, PROFILE_RELPATH);
  if (existsSync(nested)) return nested;
  throw new Error(
    `runtime profile not found: ${nested}\n` +
      `no ${PROFILE_RELPATH} in the project root — ` +
      `plant a minimal profile with de-novo skills init ${arg ?? '.'}`
  );
}

// parseProfile, then require machine. Return shape tests expect:
// { slug, namespace, engines }.
export function readProfile(yamlText, source = 'runtime-profile.yml') {
  const parsed = parseProfile(yamlText, source);
  const infra = parsed.data.infra;
  if (infra !== 'machine') {
    throw new Error(
      `${source}: data.infra is not "machine" (got ${JSON.stringify(infra ?? null)}). ` +
        `this tool only sets up projects that use machine-shared infra — ` +
        `"project" means the project's own stack is source of truth.`
    );
  }
  return {
    slug: parsed.project.slug,
    namespace: parsed.project.namespace,
    engines: parsed.engines,
  };
}

// { slug, namespace, engines } → plan. Pure function, no docker.
export function planSetup({ slug, namespace, engines }) {
  const services = [];
  const composeProfiles = [];
  const provisions = [];
  const notes = [];
  for (const [name, spec] of Object.entries(ENGINES)) {
    const decl = engines[name];
    if (!decl) continue;
    services.push(spec.service);
    if (spec.composeProfile) composeProfiles.push(spec.composeProfile);
    if (spec.provision) {
      for (const db of decl.databases) provisions.push({ engine: spec.provision, name: db });
    }
  }
  if (engines.redis) notes.push(`redis key prefix "${engines.redis.prefix}" is an app convention`);
  if (engines.kafka) notes.push(`kafka topic/group prefix "${engines.kafka.topicPrefix}" is an app convention`);
  if (engines.mongo) notes.push(`mongo database(${engines.mongo.databases.join(', ')}) is created on first connect`);
  if (engines.minio) notes.push(`minio bucket "${engines.minio.bucket}" is created in the console (9001) or with mc`);
  return { slug, namespace: namespace ?? slug, services, composeProfiles, provisions, notes };
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function containerState(container) {
  const result = run('docker', [
    'inspect',
    '-f',
    '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    container,
  ]);
  if (result.status !== 0) return { ready: false, label: 'missing' };
  return stateFromInspect(result.stdout);
}

export function stateFromInspect(output) {
  const [running, health = ''] = String(output).trim().split('|');
  const ready = running === 'true' && health === 'healthy';
  const label = health || (running === 'true' ? 'healthcheck missing' : 'stopped');
  return { ready, label };
}

// Shared body for the CLI and direct execution. Returns an exit code.
export function runSetup(pathArg) {
  const profilePath = resolveProfilePath(pathArg);
  const profile = readProfile(readFileSync(profilePath, 'utf8'), profilePath);
  const plan = planSetup(profile);

  if (plan.services.length === 0) {
    console.log(`${profile.slug}: data.engines is empty — nothing to prepare.`);
    return 0;
  }

  const upArgs = [
    'compose',
    '-f',
    COMPOSE_FILE,
    ...plan.composeProfiles.flatMap((p) => ['--profile', p]),
    'up',
    ...COMPOSE_UP_FLAGS,
    ...plan.services,
  ];
  const up = run('docker', upArgs, { stdio: 'inherit', encoding: undefined });
  if (up.status !== 0) {
    console.error(`setup: docker compose up failed (exit ${up.status}).`);
    return 1;
  }

  // Exit 0 is not the same as the engine existing — inspect container state.
  const states = plan.services.map((service) => {
    const spec = Object.values(ENGINES).find((e) => e.service === service);
    return { service, ...containerState(spec.container) };
  });
  const readyCount = states.filter((s) => s.ready).length;
  const engineLine = states.map((s) => `${s.service}(${s.label})`).join(' ');

  let provisioned = 0;
  for (const { engine, name } of plan.provisions) {
    const result = run('bash', [PROVISION, engine, name]);
    if (result.status === 0) {
      provisioned += 1;
    } else {
      console.error(`provision ${engine} ${name} failed:\n${result.stderr}`);
    }
  }

  const nsSuffix = plan.namespace !== plan.slug ? ` (namespace: ${plan.namespace})` : '';
  console.log(`\n■ ${plan.slug}${nsSuffix} — machine-shared infra ready`);
  console.log(`  engines  ${readyCount}/${plan.services.length}: ${engineLine}`);
  if (plan.provisions.length > 0) {
    console.log(`  DBs      ${provisioned}/${plan.provisions.length}`);
  }
  for (const note of plan.notes) console.log(`  note     ${note}`);

  return readyCount === plan.services.length && provisioned === plan.provisions.length ? 0 : 1;
}

// Compare realpath so npm-link symlinks still count as main (same as cli.mjs).
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) {
      throw new Error(`unexpected argument ${JSON.stringify(args[1])}`);
    }
    if (args[0]?.startsWith('--')) {
      throw new Error(`unknown option ${JSON.stringify(args[0])}`);
    }
    process.exit(runSetup(args[0]));
  } catch (error) {
    console.error(`setup: ${error.message}`);
    process.exit(1);
  }
}
