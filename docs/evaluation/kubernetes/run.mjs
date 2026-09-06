// Opt-in acceptance lab. Only its own private cluster, worktrees and image tags may be changed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = path.join(repo, 'infra/bin/fixtures/kubernetes-lab');
const cli = path.join(repo, 'infra/bin/cli.mjs');
const root = mkdtempSync(path.join(tmpdir(), 'grove-kube-'));
const cluster = `grove-test-${path.basename(root).slice(-6).toLowerCase()}-${process.pid}`;
const kubeconfig = path.join(root, 'kubeconfig');
const context = `k3d-${cluster}`;
const output = path.resolve(process.argv[2] ?? path.join(root, 'result.json'));
const stateDir = path.join(root, 'registry');
const main = path.join(root, 'main');
const trees = Object.fromEntries(['w1', 'w2', 'w3'].map(id => [id, path.join(root, id)]));
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = { ...process.env, GROVE_KUBERNETES_LAB: root, GROVE_STATE_DIR: stateDir };
for (const key of ['GROVE_OVERLAY_TIMEOUT_MS', 'DEVINFRA_OVERLAY_TIMEOUT_MS', 'GROVE_OVERLAY_VERIFY_TIMEOUT_MS']) delete env[key];
const children = new Set(); const builtTags = [];
const report = { startedAt: new Date().toISOString(), kind: 'isolated-real-kubernetes-synthetic-application',
  candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  sources: Object.fromEntries(['infra/lib/overlay.mjs', 'infra/bin/fixtures/kubernetes-lab/backend.mjs', 'infra/bin/fixtures/kubernetes-lab/app.mjs', 'docs/evaluation/kubernetes/run.mjs'].map(file => [file, hash(readFileSync(path.join(repo, file)))])),
  normalTimeoutOverrides: false, imageImport: 'serialized per private cluster because k3d shares one tools container; Docker builds and overlay commands remain concurrent', plannedCases: 12, cases: [], commands: [], observations: [], failures: [], cleanup: {},
  notMeasured: ['existing consumer adapter and Istio routing', 'real business workflows and authentication', 'shared databases, Redis and Kafka', 'production adoption readiness'],
};
function launch(command, args, options = {}) {
  const started = Date.now();
  const child = spawn(command, args, { cwd: options.cwd ?? repo, env: options.env ?? env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, options.timeout ?? 240000);
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', (status, signal) => { clearTimeout(timer); children.delete(child);
      const row = { command, args: args.map(value => value.replaceAll(root, '<lab>')), started, finished: Date.now(), status, signal };
      if (!options.private) report.commands.push(row);
      resolve({ status, signal, stdout, stderr, ...row });
    });
  });
  return { child, result, stdout: () => stdout };
}
async function run(command, args, options = {}) {
  const result = await launch(command, args, options).result;
  assert.equal(result.status, 0, `${command} ${args.slice(0, 5).join(' ')}: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
const git = (cwd, args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd });
const kargs = args => ['--kubeconfig', kubeconfig, '--context', context, '--request-timeout=10s', ...args];
const kubectl = args => run('kubectl', kargs(args));
const get = async args => JSON.parse(await kubectl([...args, '-o', 'json']));
async function apply(items) {
  const file = path.join(root, `apply-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }), { mode: 0o600 });
  return kubectl(['apply', '-f', file]);
}
function grove(args, tree = 'w1', extra = {}) {
  return launch(process.execPath, [cli, 'overlay', ...args, '--project', trees[tree]], { cwd: trees[tree], env: { ...env, ...extra } });
}
async function good(args, tree, extra) {
  const result = await grove(args, tree, extra).result; assert.equal(result.status, 0, result.stderr); return result;
}
async function bad(args, tree, extra) {
  const result = await grove(args, tree, extra).result; assert.notEqual(result.status, 0); return result;
}
const state = () => existsSync(path.join(stateDir, 'kubernetes-lab.yml')) ? parse(readFileSync(path.join(stateDir, 'kubernetes-lab.yml'), 'utf8')) : { envs: {}, pending_by_env: {} };
async function until(operation, message, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  do { try { const value = await operation(); if (value) return value; } catch (error) { last = error.message; } await sleep(200); } while (Date.now() < deadline);
  throw new Error(`${message}: ${last ?? 'condition remained false'}`);
}
async function check(name, operation) {
  console.log(JSON.stringify({ case: name, state: 'running' })); const started = Date.now();
  try { const evidence = await operation(); report.cases.push({ name, pass: true, durationMs: Date.now() - started, evidence }); }
  catch (error) { report.cases.push({ name, pass: false, durationMs: Date.now() - started, error: error.message.replaceAll(root, '<lab>') }); throw error; }
  console.log(JSON.stringify(report.cases.at(-1)));
}
async function build(tree, version, multiplier, importNow = true) {
  const cwd = tree === 'base' ? main : trees[tree];
  const source = readFileSync(path.join(fixture, 'app.mjs'), 'utf8').replace('value * 1;', `value * ${multiplier};`);
  writeFileSync(path.join(cwd, 'app.mjs'), source);
  writeFileSync(path.join(cwd, 'feature.json'), JSON.stringify({ web: `${version}-web`, api: `${version}-api` }));
  const tag = `grove-lab/${cluster}:${tree}-${version}`; builtTags.push(tag);
  const started = Date.now();
  await run('docker', ['build', '--network=none', '--pull=false', '--provenance=false', '--label', `grove.test/run=${cluster}`, '-t', tag, '.'], { cwd });
  const imageId = await run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
  const artifact = { tree, version, multiplier, tag, imageId, sourceHash: hash(source), started, finished: Date.now() };
  if (importNow) await importImage(artifact);
  return artifact;
}
let importing = Promise.resolve();
function importImage(artifact) {
  const job = importing.then(() => importImageSerial(artifact));
  importing = job.catch(() => {});
  return job;
}
async function importImageSerial(artifact) {
  await run('k3d', ['image', 'import', artifact.tag, '--cluster', cluster], { timeout: 240000 });
  const listing = await run('docker', ['exec', `k3d-${cluster}-server-0`, 'ctr', '-n', 'k8s.io', 'images', 'ls']);
  const line = listing.split('\n').find(line => line.startsWith(`docker.io/${artifact.tag} `));
  assert.ok(line, 'imported immutable artifact exists in the private node');
  const digest = /sha256:[a-f0-9]{64}/.exec(line)[0];
  artifact.image = `docker.io/grove-lab/${cluster}@${digest}`;
  if (!listing.split('\n').some(line => line.startsWith(artifact.image + ' '))) {
    await run('docker', ['exec', `k3d-${cluster}-server-0`, 'ctr', '-n', 'k8s.io', 'images', 'tag', `docker.io/${artifact.tag}`, artifact.image]);
  }
  return artifact;
}
function workload(service, image) {
  return [
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: service, namespace: 'grove-lab-base' }, spec: { replicas: 1, selector: { matchLabels: { app: service } }, template: { metadata: { labels: { app: service } }, spec: {
      ...(service === 'router' ? { serviceAccountName: 'router' } : { automountServiceAccountToken: false }),
      terminationGracePeriodSeconds: 1, containers: [{ name: 'app', image, imagePullPolicy: 'Never', env: [{ name: 'ROLE', value: service }, { name: 'ENVIRONMENT', value: 'base' }],
        readinessProbe: { httpGet: { path: '/ready', port: 8080 }, periodSeconds: 1, failureThreshold: 1 }, resources: { requests: { cpu: '10m', memory: '24Mi' }, limits: { memory: '128Mi' } } }],
    } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: service, namespace: 'grove-lab-base' }, spec: { selector: { app: service }, ports: [{ port: 8080, targetPort: 8080 }] } },
  ];
}
let gateway; let forward; let created = false; let watching = false; let watcher;
const peers = async () => JSON.parse(await run('docker', ['ps', '--format', '{{json .}}'] ).then(text => `[${text.split('\n').filter(Boolean).join(',')}]`)).filter(item => !item.Names.startsWith(`k3d-${cluster}`)).map(item => item.ID).sort();
const defaultConfig = path.join(homedir(), '.kube/config');
const kubeHash = () => existsSync(defaultConfig) ? hash(readFileSync(defaultConfig)) : null;
let beforePeers; let beforeKube;
async function probe(envName, api = false) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${gateway}${api ? '/api/value' : '/'}`, { headers: { host: `web${envName ? '--' + envName : ''}.lab.localhost` } }, response => {
      let body = ''; response.on('data', value => { body += value; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: api ? JSON.parse(body) : body }); } catch (error) { reject(error); } });
    });
    request.setTimeout(4000, () => request.destroy(new Error('Lab HTTP timeout'))); request.on('error', reject); request.end();
  });
}

async function expect(envName, web, api, apiEnv, result) {
  await until(async () => {
    const a = await probe(envName); const b = await probe(envName, true);
    return a.status === 200 && a.body.includes(`${web} @`) && b.status === 200 && b.body.version === api && b.body.environment === apiEnv && b.body.result === result;
  }, `content/route identity for ${envName ?? 'base'}`);
}
try {
  beforePeers = await peers(); beforeKube = kubeHash();
  mkdirSync(path.join(main, '.agents'), { recursive: true });
  writeFileSync(path.join(root, 'lab.json'), JSON.stringify({ cluster, context, kubeconfig }), { mode: 0o600 });
  writeFileSync(path.join(main, 'Dockerfile'), 'FROM node:24-bookworm\nWORKDIR /app\nCOPY app.mjs feature.json ./\nUSER node\nCMD ["node","app.mjs"]\n');
  writeFileSync(path.join(main, '.dockerignore'), '.git\n.agents\n');
  writeFileSync(path.join(main, 'app.mjs'), readFileSync(path.join(fixture, 'app.mjs')));
  writeFileSync(path.join(main, 'feature.json'), JSON.stringify({ web: 'base-web', api: 'base-api' }));
  writeFileSync(path.join(main, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'kubernetes-lab' }, addressing: { tld: 'lab.localhost', proxy: 'project', scheme: { shared: '{service}.{tld}', overlay: '{service}--{env}.{tld}' } },
    runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fixture, 'backend.mjs'))}` } }, services: { web: {}, api: {} }, overlay: { attachable: ['web', 'api'] }, data: { infra: 'project' } }));
  await git(main, ['init', '-b', 'main']); await git(main, ['add', '.']); await git(main, ['-c', 'user.name=Grove Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-m', 'Disposable lab baseline']);
  for (const id of Object.keys(trees)) await git(main, ['worktree', 'add', '-b', id, trees[id]]);
  await check('private-cluster-and-baseline', async () => {
    const apiPort = await new Promise((resolve, reject) => { const socket = createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
    await run('k3d', ['cluster', 'create', cluster, '--image', 'rancher/k3s:v1.35.5-k3s1', '--servers', '1', '--agents', '0', '--servers-memory', '2g', '--no-lb', '--api-port', `127.0.0.1:${apiPort}`, '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--k3s-arg', '--disable=traefik,servicelb,metrics-server@server:0', '--runtime-label', `grove.test/run=${cluster}@all`, '--timeout', '120s']); created = true;
    const credential = await run('k3d', ['kubeconfig', 'get', cluster], { private: true }); writeFileSync(kubeconfig, credential, { mode: 0o600 });
    const baseline = await build('base', 'base', 1); report.baselineArtifact = baseline;
    await apply([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'grove-lab-base', labels: { 'grove.test/run': cluster } } }]);
    await apply([
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'routes', namespace: 'grove-lab-base' }, data: {} },
      { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'router', namespace: 'grove-lab-base' } },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'router', namespace: 'grove-lab-base' }, rules: [{ apiGroups: [''], resources: ['configmaps'], resourceNames: ['routes'], verbs: ['get'] }] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'router', namespace: 'grove-lab-base' }, subjects: [{ kind: 'ServiceAccount', name: 'router', namespace: 'grove-lab-base' }], roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'router' } },
      ...['web', 'api', 'router'].flatMap(service => workload(service, baseline.image)),
    ]);
    await Promise.all(['web', 'api', 'router'].map(service => kubectl(['-n', 'grove-lab-base', 'rollout', 'status', `deployment/${service}`, '--timeout=90s'])));
    forward = launch('kubectl', kargs(['-n', 'grove-lab-base', 'port-forward', 'service/router', ':8080', '--address', '127.0.0.1']), { timeout: 1800000 });
    const port = await until(() => /127\.0\.0\.1:(\d+)/.exec(forward.stdout())?.[1], 'router port-forward'); gateway = `http://127.0.0.1:${port}`;
    await expect(null, 'base-web', 'base-api', 'base', 7); assert.equal(kubeHash(), beforeKube);
    writeFileSync(path.join(root, 'gateway.json'), JSON.stringify({ gateway }));
    return { defaultKubeconfigUnchanged: true, baselineServices: 3, hostBind: 'loopback-only' };
  });
  await check('plans-have-no-runtime-side-effects', async () => {
    const result = await good(['create', 'w1']); assert.match(result.stdout, /plan/);
    const namespaces = await get(['get', 'namespaces']); assert.ok(!namespaces.items.some(ns => ns.metadata.name === 'grove-lab-w1')); assert.deepEqual(state().envs, {});
    return { unexpectedNamespaces: 0, trackedEnvironments: 0 };
  });
  let a, b, revised;
  await check('real-parallel-worktree-build-and-web-api-fallback', async () => {
    [a, b] = await Promise.all([build('w1', 'first', 2), build('w2', 'second', 3)]);
    assert.notEqual(a.image, b.image); assert.ok(Math.min(a.finished, b.finished) > Math.max(a.started, b.started));
    await Promise.all([good(['create', 'w1', '--apply']), good(['create', 'w2', '--apply'], 'w2')]);
    await Promise.all([good(['attach', 'w1', 'web', '--image', a.image, '--apply']), good(['attach', 'w2', 'api', '--image', b.image, '--apply'], 'w2')]);
    await expect('w1', 'first-web', 'base-api', 'base', 7); await expect('w2', 'base-web', 'second-api', 'w2', 21);
    await good(['attach', 'w2', 'web', '--image', b.image, '--apply'], 'w2'); await expect('w2', 'second-web', 'second-api', 'w2', 21);
    assert.equal(state().envs.w1.worktree, realpathSync(trees.w1)); assert.equal(state().envs.w2.worktree, realpathSync(trees.w2));
    report.artifacts = [a, b]; return { independentWorktrees: 2, differentImages: true, buildOverlapMs: Math.min(a.finished, b.finished) - Math.max(a.started, b.started), routingCases: 3 };
  });
  watching = true;
  watcher = (async () => { while (watching) { for (const target of [null, 'w2']) {
    try { const result = await probe(target, true); report.observations.push({ target: target ?? 'base', at: Date.now(), pass: result.status === 200 && result.body.version === (target ? 'second-api' : 'base-api') && result.body.result === (target ? 21 : 7) && result.body.environment === (target ?? 'base') }); }
    catch { report.observations.push({ target: target ?? 'base', at: Date.now(), pass: false }); }
  } await sleep(150); } })();
  await check('new-code-rollout-keeps-peer-source-image-and-requests', async () => {
    const peerHash = hash(readFileSync(path.join(trees.w2, 'app.mjs'))); const peerImage = state().envs.w2.services.api.image;
    revised = await build('w1', 'revised', 4); report.artifacts.push(revised);
    await good(['attach', 'w1', 'web', '--image', revised.image, '--apply']);
    await good(['attach', 'w1', 'api', '--image', revised.image, '--apply']);
    await expect('w1', 'revised-web', 'revised-api', 'w1', 28);
    assert.equal(peerHash, hash(readFileSync(path.join(trees.w2, 'app.mjs')))); assert.equal(state().envs.w2.services.api.image, peerImage);
    return { newCodeResult: 28, peerCodeResult: 21, peerSourceAndImageUnchanged: true };
  });
  await check('failed-build-never-replaces-the-running-artifact', async () => {
    const file = path.join(trees.w1, 'Dockerfile'); const original = readFileSync(file, 'utf8');
    const before = state().envs.w1.services.api.image;
    try {
      writeFileSync(file, original.replace('COPY app.mjs feature.json ./', 'COPY deliberately-missing-source.mjs ./'));
      const result = await launch('docker', ['build', '--network=none', '--pull=false', '--provenance=false', '.'], { cwd: trees.w1 }).result;
      assert.notEqual(result.status, 0);
    } finally { writeFileSync(file, original); }
    assert.equal(state().envs.w1.services.api.image, before); assert.deepEqual(state().pending_by_env, {});
    await expect('w1', 'revised-web', 'revised-api', 'w1', 28);
    return { rejectedActualBuild: true, runningImageUnchanged: true };
  });
  await check('unready-real-pod-cannot-finalize-an-attach', async () => {
    await kubectl(['-n', 'grove-lab-w1', 'exec', 'deployment/api', '--', 'touch', '/tmp/not-ready']);
    await until(async () => (await get(['-n', 'grove-lab-w1', 'get', 'pods', '-l', 'app=api'])).items.every(pod => pod.status.conditions.some(c => c.type === 'Ready' && c.status === 'False')), 'real readiness failure');
    await bad(['attach', 'w1', 'api', '--image', revised.image, '--apply'], 'w1', { GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2500' });
    assert.equal(state().pending_by_env.w1.verb, 'attach');
    await kubectl(['-n', 'grove-lab-w1', 'exec', 'deployment/api', '--', 'rm', '/tmp/not-ready']);
    await good(['attach', 'w1', 'api', '--image', revised.image, '--apply']);
    await expect('w1', 'revised-web', 'revised-api', 'w1', 28);
    return { rejectedUnreadyPod: true, recovered: true, faultVerificationTimeoutMs: 2500 };
  });
  await check('old-image-cannot-finalize-a-new-attach', async () => {
    const marker = path.join(root, 'skip-replace-w1'); writeFileSync(marker, 'fault');
    await bad(['attach', 'w1', 'api', '--image', a.image, '--apply'], 'w1', { GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2500' });
    assert.equal(state().envs.w1.services.api.image, revised.image); assert.equal(state().pending_by_env.w1.image, a.image);
    assert.equal((await probe('w1', true)).body.result, 28);
    rmSync(marker); await good(['attach', 'w1', 'api', '--image', a.image, '--apply']);
    await expect('w1', 'revised-web', 'first-api', 'w1', 14);
    return { rejectedStaleImage: true, sameArgumentRecovery: true, faultVerificationTimeoutMs: 2500 };
  });
  await check('same-environment-exclusion-and-killed-process-recovery', async () => {
    const hold = path.join(root, 'hold-attach-w1'); writeFileSync(hold, 'hold');
    const request = ['attach', 'w1', 'api', '--image', revised.image, '--apply']; const job = grove(request);
    await until(() => existsSync(hold + '.entered'), 'attach reached its real mutation');
    const blocked = await bad(request); assert.match(blocked.stderr, /locked/);
    await good(['touch', 'w2'], 'w2'); await good(['status', 'w2'], 'w2');
    process.kill(-job.child.pid, 'SIGKILL'); await job.result;
    assert.equal(state().pending_by_env.w1.verb, 'attach'); await bad(['status', 'w1']);
    rmSync(hold); await good(request); assert.equal(state().pending_by_env.w1, undefined);
    await expect('w1', 'revised-web', 'revised-api', 'w1', 28);
    return { conflictingCommandRejected: true, peerUsableDuringInterruption: true, deadOwnerRecovered: true };
  });
  await check('default-command-timeout-preserves-pending-and-recovers', async () => {
    const hold = path.join(root, 'hold-create-timeout'); writeFileSync(hold, 'hold for default timeout');
    const request = ['create', 'timeout', '--apply']; const result = await bad(request, 'w3');
    assert.match(result.stderr, /timed out after 120000ms/); assert.ok(result.finished - result.started >= 120000);
    assert.equal(state().pending_by_env.timeout.verb, 'create'); await good(['status', 'w2'], 'w2');
    rmSync(hold); await good(request, 'w3'); await good(['destroy', 'timeout', '--apply'], 'w3');
    return { observedTimeoutMs: result.finished - result.started, defaultTimeout: true, recovered: true };
  });
  await check('partial-destroy-is-not-success-and-remains-retryable', async () => {
    const marker = path.join(root, 'fail-destroy-w1'); writeFileSync(marker, 'fault after actual deletion');
    await bad(['destroy', 'w1', '--apply']); assert.equal(state().pending_by_env.w1.verb, 'destroy');
    await good(['status', 'w2'], 'w2'); assert.equal((await probe('w1')).status, 404);
    rmSync(marker); await good(['destroy', 'w1', '--apply']); assert.equal(state().envs.w1, undefined);
    return { falseSuccess: false, retryAfterNamespaceRemoval: true };
  });
  await check('repeated-create-attach-detach-destroy-does-not-leak', async () => {
    for (let index = 0; index < 5; index++) {
      await good(['create', 'w3', '--apply'], 'w3');
      await good(['attach', 'w3', 'web', '--image', index % 2 ? a.image : revised.image, '--apply'], 'w3');
      await good(['detach', 'w3', 'web', '--apply'], 'w3');
      await good(['detach', 'w3', 'web', '--apply'], 'w3');
      await good(['destroy', 'w3', '--apply'], 'w3');
      await good(['destroy', 'w3', '--apply'], 'w3');
    }
    assert.deepEqual(Object.keys(state().envs), ['w2']); assert.deepEqual(state().pending_by_env, {});
    return { cycles: 5, duplicateCleanupCalls: 10, unexpectedRegistryEntries: 0 };
  });
  watching = false; await watcher;
  await check('peer-and-baseline-continuity', async () => {
    assert.ok(report.observations.length > 0); const failed = report.observations.filter(row => !row.pass); assert.equal(failed.length, 0);
    await expect(null, 'base-web', 'base-api', 'base', 7); await expect('w2', 'second-web', 'second-api', 'w2', 21);
    return { requests: report.observations.length, passed: report.observations.length - failed.length };
  });
  await good(['destroy', 'w2', '--apply'], 'w2'); await good(['status']);
  assert.deepEqual(state().envs, {}); assert.deepEqual((await get(['-n', 'grove-lab-base', 'get', 'configmap', 'routes'])).data ?? {}, {});
} catch (error) {
  report.failures.push(error.message.replaceAll(root, '<lab>')); process.exitCode = 1;
} finally {
  watching = false; if (watcher) await watcher;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  if (forward) await forward.result;
  if (created) {
    try {
      const owner = await run('docker', ['inspect', `k3d-${cluster}-server-0`, '--format', '{{index .Config.Labels "grove.test/run"}}']);
      assert.equal(owner, cluster); await run('k3d', ['cluster', 'delete', cluster]);
      report.cleanup.clusterRemoved = true;
    } catch (error) { report.failures.push('Private cluster cleanup: ' + error.message); process.exitCode = 1; }
  }
  for (const tag of builtTags) { try { await run('docker', ['image', 'rm', tag]); } catch { report.failures.push('Lab image tag cleanup failed'); process.exitCode = 1; } }
  try { assert.deepEqual(await peers(), beforePeers); assert.equal(kubeHash(), beforeKube); report.cleanup.preexistingContainersPreserved = beforePeers.length; report.cleanup.defaultKubeconfigUnchanged = true; } catch (error) { report.failures.push('Preservation check: ' + error.message); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.sourceDrift = Object.entries(report.sources).filter(([file, digest]) => hash(readFileSync(path.join(repo, file))) !== digest).map(([file]) => file);
  if (report.sourceDrift.length) { report.failures.push('Execution source changed during measurement'); process.exitCode = 1; }
  if (existsSync(path.join(root, 'trace.jsonl'))) report.backendTrace = readFileSync(path.join(root, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!output.startsWith(root + path.sep) && report.cleanup.clusterRemoved) rmSync(root, { recursive: true, force: true });
  report.cleanup.temporaryRootRemoved = !existsSync(root);
  report.cleanup.remainingWorktrees = Object.values(trees).filter(tree => existsSync(tree)).length;
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: output, passed: report.cases.filter(row => row.pass).length, total: report.cases.length, failures: report.failures, cleanup: report.cleanup }));
}
