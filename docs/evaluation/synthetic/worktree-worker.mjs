// One independent developer-process simulation per real Git worktree.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [id, method, cli, backend] = process.argv.slice(2);
const root = process.env.GROVE_SYNTHETIC_ROOT;
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = value => process.send(value);
let image; let revision; let watching = false; let watchTask;
const observation = { peer_reads: 0, baseline_reads: 0, errors: [] };
const commands = [];
function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
async function lifecycle(verb) {
  const args = [verb, id, ...(verb === 'attach' ? ['app', '--image', image] : []), '--apply'];
  const executableArgs = method === 'grove' ? [cli, 'overlay', ...args, '--project', '.'] : [backend, 'direct', ...args];
  const started = performance.now();
  const result = await command(process.execPath, executableArgs);
  assert.equal(result.code, 0, result.stderr);
  commands.push({ verb, busy_retries: 0, in_flight_pending_retries: 0, elapsed_ms: performance.now() - started });
}
async function probe(slot, expectedImage, expectedRevision) {
  const { url } = read(path.join(root, `${slot}.json`));
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.image, expectedImage); assert.equal(body.feature, expectedRevision);
  return body;
}
async function build(nextRevision) {
  const started = performance.now();
  const startedNs = process.hrtime.bigint();
  revision = nextRevision;
  writeFileSync('feature.json', JSON.stringify({ feature: revision }) + '\n');
  const feature = read('feature.json');
  const source = readFileSync('server.mjs', 'utf8').replace('__FEATURE_JSON__', JSON.stringify(feature));
  image = 'synthetic/worktree@sha256:' + createHash('sha256').update(source).digest('hex');
  mkdirSync('.build', { recursive: true });
  const file = path.resolve('.build', image.split(':').at(-1) + '.mjs');
  writeFileSync(file, source);
  const checked = await command(process.execPath, ['--check', file]); assert.equal(checked.code, 0, checked.stderr);
  const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
  send({ stage: 'built', id, image, file, revision, branch, build_ms: performance.now() - started,
    started_ns: String(startedNs), finished_ns: String(process.hrtime.bigint()) });
}
process.on('message', async message => {
  try {
    if (message.action === 'build') await build(message.revision);
    else if (message.action === 'deploy') {
      if (message.create) await lifecycle('create');
      await lifecycle('attach'); await probe(id, image, revision);
      send({ stage: 'ready', id, commands });
    } else if (message.action === 'watch') {
      watching = true;
      watchTask = (async () => {
        while (watching) {
          try {
            await probe(id, image, revision); observation.peer_reads++;
            await probe('baseline', message.baselineImage, 'base'); observation.baseline_reads++;
          } catch (error) { observation.errors.push(error.message); }
          await sleep(10);
        }
      })();
      send({ stage: 'watching', id });
    } else if (message.action === 'destroy') {
      await lifecycle('destroy'); send({ stage: 'destroyed', id, commands });
    } else if (message.action === 'stop-watch') {
      watching = false; await watchTask;
      assert.ok(observation.peer_reads > 0); assert.equal(observation.errors.length, 0);
      send({ stage: 'observed', id, observation });
    } else if (message.action === 'probe') {
      await probe(id, image, revision); send({ stage: 'probed', id });
    } else if (message.action === 'exit') { process.disconnect(); process.exit(0); }
  } catch (error) { send({ stage: 'error', id, message: error.message }); }
});
send({ stage: 'started', id });
