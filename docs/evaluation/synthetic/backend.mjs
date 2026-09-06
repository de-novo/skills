// Synthetic process backend. Its private root and all workloads belong to one run.
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const read = file => JSON.parse(readFileSync(file, 'utf8'));
const root = process.env.GROVE_SYNTHETIC_ROOT;
if (!root || !existsSync(join(root, 'synthetic-marker'))) throw new Error('private synthetic root required');
const slot = env => {
  if (!/^(w1|w2|baseline|catalog)$/.test(env)) throw new Error('unknown synthetic slot');
  return join(root, `${env}.json`);
};
export const fault = () => existsSync(join(root, 'fault.json')) ? read(join(root, 'fault.json')) : {};
export async function observe(env) {
  if (!existsSync(slot(env))) return null;
  const endpoint = read(slot(env));
  try {
    const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(1000) });
    return { ...endpoint, ...await response.json(), ready: response.ok };
  } catch { return { ...endpoint, ready: false, image: null }; }
}
export async function stop(env) {
  if (!existsSync(slot(env))) return;
  if (fault().cleanup) throw new Error('injected cleanup failure');
  const endpoint = read(slot(env));
  // The URL came from this run's child over IPC, never from a user profile.
  try { await fetch(`${endpoint.url}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1000) }); }
  catch { /* Absence is checked below. */ }
  for (let i = 0; i < 100; i++) {
    try { await fetch(endpoint.url, { signal: AbortSignal.timeout(100) }); }
    catch { unlinkSync(slot(env)); return; }
    await sleep(20);
  }
  throw new Error('owned endpoint still reachable');
}
export async function start(env, image) {
  if (fault().oldImage && existsSync(slot(env))) return;
  const artifacts = read(join(root, 'artifacts.json'));
  if (!Object.hasOwn(artifacts, image)) throw new Error('unknown synthetic artifact');
  const existing = await observe(env);
  if (existing?.image === image) return;
  await stop(env);
  const dependency = existsSync(slot('catalog')) ? read(slot('catalog')).url : '';
  const child = fork(artifacts[image], [root, env, dependency], {
    detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('startup timeout')); }, 3000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`startup exit ${code}`)); });
  });
  writeFileSync(slot(env), JSON.stringify(endpoint), { mode: 0o600 });
  // Retain every created PID until final cleanup, including replaced workloads.
  writeFileSync(join(root, `owned-${endpoint.pid}`), String(endpoint.pid));
  child.disconnect(); child.unref();
}
export async function mutate(verb, env, image) {
  slot(env);
  if (!['w1', 'w2'].includes(env)) throw new Error('lifecycle only owns worker slots');
  const marker = join(root, `${env}.environment`);
  if (verb === 'create') writeFileSync(marker, env);
  else if (verb === 'attach') await start(env, image);
  else if (verb === 'detach' || verb === 'destroy') {
    await stop(env);
    if (verb === 'destroy' && existsSync(marker)) unlinkSync(marker);
  } else throw new Error('unknown mutation');
  if (verb === 'attach' && fault().pause) {
    writeFileSync(join(root, 'paused.json'), JSON.stringify({ pid: process.pid }));
    const deadline = Date.now() + 10000;
    while (fault().pause && Date.now() < deadline) await sleep(20);
    if (fault().pause) throw new Error('injected pause deadline');
  }
}
export async function inventory(env) {
  const result = [];
  for (const name of env ? [env] : ['w1', 'w2']) {
    const observed = await observe(name);
    if (existsSync(join(root, `${name}.environment`)) || observed) {
      result.push({ env: name, services: observed ? [{ service: 'app', image: observed.image, ready: observed.ready }] : [] });
    }
  }
  return result;
}
export async function verify(verb, env, image, timeout = 900) {
  const deadline = Date.now() + timeout;
  do {
    const items = await inventory(env); const app = items[0]?.services[0];
    if ((verb === 'create' && items.length === 1) ||
        (verb === 'attach' && app?.image === image && app.ready) ||
        (verb === 'detach' && items.length === 1 && !app) ||
        (verb === 'destroy' && items.length === 0)) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error('direct postcondition not observed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, verb, env, service, ...args] = process.argv.slice(2);
  if (!['direct', 'adapter'].includes(mode)) throw new Error('unknown front door');
  const imageIndex = args.indexOf('--image');
  const image = imageIndex < 0 ? null : args[imageIndex + 1];
  const apply = mode === 'direct' || process.argv.includes('--apply');
  if (verb === 'status') {
    console.log(JSON.stringify({ ok: true, verb, environments: await inventory(env) }));
  } else {
    if (apply) {
      await mutate(verb, env, image);
      if (mode === 'direct') await verify(verb, env, image);
    }
    console.log(JSON.stringify({ ok: true, verb, env, service, image, plan: !apply }));
  }
}
