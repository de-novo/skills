// overlay — this project's Grove overlay adapter.
//
//   node tools/overlay.mjs create  <env> [--apply]
//   node tools/overlay.mjs attach  <env> <service> --image REF [--apply]
//   node tools/overlay.mjs detach  <env> <service> [--apply]
//   node tools/overlay.mjs destroy <env> [--apply]
//   node tools/overlay.mjs status  [env]
//
// An environment is a directory under the sandbox's run/overlays. Attach
// starts the image's own process on a kernel-assigned port and records the
// endpoint; status asks each recorded endpoint what it is running and whether
// it is ready, so the inventory is an observation of the runtime and never a
// copy of what was requested. Every refusal is decided before anything is
// touched and carries mutated: false, which is what lets Grove withdraw the
// journal it wrote and leave the environment usable.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROJECT_ROOT,
  Refusal,
  assertSandbox,
  baselineRecord,
  emit,
  ensureDir,
  imageDir,
  logFile,
  notesFile,
  overlayDir,
  overlayRecord,
  probe,
  readJson,
  removeQuietly,
  runPath,
  startProcess,
  stopProcess,
  waitUntilReady,
  writeJson,
} from './lib/sandbox.mjs';
import { readProfile, renderHost } from './lib/profile.mjs';

const VERBS = new Set(['create', 'attach', 'detach', 'destroy', 'status']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  let image = null;
  let apply = false;
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--image') { image = rest[index + 1] ?? null; index += 1; continue; }
    if (arg.startsWith('--')) throw new Refusal(`unknown option ${JSON.stringify(arg)}`);
    positionals.push(arg);
  }
  return { verb, env: positionals[0] ?? null, service: positionals[1] ?? null, image, apply };
}

