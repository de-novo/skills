#!/usr/bin/env node
// de-novo skills — Grove CLI. yaml is source of truth; the CLI paints it.
// Invoke as `de-novo skills …`. de-novo-skills is an alias without the
// skills namespace. There is no down command: several projects live on
// machine infra, so a human decides when to stop it.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatUrlsJson,
  formatUrlsReport,
  loadGroveAddressing,
  parseUrlsArgs,
  renderProjectUrls,
  resolveAddressing,
} from '../lib/addressing.mjs';
import { runInit } from '../lib/init.mjs';
import { formatValidateReport, parseProfile } from '../lib/profile.mjs';
import { COMPOSE_NETWORK, ENGINES, canonicalizeEngine } from '../lib/engines.mjs';
import {
  compareK3dLinks,
  formatK3dLinkReport,
  k3dServerContainer,
  parseK3dArgs,
  renderK3dLinkManifests,
  writeTemporaryKubeconfig,
} from '../lib/k3d-link.mjs';
import {
  overlayHelp,
  parseOverlayCliArgs,
  runOverlayLifecycle,
} from '../lib/overlay.mjs';
import { dryadHelp, parseDryadCliArgs, recordSeatCliEvent, runDryad } from '../lib/dryad.mjs';
import { runCanopy } from '../lib/canopy.mjs';
import {
  COMPOSE_FILE,
  COMPOSE_UP_FLAGS,
  PROVISION,
  containerState,
  resolveProfilePath,
  run,
  runSetup,
} from './setup.mjs';

export const CLI = 'de-novo skills';

export function invokedName(argv1 = process.argv[1]) {
  if (!argv1) return 'cli';
  return path.basename(argv1).replace(/\.(mjs|js)$/, '');
}

// `de-novo skills infra status` — the org bin requires the skills namespace.
// `de-novo-skills` and `node cli.mjs` skip that token.
export function resolveInvocation(args, invoked = invokedName()) {
  if (invoked !== 'de-novo') return { args, error: null };
  const head = args[0];
  if (head == null || head === 'help' || head === '--help' || head === '-h') {
    return { args: ['help'], error: null };
  }
  if (head !== 'skills') {
    return { args: null, error: 'usage: de-novo skills <command>\nnamespaces: skills' };
  }
  return { args: args.slice(1), error: null };
}

// Engine names → compose services and profiles. Catalog is docker-compose.yml.
// No args: start nothing — pass names or run setup <project>.
export function resolveEngines(names) {
  const chosen = names.map((n) => canonicalizeEngine(n, 'up'));
  const services = [];
  const profiles = [];
  for (const canon of chosen) {
    const spec = ENGINES[canon];
    if (!services.includes(spec.service)) services.push(spec.service);
    if (spec.composeProfile && !profiles.includes(spec.composeProfile)) {
      profiles.push(spec.composeProfile);
    }
  }
  return { services, profiles };
}

function optionalPathArg(args, command) {
  if (args.length > 1) {
    throw new Error(`${command}: unexpected argument ${JSON.stringify(args[1])}`);
  }
  if (args[0]?.startsWith('--')) {
    throw new Error(`${command}: unknown option ${JSON.stringify(args[0])}`);
  }
  return args[0];
}

function requireNoArgs(args, command) {
  if (args.length > 0) {
    throw new Error(`${command}: unexpected argument ${JSON.stringify(args[0])}`);
  }
}

function cmdUp(args) {
  const { services, profiles } = resolveEngines(args);
  if (services.length === 0) {
    console.log(`engines 0/0: pass names (${CLI} infra up mysql) or ${CLI} setup <project>`);
    return 0;
  }
  const up = run(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      ...profiles.flatMap((p) => ['--profile', p]),
      'up',
      ...COMPOSE_UP_FLAGS,
      ...services,
    ],
    { stdio: 'inherit', encoding: undefined }
  );
  if (up.status !== 0) {
    console.error(`up: docker compose failed (exit ${up.status}).`);
    return 1;
  }
  // Exit 0 is not the same as the engine existing — inspect container state.
  const states = services.map((service) => {
    const spec = Object.values(ENGINES).find((e) => e.service === service);
    return { service, ...containerState(spec.container) };
  });
  const ready = states.filter((s) => s.ready).length;
  console.log(`engines ${ready}/${services.length}: ${states.map((s) => `${s.service}(${s.label})`).join(' ')}`);
  return ready === services.length ? 0 : 1;
}

export function formatInfraStatus() {
  const grove = loadGroveAddressing();
  const tld = grove.localTld ?? grove.tld ?? 'localhost';
  const tldSource = grove.localTld ? 'grove.local' : grove.tld ? 'grove' : 'default';
  const names = Object.keys(ENGINES);
  const lines = [
    '■ grove — machine infra',
    `  tld      ${tld}  (${tldSource})`,
    `  catalog  ${names.join(' ')}`,
  ];
  let ready = 0;
  for (const name of names) {
    const spec = ENGINES[name];
    const state = containerState(spec.container);
    if (state.ready) ready += 1;
    const label =
      state.label === 'missing'
        ? `not running (${CLI} infra up ${name})`
        : `${state.label}${state.ready ? ' ✓' : ''}`;
    lines.push(`  ${name.padEnd(6)} ${spec.service.padEnd(8)} ${label}`);
  }
  lines.push(`  ready    ${ready}/${names.length}`);
  return lines.join('\n');
}

