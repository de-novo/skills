// Real local HTTP processes, synthetic projects; no Docker or consumer inputs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const cli = path.join(repo, 'infra/bin/cli.mjs');
const backend = path.join(here, 'backend.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const output = process.argv[2];
const report = {
  kind: 'synthetic-exploratory', started_at: new Date().toISOString(),
  candidate_sha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  production_sources: Object.fromEntries(['infra/lib/overlay.mjs', 'infra/bin/cli.mjs'].map(file => [file, hash(readFileSync(path.join(repo, file)))])),
  harness_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  backend_sha256: hash(readFileSync(backend)),
  machine: { node: process.version, platform: platform(), arch: arch(), logical_cpus: cpus().length, load_start: loadavg() },
  protocol: { normal_pairs_per_project: 5, readers: 2, reads_per_reader: 10, acceptance: 'none; exploratory',
    readiness: 'independent HTTP status, artifact digest, feature result, and shared dependency identity',
    build: 'generated executable JavaScript; no compiler or image build',
    baseline: 'direct process lifecycle with the same independent postconditions',
    failure_cases: ['old-image', 'unready', 'interrupted-dispatch', 'cleanup-failure'],
    unmeasured: ['human effort', 'real application integration cost', 'shared Docker or Kubernetes', 'database isolation', 'DNS and proxy routing', 'actual human or agent collaboration'] },
  normal: [], failures: [], contention: [], checks: {}, errors: [],
};
const root = mkdtempSync(path.join(tmpdir(), 'grove-synthetic-'));
const contexts = [];
const liveCommands = new Set();
const workload = spec => `
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const spec=${JSON.stringify(spec)};
const [root,worker,dependency]=process.argv.slice(2);
const image='synthetic/app@sha256:'+createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const server=createServer(async(req,res)=>{
 if(req.method==='POST' && req.url==='/shutdown'){res.end();server.close(()=>process.exit(0));return;}
 try {
  const shared=spec.kind==='shop' ? await (await fetch(dependency,{signal:AbortSignal.timeout(500)})).json() : null;
  const feature=spec.kind==='board' ? {tasks:['write','review',spec.revision]} : spec.kind==='shop' ? {total:shared.price-spec.discount,catalogImage:shared.image} : {price:100};
  res.writeHead(existsSync(join(root,worker+'.unready'))?503:200,{'content-type':'application/json'});
  res.end(JSON.stringify({image,worker,...feature}));
 }catch{res.writeHead(503);res.end(JSON.stringify({image,worker}));}
});
server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,url:'http://127.0.0.1:'+server.address().port}));
setTimeout(()=>{server.close();process.exit(0)},300000).unref();
`;

function run(ctx, method, verb, env, image) {
  const lifecycle = [verb, env, ...(verb === 'attach' ? ['app', '--image', image] : []), '--apply'];
  const args = method === 'grove' ? [cli, 'overlay', ...lifecycle, '--project', ctx.root] : [backend, 'direct', ...lifecycle];
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: ctx.root, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  liveCommands.add(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer); liveCommands.delete(child);
      resolve({ code, signal, ms: performance.now() - started, stdout, stderr });
    });
  });
}
async function good(...args) {
  const result = await run(...args);
  assert.equal(result.code, 0, result.stderr); return result;
}
function setFault(ctx, value) { writeFileSync(path.join(ctx.root, 'fault.json'), JSON.stringify(value)); }
function state(ctx) {
  const file = path.join(ctx.root, 'registry', `${ctx.name}.yml`);
  return existsSync(file) ? parse(readFileSync(file, 'utf8')) : { envs: {}, pending_by_env: {} };
}
async function probe(ctx, worker, revision) {
  const endpoint = read(path.join(ctx.root, `${worker}.json`));
  const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(1500) });
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.image, ctx.images[revision]);
  assert.equal(body.worker, worker);
  if (ctx.kind === 'board') assert.equal(body.tasks[2], revision);
  else { assert.equal(body.total, revision === 'r1' ? 90 : revision === 'r2' ? 80 : 100); assert.equal(body.catalogImage, ctx.images.catalog); }
  return body;
}
async function absent(url) {
  let reached = false;
  try { await fetch(url, { signal: AbortSignal.timeout(300) }); reached = true; } catch {}
  assert.equal(reached, false, 'endpoint must be absent');
}
async function waitPaused(ctx) {
  const file = path.join(ctx.root, 'paused.json'); const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await sleep(10);
  assert.ok(existsSync(file), 'adapter reached controlled interruption boundary'); return read(file);
}
function clearPaused(ctx) { rmSync(path.join(ctx.root, 'paused.json'), { force: true }); }

