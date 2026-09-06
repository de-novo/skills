// Actual temporary Git worktrees; the catalog and existing Orca trees are untouched.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const cli = path.join(repo, 'infra/bin/cli.mjs');
const backend = path.join(here, 'backend.mjs');
const workerFile = path.join(here, 'worktree-worker.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = mkdtempSync(path.join(tmpdir(), 'grove-worktrees-'));
const output = process.argv[2];
const contexts = [];
const report = { kind: 'actual-git-worktrees-synthetic-developer-processes', started_at: new Date().toISOString(),
  candidate_sha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  production_sources: Object.fromEntries(['infra/lib/overlay.mjs', 'infra/bin/cli.mjs'].map(file => [file, hash(readFileSync(path.join(repo, file)))])),
  sources: Object.fromEntries([fileURLToPath(import.meta.url), workerFile, backend].map(file => [path.basename(file), hash(readFileSync(file))])),
  machine: { node: process.version, platform: platform(), arch: arch(), load_start: loadavg() },
  protocol: { pairs: 5, worktrees_per_run: 2, common_base: true, common_grove_project_and_registry: true,
    timing: 'simultaneous edit request through independent readiness of both builds',
    build: 'per-worktree feature edit, executable assembly and real node --check; not a container build',
    artifact_registration: 'coordinator merges manifests after both parallel builds; not timed as developer labor',
    contention: 'one attempt per lifecycle command; no evaluation-only waiting or retries',
    baseline: 'same isolated process backend and HTTP identity checks, without Grove lifecycle journal',
    unmeasured: ['human or AI coding productivity', 'Git merge conflict resolution', 'Docker or Kubernetes', 'DB isolation', 'DNS routing', 'production adapter integration cost'] },
  runs: [], errors: [], cleanup: {},
};
const server = `
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const feature=__FEATURE_JSON__;
const image='synthetic/worktree@sha256:'+createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const server=createServer((req,res)=>{
 if(req.method==='POST' && req.url==='/shutdown'){res.end();server.close(()=>process.exit(0));return;}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({image,...feature}));
});
server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,url:'http://127.0.0.1:'+server.address().port}));
setTimeout(()=>process.exit(0),180000).unref();
`;
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function helper(ctx, code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const b=await import(${JSON.stringify(backend)});${code}`], {
    env: ctx.env, encoding: 'utf8', timeout: 12000,
  }); assert.equal(result.status, 0, result.stderr);
}
function worker(ctx, id) {
  const child = fork(workerFile, [id, ctx.method, cli, backend], { cwd: ctx.trees[id],
    env: { ...ctx.env, DEVINFRA_AGENT: `synthetic-${id}` }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const queue = []; const waiters = [];
  child.stderr.resume();
  child.on('message', item => { const next = waiters.shift(); if (next) next(item); else queue.push(item); });
  const next = async expected => {
    let timer;
    try {
      const item = queue.length ? queue.shift() : await Promise.race([
        new Promise(resolve => waiters.push(resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`worker ${id} timed out at ${expected}`)), 15000); }),
      ]);
      assert.equal(item.stage, expected, item.message); return item;
    } finally { clearTimeout(timer); }
  };
  const result = { child, next, send: item => child.send(item) }; ctx.workers.push(result); return result;
}
async function probe(ctx, slot, image, feature) {
  const { url } = read(path.join(ctx.runtime, `${slot}.json`));
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.image, image); assert.equal(body.feature, feature);
}
async function absent(url) {
  let reached = false; try { await fetch(url, { signal: AbortSignal.timeout(500) }); reached = true; } catch {}
  assert.equal(reached, false);
}
async function closeWorker(worker) {
  if (worker.child.exitCode != null) return;
  const done = new Promise(resolve => worker.child.once('exit', resolve));
  worker.send({ action: 'exit' }); await done;
}
function register(ctx, builds) {
  const file = path.join(ctx.runtime, 'artifacts.json'); const artifacts = read(file);
  for (const build of builds) artifacts[build.image] = build.file;
  writeFileSync(file, JSON.stringify(artifacts));
}
try {
  for (let pair = 1; pair <= 5; pair++) {
    for (const method of pair % 2 ? ['direct', 'grove'] : ['grove', 'direct']) {
      const setupAt = performance.now();
      const location = path.join(root, `${pair}-${method}`);
      const ctx = { method, base: path.join(location, 'main'), runtime: path.join(location, 'runtime'),
        trees: { w1: path.join(location, 'w1'), w2: path.join(location, 'w2') }, workers: [] };
      contexts.push(ctx); mkdirSync(path.join(ctx.base, '.agents'), { recursive: true }); mkdirSync(ctx.runtime);
      ctx.env = { PATH: process.env.PATH, GROVE_SYNTHETIC_ROOT: ctx.runtime, GROVE_STATE_DIR: path.join(ctx.runtime, 'registry'),
        GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '2000', GROVE_OVERLAY_TIMEOUT_MS: '10000' };
      writeFileSync(path.join(ctx.runtime, 'synthetic-marker'), 'owned worktree experiment');
      writeFileSync(path.join(ctx.base, 'server.mjs'), server);
      writeFileSync(path.join(ctx.base, 'feature.json'), JSON.stringify({ feature: 'base' }) + '\n');
      writeFileSync(path.join(ctx.base, '.gitignore'), '.build/\n');
      writeFileSync(path.join(ctx.base, '.agents/runtime-profile.yml'), stringify({
        project: { slug: 'synthetic-worktrees' }, addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
        runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(backend)} adapter` } },
        services: { app: {} }, overlay: { attachable: ['app'] }, data: { infra: 'project' },
      }));
      git(ctx.base, ['init', '-b', 'main']); git(ctx.base, ['add', '.']);
      git(ctx.base, ['-c', 'user.name=Synthetic Evaluation', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'Synthetic baseline']);
      const baseHead = git(ctx.base, ['rev-parse', 'HEAD']);
      for (const id of ['w1', 'w2']) {
        git(ctx.base, ['worktree', 'add', '-b', id, ctx.trees[id], baseHead]);
        assert.equal(git(ctx.trees[id], ['rev-parse', 'HEAD']), baseHead);
      }
      assert.notEqual(git(ctx.trees.w1, ['rev-parse', '--git-dir']), git(ctx.trees.w2, ['rev-parse', '--git-dir']));
      const baselineSource = server.replace('__FEATURE_JSON__', JSON.stringify({ feature: 'base' }));
      const baselineFile = path.join(ctx.runtime, 'baseline.mjs'); writeFileSync(baselineFile, baselineSource);
      const baselineImage = `synthetic/worktree@sha256:${hash(baselineSource)}`;
      writeFileSync(path.join(ctx.runtime, 'artifacts.json'), JSON.stringify({ [baselineImage]: baselineFile }));
      helper(ctx, `await b.start('baseline',${JSON.stringify(baselineImage)});`);
      const w1 = worker(ctx, 'w1'); const w2 = worker(ctx, 'w2');
      assert.notEqual(w1.child.pid, w2.child.pid);
      await Promise.all([w1.next('started'), w2.next('started')]);
      const setupMs = performance.now() - setupAt; const start = performance.now();
      w1.send({ action: 'build', revision: 'w1-first' }); w2.send({ action: 'build', revision: 'w2-first' });
      const [a, b] = await Promise.all([w1.next('built'), w2.next('built')]);
      const overlapNs = (BigInt(a.finished_ns) < BigInt(b.finished_ns) ? BigInt(a.finished_ns) : BigInt(b.finished_ns)) -
        (BigInt(a.started_ns) > BigInt(b.started_ns) ? BigInt(a.started_ns) : BigInt(b.started_ns));
      assert.ok(overlapNs > 0n, 'independent edit/build intervals actually overlap');
      assert.equal(a.branch, 'w1'); assert.equal(b.branch, 'w2'); assert.notEqual(a.image, b.image);
      assert.ok(a.file.startsWith(realpathSync(ctx.trees.w1) + path.sep));
      assert.ok(b.file.startsWith(realpathSync(ctx.trees.w2) + path.sep));
      register(ctx, [a, b]);
      w1.send({ action: 'deploy', create: true }); w2.send({ action: 'deploy', create: true });
      await Promise.all([w1.next('ready'), w2.next('ready')]);
      await Promise.all([probe(ctx, 'w1', a.image, 'w1-first'), probe(ctx, 'w2', b.image, 'w2-first')]);
      const readyMs = performance.now() - start;
      if (method === 'grove') {
        const state = parse(readFileSync(path.join(ctx.env.GROVE_STATE_DIR, 'synthetic-worktrees.yml'), 'utf8'));
        for (const id of ['w1', 'w2']) {
          assert.equal(state.envs[id].worktree, realpathSync(ctx.trees[id]));
          assert.equal(state.envs[id].agent, `synthetic-${id}`);
        }
      }
      const peerSource = hash(readFileSync(path.join(ctx.trees.w2, 'feature.json')));
      const peerBuild = hash(readFileSync(b.file));
      w2.send({ action: 'watch', baselineImage }); await w2.next('watching');
      const redeployAt = performance.now();
      w1.send({ action: 'build', revision: 'w1-second' }); const revised = await w1.next('built'); register(ctx, [revised]);
      assert.notEqual(revised.image, a.image);
      const oldUrl = read(path.join(ctx.runtime, 'w1.json')).url;
      w1.send({ action: 'deploy', create: false }); await w1.next('ready');
      await probe(ctx, 'w1', revised.image, 'w1-second'); await absent(oldUrl);
      const redeployMs = performance.now() - redeployAt;
      const currentUrl = read(path.join(ctx.runtime, 'w1.json')).url;
      const cleanupAt = performance.now();
      w1.send({ action: 'destroy' }); const firstDone = await w1.next('destroyed'); await absent(currentUrl);
      await closeWorker(w1); git(ctx.base, ['worktree', 'remove', '--force', ctx.trees.w1]);
      w2.send({ action: 'probe' }); await w2.next('probed');
      const firstCleanupMs = performance.now() - cleanupAt;
      assert.equal(hash(readFileSync(path.join(ctx.trees.w2, 'feature.json'))), peerSource);
      assert.equal(hash(readFileSync(b.file)), peerBuild);
      assert.equal(git(ctx.trees.w2, ['branch', '--show-current']), 'w2');
      assert.equal(git(ctx.base, ['status', '--porcelain']), '');
      await probe(ctx, 'baseline', baselineImage, 'base');
      w2.send({ action: 'stop-watch' }); const observed = await w2.next('observed');
      const peerUrl = read(path.join(ctx.runtime, 'w2.json')).url;
      w2.send({ action: 'destroy' }); const secondDone = await w2.next('destroyed'); await absent(peerUrl);
      await closeWorker(w2); git(ctx.base, ['worktree', 'remove', '--force', ctx.trees.w2]);
      assert.equal(git(ctx.base, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
      helper(ctx, "await b.stop('baseline');");
      const row = { pair, method, setup_ms: setupMs, initial_edit_build_ready_ms: readyMs,
        redeploy_ms: redeployMs, first_worktree_cleanup_ms: firstCleanupMs,
        independent_worktrees: 2, edit_build_overlap_ms: Number(overlapNs) / 1e6,
        distinct_branch_sources_and_builds: true, registry_worktree_identity_checked: method === 'grove',
        peer_source_and_build_unchanged: true, baseline_unchanged: true, removed_worktrees: 2,
        observation: observed.observation, workers: { w1: firstDone.commands, w2: secondDone.commands } };
      report.runs.push(row); console.log(JSON.stringify({ run: row }));
    }
  }
} catch (error) {
  report.errors.push({ name: error.name, message: error.message.replaceAll(root, '<temporary-root>').replaceAll(repo, '<catalog>') });
  process.exitCode = 1;
} finally {
  let live = 0; let endpoints = 0;
  for (const ctx of contexts) {
    for (const worker of ctx.workers) { if (worker.child.exitCode == null) worker.child.kill('SIGKILL'); }
    const urls = ['w1', 'w2', 'baseline'].flatMap(id => existsSync(path.join(ctx.runtime, `${id}.json`)) ? [read(path.join(ctx.runtime, `${id}.json`)).url] : []);
    try { helper(ctx, "for(const id of ['w1','w2','baseline'])await b.stop(id);"); }
    catch { report.errors.push({ name: 'cleanup', message: 'normal owned endpoint cleanup failed' }); }
    const pids = readdirSync(ctx.runtime).filter(name => /^owned-\d+$/.test(name)).map(name => Number(name.slice(6)));
    for (const pid of pids) {
      const status = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (status && !status.startsWith('Z') && status.includes(root)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    await sleep(50);
    for (const pid of pids) {
      const status = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (status && !status.startsWith('Z') && status.includes(root)) live++;
    }
    for (const url of urls) { try { await absent(url); } catch { endpoints++; } }
  }
  rmSync(root, { recursive: true, force: true });
  report.cleanup = { live_owned_processes: live, reachable_owned_endpoints: endpoints, temporary_root_removed: !existsSync(root) };
  report.finished_at = new Date().toISOString(); report.machine.load_end = loadavg();
  if (live || endpoints || report.errors.length || report.runs.length !== 10) process.exitCode = 1;
  if (output) writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ completed_runs: report.runs.length, planned_runs: 10, cleanup: report.cleanup, errors: report.errors }));
}
