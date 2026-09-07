// build — copy one service's sources into an image directory named for a full
// git sha, under the sandbox's run/ area. That directory is this example's
// image; its reference is <slug>/<service>:<40-hex sha>. Nothing mutable is
// accepted, so an image reference always names one revision of one source
// tree and the adapter can refuse anything else.
//
//   node tools/build.mjs <service> [--sha SHA] [--json]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertSandbox, PROJECT_ROOT, Refusal, emit, ensureDir, imageDir, writeJson } from './lib/sandbox.mjs';
import { readProfile } from './lib/profile.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;

export function imageReference(profile, service, revision) {
  return `${profile.slug}/${service}:${revision}`;
}

function headRevision() {
  return execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// Build once, reuse afterwards: two builds of the same revision must produce
// the same directory rather than a second one.
export function buildImage({ service, revision, profile }) {
  const source = path.join(PROJECT_ROOT, 'app', service);
  if (!existsSync(source)) throw new Refusal(`no source for service ${JSON.stringify(service)} at app/${service}`);
  if (!FULL_SHA.test(revision)) throw new Refusal(`revision must be a full 40-character git sha — ${JSON.stringify(revision)}`);
  const image = imageReference(profile, service, revision);
  const target = imageDir(service, revision);
  if (existsSync(path.join(target, 'image.json'))) return { image, dir: target, built: false };
  ensureDir(path.dirname(target));
  const staging = `${target}.${process.pid}.staging`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  writeJson(path.join(staging, 'image.json'), { image, service, revision, files: readdirSync(source).sort() });
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return { image, dir: target, built: true };
}

function main(argv) {
  const json = argv.includes('--json');
  const positionals = [];
  let revision = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (arg === '--sha') { revision = argv[index + 1] ?? null; index += 1; continue; }
    if (arg.startsWith('--')) throw new Refusal(`unknown option ${JSON.stringify(arg)}`);
    positionals.push(arg);
  }
  if (positionals.length !== 1) throw new Refusal('usage: node tools/build.mjs <service> [--sha SHA] [--json]');
  assertSandbox();
  const profile = readProfile();
  const result = buildImage({ service: positionals[0], revision: revision ?? headRevision(), profile });
  if (!json) console.error(`image ${result.image} ${result.built ? 'built' : 'reused'} at ${result.dir}`);
  emit({ ok: true, verb: 'build', service: positionals[0], ...result });
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    emit({ ok: false, verb: 'build', mutated: false, error: error.message });
    process.exit(1);
  }
}