try {
  for (const kind of ['board', 'shop']) {
    const generatedAt = performance.now();
    const projectRoot = path.join(root, kind); mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'synthetic-marker'), 'owned by synthetic experiment');
    const ctx = { root: projectRoot, kind, name: `synthetic-${kind}`, images: {} };
    contexts.push(ctx);
    ctx.env = { PATH: process.env.PATH, GROVE_SYNTHETIC_ROOT: projectRoot,
      GROVE_STATE_DIR: path.join(projectRoot, 'registry'), GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '900', GROVE_OVERLAY_TIMEOUT_MS: '12000' };
    const artifacts = {};
    for (const revision of ['base', 'r1', 'r2', 'catalog']) {
      const source = workload({ kind: revision === 'catalog' ? 'catalog' : kind, revision, discount: revision === 'r1' ? 10 : revision === 'r2' ? 20 : 0 });
      const file = path.join(projectRoot, `${revision}.mjs`); writeFileSync(file, source);
      ctx.images[revision] = `synthetic/app@sha256:${hash(source)}`; artifacts[ctx.images[revision]] = file;
    }
    writeFileSync(path.join(projectRoot, 'artifacts.json'), JSON.stringify(artifacts));
    writeFileSync(path.join(projectRoot, '.agents/runtime-profile.yml'), stringify({
      project: { slug: ctx.name }, addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
      runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(backend)} adapter` } },
      services: { app: {} }, overlay: { attachable: ['app'] }, data: { infra: 'project' },
    }));
    ctx.generation_ms = performance.now() - generatedAt;
    // A separate helper starts the standing baseline and optional shared service.
    const setup = `const b=await import(${JSON.stringify(backend)});${kind === 'shop' ? `await b.start('catalog',${JSON.stringify(ctx.images.catalog)});` : ''}await b.start('baseline',${JSON.stringify(ctx.images.base)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', setup], { env: ctx.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    await probe(ctx, 'baseline', 'base');
    for (let pair = 1; pair <= 5; pair++) {
      for (const method of pair % 2 ? ['direct', 'grove'] : ['grove', 'direct']) {
        const started = performance.now();
        for (const worker of ['w1', 'w2']) {
          await good(ctx, method, 'create', worker);
          await good(ctx, method, 'attach', worker, ctx.images[worker === 'w1' ? 'r1' : 'r2']);
        }
        await Promise.all([probe(ctx, 'w1', 'r1'), probe(ctx, 'w2', 'r2')]);
        const readyMs = performance.now() - started;
        const readers = await Promise.all(['w1', 'w2'].map(async worker => {
          for (let i = 0; i < 10; i++) await probe(ctx, worker, worker === 'w1' ? 'r1' : 'r2');
          return 10;
        }));
        await probe(ctx, 'baseline', 'base');
        const urls = ['w1', 'w2'].map(worker => read(path.join(ctx.root, `${worker}.json`)).url);
        const cleanupAt = performance.now();
        for (const worker of ['w1', 'w2']) await good(ctx, method, 'destroy', worker);
        for (const url of urls) await absent(url);
        const row = { project: kind, pair, method, ready_ms: readyMs, cleanup_ms: performance.now() - cleanupAt, reader_checks: readers.reduce((a, b) => a + b), baseline_checks: 1, absent_endpoints: 2 };
        report.normal.push(row); console.log(JSON.stringify({ normal: row }));
      }
    }
    for (const scenario of report.protocol.failure_cases) {
      for (const method of ['direct', 'grove']) {
        await good(ctx, method, 'create', 'w1'); await good(ctx, method, 'attach', 'w1', ctx.images.r1);
        let verb = 'attach'; let requested = ctx.images.r2; let failed;
        if (scenario === 'old-image') setFault(ctx, { oldImage: true });
        if (scenario === 'unready') writeFileSync(path.join(ctx.root, 'w1.unready'), 'fault');
        if (scenario === 'cleanup-failure') { setFault(ctx, { cleanup: true }); verb = 'destroy'; requested = undefined; }
        if (scenario === 'interrupted-dispatch') {
          setFault(ctx, { pause: true }); clearPaused(ctx);
          const running = run(ctx, method, verb, 'w1', requested);
          const paused = await waitPaused(ctx); process.kill(paused.pid, 'SIGKILL'); failed = await running;
        } else failed = await run(ctx, method, verb, 'w1', requested);
        assert.notEqual(failed.code, 0, 'fault must fail');
        const actual = await fetch(read(path.join(ctx.root, 'w1.json')).url).then(async res => ({ status: res.status, body: await res.json() }));
        assert.equal(actual.body.image, ctx.images[scenario === 'old-image' || scenario === 'cleanup-failure' ? 'r1' : 'r2']);
        assert.equal(actual.status, scenario === 'unready' ? 503 : 200);
        let unrelatedBlocked = null;
        if (method === 'grove') {
          assert.equal(state(ctx).pending_by_env.w1.verb, verb);
          await good(ctx, method, 'create', 'w2');
          unrelatedBlocked = false;
        }
        setFault(ctx, {}); rmSync(path.join(ctx.root, 'w1.unready'), { force: true }); clearPaused(ctx);
        if (method === 'grove') await good(ctx, method, 'destroy', 'w2');
        const recovery = await good(ctx, method, verb, 'w1', requested);
        if (verb === 'attach') { await probe(ctx, 'w1', 'r2'); await good(ctx, method, 'destroy', 'w1'); }
        else assert.equal(existsSync(path.join(ctx.root, 'w1.json')), false);
        if (method === 'grove') assert.equal(state(ctx).pending_by_env.w1, undefined);
        await probe(ctx, 'baseline', 'base');
        const row = { project: kind, scenario, method, rejected: true, failure_ms: failed.ms, recovery_ms: recovery.ms,
          recovery_retries: 1, durable_pending: method === 'grove', unrelated_mutation_blocked: unrelatedBlocked, runtime_checked: true };
        report.failures.push(row); console.log(JSON.stringify({ failure: row }));
      }
    }
    for (const method of ['direct', 'grove']) {
      for (const worker of ['w1', 'w2']) await good(ctx, method, 'create', worker);
      clearPaused(ctx); setFault(ctx, { pause: true });
      const first = run(ctx, method, 'attach', 'w1', ctx.images.r1); await waitPaused(ctx);
      // The second writer targets a different environment of the same project.
      const second = run(ctx, method, 'attach', 'w2', ctx.images.r2);
      // Both adapters must create their own endpoint before either is released.
      const deadline = Date.now() + 5000;
      while (!existsSync(path.join(ctx.root, 'w2.json')) && Date.now() < deadline) await sleep(10);
      assert.ok(existsSync(path.join(ctx.root, 'w2.json')));
      setFault(ctx, {});
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
      const blocked = false;
      await Promise.all([probe(ctx, 'w1', 'r1'), probe(ctx, 'w2', 'r2')]);
      for (const worker of ['w1', 'w2']) await good(ctx, method, 'destroy', worker);
      report.contention.push({ project: kind, method, blocked, retries: Number(blocked), independent_readers_passed: 2 });
    }
  }
} catch (error) {
  report.errors.push({ name: error.name, message: error.message.replaceAll(root, '<synthetic-root>').replaceAll(repo, '<catalog>') });
  process.exitCode = 1;
} finally {
  for (const child of liveCommands) child.kill('SIGKILL');
  let leftoverEndpoints = 0; let liveOwnedProcesses = 0;
  for (const ctx of contexts) {
    setFault(ctx, {});
    const urls = ['w1', 'w2', 'baseline', 'catalog'].flatMap(worker => {
      const file = path.join(ctx.root, `${worker}.json`); return existsSync(file) ? [read(file).url] : [];
    });
    const cleanup = `const b=await import(${JSON.stringify(backend)});for(const env of ['w1','w2','baseline','catalog'])await b.stop(env);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', cleanup], { env: ctx.env, encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) report.errors.push({ name: 'cleanup', message: 'owned endpoint cleanup failed' });
    const pids = readdirSync(ctx.root).filter(name => /^owned-\d+$/.test(name)).map(name => Number(name.slice(6)));
    for (const pid of pids) {
      // Zombies cannot serve traffic; only still-executing owned processes count.
      const status = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (status && !status.startsWith('Z') && status.includes(ctx.root)) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    await sleep(100);
    for (const pid of pids) {
      const status = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (status && !status.startsWith('Z') && status.includes(ctx.root)) liveOwnedProcesses++;
    }
    for (const url of urls) { try { await absent(url); } catch { leftoverEndpoints++; } }
  }
  report.checks = { normal_runs: report.normal.length, planned_normal_runs: 20,
    concurrent_reader_checks: report.normal.reduce((n, row) => n + row.reader_checks, 0),
    fault_cases: report.failures.length, planned_fault_cases: 16, contention_cases: report.contention.length,
    leftover_endpoints: leftoverEndpoints, live_owned_processes: liveOwnedProcesses };
  rmSync(root, { recursive: true, force: true }); report.checks.private_root_removed = !existsSync(root);
  if (leftoverEndpoints || liveOwnedProcesses || report.errors.length) process.exitCode = 1;
  report.finished_at = new Date().toISOString(); report.machine.load_end = loadavg();
  if (output) writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors }));
}
