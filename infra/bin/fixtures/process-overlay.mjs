// Isolated process backend for contract execution tests. Never uses shared infra.
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.GROVE_PROCESS_TEST_ROOT;
if (!root || !existsSync(join(root, 'process-test-marker'))) throw new Error('isolated test root required');
const [verb, env, service, ...args] = process.argv.slice(2);
if (env && env !== 'w1') throw new Error('test backend only owns w1');
if (verb === 'attach' && service !== 'api') throw new Error('test backend only owns api');
const marker = join(root, 'environment');
const endpointFile = join(root, 'endpoint.json');
const readEndpoint = () => existsSync(endpointFile) ? JSON.parse(readFileSync(endpointFile, 'utf8')) : null;
async function observe() {
  const endpoint = readEndpoint();
  if (!endpoint) return null;
  const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(2000) });
  const body = await response.json();
  return { service: 'api', image: body.image, ready: response.ok };
}
async function stop() {
  const endpoint = readEndpoint();
  if (!endpoint) return;
  await fetch(`${endpoint.url}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(endpoint.url, { signal: AbortSignal.timeout(100) }); }
    catch { unlinkSync(endpointFile); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('process still serves requests after shutdown');
}
const apply = process.argv.includes('--apply');
const imageIndex = args.indexOf('--image');
const image = imageIndex >= 0 ? args[imageIndex + 1] : null;
const receipt = { ok: true, verb, env, service, image, plan: !apply && verb !== 'status' };
if (verb === 'status') {
  const observed = await observe();
  receipt.environments = existsSync(marker) || observed
    ? [{ env: 'w1', services: observed ? [observed] : [] }]
    : [];
} else if (apply) {
  if (verb === 'create') writeFileSync(marker, 'w1');
  else if (verb === 'attach') {
    if (process.env.GROVE_PROCESS_TEST_SKIP_REPLACE !== 'true') {
      const artifacts = JSON.parse(readFileSync(join(root, 'artifacts.json'), 'utf8'));
      if (!Object.hasOwn(artifacts, image)) throw new Error('unknown test artifact');
      await stop();
      const child = fork(artifacts[image], [root], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('process startup timed out')); }, 3000);
        child.once('message', value => { clearTimeout(timer); resolve(value); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`process exited ${code}`)); });
      });
      writeFileSync(endpointFile, JSON.stringify(endpoint));
      child.disconnect();
      child.unref();
    }
  } else if (verb === 'detach' || verb === 'destroy') {
    await stop();
    if (verb === 'destroy' && existsSync(marker)) unlinkSync(marker);
  } else throw new Error('unsupported test operation');
}
console.log(JSON.stringify(receipt));
