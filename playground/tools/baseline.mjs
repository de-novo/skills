// baseline — the project's own runtime commands, the ones the Grove profile
// names as runtime.commands.up and runtime.commands.status.
//
//   node tools/baseline.mjs up [--apply]
//   node tools/baseline.mjs status [--json]
//
// `up` builds an image for every service that has sources, seeds the notes
// file, starts the router and one instance of each service, and records each
// process where `status` and the overlay adapter can find it. Every listener
// binds port 0; the record is how anything learns what the kernel gave it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROJECT_ROOT,
  Refusal,
  alive,
  assertSandbox,
  baselineRecord,
  emit,
  ensureDir,
  imageDir,
  logFile,
  notesFile,
  probe,
  readJson,
  runPath,
  startProcess,
  waitUntilReady,
  writeJson,
} from './lib/sandbox.mjs';
import { readProfile, renderHost } from './lib/profile.mjs';
import { buildImage } from './build.mjs';

const SEED_NOTES = [
  { title: 'Names, not ports' },
  { title: 'One overlay beside the baseline' },
  { title: 'Health reaches nothing outside the process' },
];

function serviceSources() {
  const app = path.join(PROJECT_ROOT, 'app');
  return existsSync(app) ? readdirSync(app, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

function headRevision() {
  return execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function startBaseline({ name, entry, cwd, env }) {
  const existing = readJson(baselineRecord(name));
  if (existing != null && alive(existing.pid) && (await probe(existing.url)).ok) return { ...existing, started: false };
  const endpoint = await startProcess({ entry, cwd, env, log: logFile(`baseline-${name}`) });
  const record = { ...endpoint, pid: endpoint.pid, env: 'baseline', started_at: new Date().toISOString() };
  writeJson(baselineRecord(name), record);
  return { ...record, started: true };
}

export async function up({ apply, revision, profile }) {
  const services = serviceSources();
  const plan = services.map((service) => `${profile.slug}/${service}:${revision}`);
  if (!apply) return { ok: true, verb: 'up', plan: true, revision, would_start: ['router', ...services], images: plan };

  ensureDir(runPath('logs'));
  if (readJson(notesFile()) == null) writeJson(notesFile(), SEED_NOTES);

  const router = await startBaseline({
    name: 'router',
    entry: path.join(PROJECT_ROOT, 'tools', 'router.mjs'),
    cwd: PROJECT_ROOT,
    env: {},
  });
  const started = [];
  for (const service of services) {
    const { image } = buildImage({ service, revision, profile });
    const record = await startBaseline({
      name: service,
      entry: path.join(imageDir(service, revision), 'server.mjs'),
      cwd: imageDir(service, revision),
      env: {
        PLAYGROUND_SERVICE: service,
        PLAYGROUND_IMAGE: image,
        PLAYGROUND_ENV: 'baseline',
        PLAYGROUND_NOTES_FILE: notesFile(),
        PLAYGROUND_ROUTER_URL: router.url,
        PLAYGROUND_API_HOST: renderHost(profile.scheme.shared, profile, { service: 'api' }),
      },
    });
    const ready = await waitUntilReady(record.url);
    started.push({
      service,
      image,
      url: record.url,
      pid: record.pid,
      host: renderHost(profile.scheme.shared, profile, { service }),
      ready: ready.ok,
    });
  }
  return {
    ok: started.every((item) => item.ready),
    verb: 'up',
    plan: false,
    revision,
    router: { url: router.url, pid: router.pid, host: renderHost(profile.scheme.shared, profile, { service: 'router' }) },
    services: started,
  };
}

export async function status(profile) {
  const names = ['router', ...serviceSources()];
  const observed = [];
  for (const name of names) {
    const record = readJson(baselineRecord(name));
    if (record == null) {
      observed.push({ service: name, running: false, ready: false, url: null, pid: null, image: null });
      continue;
    }
    const health = await probe(record.url);
    observed.push({
      service: name,
      running: alive(record.pid),
      ready: health.ok,
      url: record.url,
      pid: record.pid,
      image: health.ok ? health.body.image : record.image ?? null,
      host: renderHost(profile.scheme.shared, profile, { service: name }),
    });
  }
  return { ok: observed.every((item) => item.ready), verb: 'status', baseline: observed };
}

async function main(argv) {
  const verb = argv[0];
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  assertSandbox();
  const profile = readProfile();
  if (verb === 'up') {
    const shaIndex = argv.indexOf('--sha');
    const revision = shaIndex >= 0 ? argv[shaIndex + 1] : headRevision();
    const receipt = await up({ apply, revision, profile });
    if (!json && receipt.plan === false) {
      console.error(`baseline ${receipt.services.filter((item) => item.ready).length}/${receipt.services.length}: ${receipt.services.map((item) => item.host).join(' ')} behind ${receipt.router.url}`);
    }
    emit(receipt);
    return receipt.ok ? 0 : 1;
  }
  if (verb === 'status') {
    const receipt = await status(profile);
    if (!json) console.error(`baseline ${receipt.baseline.filter((item) => item.ready).length}/${receipt.baseline.length} ready`);
    emit(receipt);
    return receipt.ok ? 0 : 1;
  }
  throw new Refusal('usage: node tools/baseline.mjs up [--apply] | status [--json]');
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    emit({ ok: false, verb: process.argv[2] ?? null, ...(error instanceof Refusal ? { mutated: false } : {}), error: error.message });
    process.exit(1);
  }
}