// The services this backend can overlay are the ones it has sources for. The
// router is a project service with no image: it serves every name and is
// never a second copy of itself.
function overlayableServices() {
  const app = path.join(PROJECT_ROOT, 'app');
  return existsSync(app) ? readdirSync(app, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

// Validate first, mutate second: everything this function rejects is rejected
// before a directory is made or a process is started.
function validate(request, profile) {
  if (!VERBS.has(request.verb)) throw new Refusal(`unsupported verb ${JSON.stringify(request.verb ?? null)}`);
  const needsEnv = request.verb !== 'status';
  if (needsEnv && request.env == null) throw new Refusal(`${request.verb} requires an environment`);
  if (request.env != null && !DNS_LABEL.test(request.env)) {
    throw new Refusal(`environment must be a DNS label of at most 63 characters — ${JSON.stringify(request.env)}`);
  }
  if (request.verb !== 'attach' && request.verb !== 'detach') return;
  const services = overlayableServices();
  if (request.service == null) throw new Refusal(`${request.verb} requires a service`);
  if (!services.includes(request.service)) {
    throw new Refusal(`this backend overlays only ${services.join(', ')} — ${JSON.stringify(request.service)} has no image`);
  }
  if (request.verb !== 'attach') return;
  const expected = new RegExp(`^${profile.slug}/${request.service}:([0-9a-f]{40})$`);
  const match = expected.exec(String(request.image ?? ''));
  if (match == null) {
    throw new Refusal(`image ${JSON.stringify(request.image ?? null)} is not ${profile.slug}/${request.service} at a full 40-character git sha`);
  }
  if (!existsSync(path.join(imageDir(request.service, match[1]), 'image.json'))) {
    throw new Refusal(`image ${request.image} has not been built in this sandbox`);
  }
}

// One observation of one running instance. The image is what the process says
// it is, not what the record asked for, and ready is the service's own health
// answer. During a replacement the previous instance is stopped first, so a
// half-replaced service reports ready: false rather than the new revision.
async function observeService(env, service) {
  const record = readJson(overlayRecord(env, service));
  if (record == null) return null;
  const observed = await probe(record.url);
  return {
    service,
    image: observed.ok ? observed.body.image : record.image,
    ready: observed.ok === true && observed.body?.image === record.image,
  };
}

function recordedServices(env) {
  const dir = path.join(overlayDir(env), 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
}

function trackedEnvironments() {
  const dir = runPath('overlays');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

// Built from the runtime on every call. An environment stays present until
// everything it owns is gone.
async function inventory(only) {
  const names = only == null ? trackedEnvironments() : trackedEnvironments().filter((name) => name === only);
  const environments = [];
  for (const env of names) {
    const services = [];
    for (const service of recordedServices(env)) {
      const observation = await observeService(env, service);
      if (observation != null) services.push(observation);
    }
    environments.push({ env, services });
  }
  return environments;
}

async function stopService(env, service) {
  const record = readJson(overlayRecord(env, service));
  const stopped = await stopProcess(record);
  if (!stopped) throw new Error(`${service} in ${env} (pid ${record?.pid}) is still running after a stop`);
  removeQuietly(overlayRecord(env, service));
}

async function attach(env, service, image, profile) {
  const revision = image.split(':').at(-1);
  ensureDir(path.join(overlayDir(env), 'services'));
  await stopService(env, service);
  const overlayName = (target) => renderHost(profile.scheme.overlay, profile, { service: target, env });
  const router = readJson(baselineRecord('router'));
  const endpoint = await startProcess({
    entry: path.join(imageDir(service, revision), 'server.mjs'),
    cwd: imageDir(service, revision),
    log: logFile(`${env}-${service}`),
    env: {
      PLAYGROUND_SERVICE: service,
      PLAYGROUND_IMAGE: image,
      PLAYGROUND_ENV: env,
      PLAYGROUND_NOTES_FILE: notesFile(),
      // The overlay web calls the api by its overlay name. Nothing is
      // attached under that name unless someone attached it, so the router
      // falls through to the baseline api and the page says so.
      ...(router?.url == null ? {} : { PLAYGROUND_ROUTER_URL: router.url }),
      PLAYGROUND_API_HOST: overlayName('api'),
    },
  });
  const record = { service, image, env, url: endpoint.url, pid: endpoint.pid, host: overlayName(service), started_at: new Date().toISOString() };
  writeJson(overlayRecord(env, service), record);
  const ready = await waitUntilReady(record.url);
  if (!ready.ok || ready.body?.image !== image) {
    throw new Error(`${service} in ${env} did not become ready as ${image} (${ready.error ?? `observed ${ready.body?.image}`})`);
  }
  return record;
}

async function run(request, profile) {
  const receipt = { ok: true, verb: request.verb, plan: !request.apply && request.verb !== 'status' };
  if (request.env != null) receipt.env = request.env;
  if (request.service != null) receipt.service = request.service;
  if (request.image != null) receipt.image = request.image;

  if (request.verb === 'status') {
    receipt.environments = await inventory(request.env);
    return receipt;
  }
  if (!request.apply) return receipt;

  switch (request.verb) {
    case 'create':
      ensureDir(path.join(overlayDir(request.env), 'services'));
      writeJson(path.join(overlayDir(request.env), 'environment.json'), { env: request.env, created_at: new Date().toISOString() });
      break;
    case 'attach': {
      const record = await attach(request.env, request.service, request.image, profile);
      receipt.upstream = record.url;
      break;
    }
    case 'detach':
      await stopService(request.env, request.service);
      break;
    case 'destroy':
      for (const service of recordedServices(request.env)) await stopService(request.env, service);
      removeQuietly(overlayDir(request.env));
      break;
    default:
      throw new Refusal(`unsupported verb ${JSON.stringify(request.verb)}`);
  }
  return receipt;
}

// Parse, then refuse, then act — and answer with one JSON object either way.
// A parse error is itself a refusal: nothing has been touched yet.
const entry = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (entry) {
  let request = { verb: process.argv[2] ?? null, env: null, service: null, image: null, apply: false };
  try {
    request = parseArgs(process.argv.slice(2));
    assertSandbox();
    const profile = readProfile();
    validate(request, profile);
    emit(await run(request, profile));
  } catch (error) {
    if (error instanceof Refusal) {
      // Refused before the runtime was touched, so Grove withdraws the
      // pending journal it wrote and the environment stays usable.
      emit({ ok: false, verb: request.verb, env: request.env, service: request.service, image: request.image, mutated: false, error: error.message });
    } else {
      // Something may already have happened. No mutated: false here: the
      // operation stays pending until the same command is rerun.
      console.error(`overlay ${request.verb}: ${error.message}`);
      emit({ ok: false, verb: request.verb, env: request.env, service: request.service, image: request.image, error: error.message });
    }
    process.exit(1);
  }
}