function cmdStatus(args = []) {
  requireNoArgs(args, 'infra status');
  console.log(formatInfraStatus());
  return 0;
}

function cmdInfra(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return cmdStatus();
    case 'status':
      return cmdStatus(rest);
    case 'up':
      return cmdUp(rest);
    case 'provision':
      return cmdProvision(rest);
    case 'k3d':
      return cmdInfraK3d(rest);
    case 'help':
    case '--help':
    case '-h':
      printInfraHelp();
      return 0;
    default:
      console.error(`${CLI} infra: unknown command "${sub}"\n`);
      printInfraHelp();
      return 1;
  }
}

function printInfraHelp() {
  console.log(`machine infra (Grove-central). Catalog: infra/docker-compose.yml.
TLD: infra/addressing.yml. Projects declare isolation units, not engines.

usage:
  ${CLI} infra status                 compose catalog, tld, ready n/n
  ${CLI} infra up [engine …]          start those compose engines
  ${CLI} infra provision (mysql|pg) <name>
                                      one database + dedicated account
  ${CLI} infra k3d connect --cluster NAME
                                      join cluster to compose network + write Services
  ${CLI} infra k3d status --cluster NAME

there is no down command.`);
}

function cmdProvision(args) {
  const result = spawnSync('bash', [PROVISION, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

function cmdDryad(args) {
  const options = parseDryadCliArgs(args);
  if (options.help) {
    console.log(dryadHelp(CLI));
    return 0;
  }
  return runDryad({ options });
}

function cmdOverlay(args) {
  const options = parseOverlayCliArgs(args);
  if (options.help) {
    console.log(overlayHelp(CLI));
    return 0;
  }
  const profilePath = resolveProfilePath(options.project);
  const profile = parseProfile(readFileSync(profilePath, 'utf8'), profilePath);
  return runOverlayLifecycle({ options, profile, profilePath });
}

function dockerNetworks(container) {
  const result = run('docker', [
    'inspect',
    '-f',
    '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}',
    container,
  ]);
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function dockerNetworkIp(container, network) {
  const result = run('docker', [
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    container,
  ]);
  if (result.status !== 0) return null;
  const ip = result.stdout.trim();
  return ip.length > 0 ? ip : null;
}

function writeK3dKubeconfig(cluster) {
  const result = run('k3d', ['kubeconfig', 'get', cluster]);
  if (result.status !== 0) {
    throw new Error(`k3d kubeconfig get ${cluster} failed: ${result.stderr.trim()}`);
  }
  return writeTemporaryKubeconfig(cluster, result.stdout);
}

function readKubernetesResources(kubeconfig, namespace) {
  const readList = (resource) => {
    const result = run('kubectl', [
      '--kubeconfig',
      kubeconfig,
      '-n',
      namespace,
      'get',
      resource,
      '-l',
      'app.kubernetes.io/managed-by=grove',
      '-o',
      'json',
    ]);
    if (result.status !== 0) {
      throw new Error(`kubectl get ${resource} failed: ${result.stderr.trim()}`);
    }
    let body;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new Error(`kubectl get ${resource} returned malformed JSON.`);
    }
    if (!Array.isArray(body.items)) {
      throw new Error(`kubectl get ${resource} did not return a List.`);
    }
    return body.items;
  };
  return {
    services: readList('services'),
    endpointSlices: readList('endpointslices.discovery.k8s.io'),
  };
}

function cmdInfraK3d(args) {
  const opts = parseK3dArgs(args);
  const node = k3dServerContainer(opts.cluster);
  const network = COMPOSE_NETWORK;
  if (opts.cluster === 'local') {
    console.error(
      `${CLI} infra k3d: --cluster local is the existing machine cluster; not a sandbox.`
    );
  }
  const nets = dockerNetworks(node);
  if (nets == null) {
    throw new Error(
      `k3d node ${node} not found — create a separate cluster on ${network} (do not reuse local).`
    );
  }
  let nodeOnNetwork = nets.includes(network);
  if (opts.verb === 'connect' && !opts.dryRun && !nodeOnNetwork) {
    const connect = run('docker', ['network', 'connect', network, node]);
    if (connect.status !== 0) {
      throw new Error(`docker network connect ${network} ${node} failed: ${connect.stderr.trim()}`);
    }
    nodeOnNetwork = true;
  }
  const links = [];
  const skipped = [];
  for (const [name, spec] of Object.entries(ENGINES)) {
    const state = containerState(spec.container);
    if (!state.ready) {
      skipped.push({ name, reason: 'not running' });
      continue;
    }
    const ip = dockerNetworkIp(spec.container, network);
    if (!ip) {
      skipped.push({ name, reason: `no IP on ${network}` });
      continue;
    }
    links.push({ name, ip, port: spec.port });
  }
  if (opts.verb === 'connect') {
    if (links.length === 0) {
      throw new Error('no running engines on the compose network to link.');
    }
    const yaml = renderK3dLinkManifests({ namespace: opts.namespace, links });
    if (opts.dryRun) {
      console.log(yaml);
      console.error(
        formatK3dLinkReport({
          cluster: opts.cluster,
          network,
          node,
          nodeOnNetwork,
          links,
          skipped,
          dryRun: true,
        })
      );
      return 0;
    }
  }

  const temporary = opts.kubeconfig == null ? writeK3dKubeconfig(opts.cluster) : null;
  const kubeconfig = opts.kubeconfig ?? temporary.file;
  try {
    if (opts.verb === 'connect') {
      const yaml = renderK3dLinkManifests({ namespace: opts.namespace, links });
      const apply = run('kubectl', ['--kubeconfig', kubeconfig, 'apply', '-f', '-'], {
        input: yaml,
      });
      if (apply.status !== 0) {
        throw new Error(`kubectl apply failed: ${apply.stderr.trim()}`);
      }
    }
    const actual = readKubernetesResources(kubeconfig, opts.namespace);
    const resources = compareK3dLinks({ links, ...actual });
    console.log(
      formatK3dLinkReport({
        cluster: opts.cluster,
        network,
        node,
        nodeOnNetwork,
        links,
        skipped,
        dryRun: false,
        resources,
      })
    );
    return nodeOnNetwork && resources.ready === resources.total && resources.drift.length === 0
      ? 0
      : 1;
  } finally {
    temporary?.cleanup();
  }
}

function printHelp() {
  console.log(`${CLI} — Grove CLI (yaml is source of truth; the CLI paints it)

machine (Grove-central — compose + addressing.yml):
  ${CLI} infra status                  catalog, tld, ready n/n
  ${CLI} infra up [engine …]           start those compose engines
  ${CLI} infra provision (mysql|pg) <name>
  ${CLI} infra k3d connect --cluster NAME

project:
  ${CLI} init [project-root] [--slug NAME]
                                 [--engines a,b] [--services a,b] [--force]
  ${CLI} validate [project-root|profile]
  ${CLI} urls [project-root|profile] [--env NAME] [--json]
                                 print hostnames (no listener)
  ${CLI} setup [project-root|profile]  owner-authorized engines + DB/account provisioning
  ${CLI} overlay <verb> ...            create/attach/detach/destroy/status/touch/prune
  ${CLI} dryad <verb> ...              plan/seat/report/status/finish/projects — seats for workers, no agent launch

local overview:
  ${CLI} canopy [--port N] [--once]    read-only dashboard at 127.0.0.1:7420; --once prints JSON

up, status, provision are aliases of infra up|status|provision.
there is no down command — several projects live on machine infra.`);
}

function main(argv) {
  const parsed = resolveInvocation(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 1;
  }
  const [command, ...rest] = parsed.args;
  switch (command) {
    case 'init':
      return runInit(rest);
    case 'setup':
      return runSetup(optionalPathArg(rest, 'setup'));
    case 'validate': {
      const profilePath = resolveProfilePath(optionalPathArg(rest, 'validate'));
      const profile = parseProfile(readFileSync(profilePath, 'utf8'), profilePath);
      const addressing = resolveAddressing(profile, { profilePath });
      console.log(formatValidateReport(profile, addressing));
      return 0;
    }
    case 'urls': {
      const { root, env, json } = parseUrlsArgs(rest);
      const profilePath = resolveProfilePath(root);
      const profile = parseProfile(readFileSync(profilePath, 'utf8'), profilePath);
      const addressing = resolveAddressing(profile, { profilePath });
      const urls = renderProjectUrls(profile, addressing, { env });
      console.log(json ? formatUrlsJson(addressing, urls) : formatUrlsReport(profile, addressing, urls));
      return 0;
    }
    case 'overlay':
      return cmdOverlay(rest);
    case 'dryad':
      return cmdDryad(rest);
    case 'canopy':
      return runCanopy(rest);
    case 'infra':
      return cmdInfra(rest);
    case 'up':
      return cmdUp(rest);
    case 'status':
      return cmdStatus(rest);
    case 'provision':
      return cmdProvision(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`${CLI}: unknown command "${command}"\n`);
      printHelp();
      return 1;
  }
}

// Compare argv[1] via realpath. npm link bins are symlinks, so a string
// compare misses main and exits 0 — a quiet false pass.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  let code;
  try {
    code = await main(argv);
  } catch (error) {
    console.error(`${CLI}: ${error.message}`);
    code = 1;
  }
  // A seat journals the state-changing verbs it ran, whatever they returned.
  // recordSeatCliEvent never throws: observing a command must not fail it.
  recordSeatCliEvent(resolveInvocation(argv).args ?? argv, code);
  process.exitCode = code;
}
