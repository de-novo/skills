import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const BACKEND = path.join(HERE, 'fixtures/process-overlay.mjs');

// The running process derives identity from its executable bytes, not an attach
// receipt or Grove's registry. HTTP readiness is measured by the backend.
const WORKLOAD = readFileSync(path.join(HERE, 'fixtures/process-workload.mjs'), 'utf8');

test('real process overlay verifies artifact replacement, readiness, recovery, and removal', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'grove-process-'));
  const stateDir = path.join(root, 'state');
  const stateFile = path.join(stateDir, 'process-test.yml');
  const endpointFile = path.join(root, 'w1', 'endpoint.json');
  t.after(() => {
    // Only this test's child PID is eligible for fallback cleanup.
    if (existsSync(endpointFile)) {
      const { pid } = JSON.parse(readFileSync(endpointFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, '.agents'));
  writeFileSync(path.join(root, 'process-test-marker'), 'isolated');
  const artifacts = {};
  for (const revision of ['a', 'b']) {
    const source = `// artifact ${revision}\n${WORKLOAD}`;
    const file = path.join(root, `artifact-${revision}.mjs`);
    writeFileSync(file, source);
    artifacts[`process/api@sha256:${createHash('sha256').update(source).digest('hex')}`] = file;
  }
  const [imageA, imageB] = Object.keys(artifacts);
  writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify(artifacts));
  writeFileSync(path.join(root, '.agents/runtime-profile.yml'), stringify({
    project: { slug: 'process-test' },
    addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
    runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } },
    services: { api: {} },
    overlay: { attachable: ['api'] },
    data: { infra: 'project' },
  }));
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, 'overlay', ...args, '--project', root], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GROVE_STATE_DIR: stateDir, GROVE_PROCESS_TEST_ROOT: root,
      GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '3000', ...extra },
  });
  const succeed = args => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const attach = image => ['attach', 'w1', 'api', '--image', image, '--apply'];
  const state = () => parse(readFileSync(stateFile, 'utf8'));
  const probe = async () => {
    const { url } = JSON.parse(readFileSync(endpointFile, 'utf8'));
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { image: (await response.json()).image, status: response.status, url };
  };
  succeed(['create', 'w1', '--apply']);
  succeed(attach(imageA));
  assert.deepEqual((await probe()).image, imageA);

  const oldImage = run(attach(imageB), { GROVE_PROCESS_TEST_SKIP_REPLACE: 'true', GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '600' });
  assert.notEqual(oldImage.status, 0);
  assert.equal(state().pending_by_env.w1.image, imageB);
  assert.equal(state().envs.w1.services.api.image, imageA);
  assert.equal((await probe()).image, imageA);

  writeFileSync(path.join(root, 'w1', 'not-ready'), 'readiness gate');
  const unready = run(attach(imageB), { GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '600' });
  assert.notEqual(unready.status, 0);
  assert.equal(state().pending_by_env.w1.image, imageB);
  assert.equal((await probe()).status, 503);
  unlinkSync(path.join(root, 'w1', 'not-ready'));
  succeed(attach(imageB));
  assert.equal(state().pending_by_env.w1, undefined);
  assert.equal(state().envs.w1.services.api.image, imageB);
  assert.equal((await probe()).image, imageB);
  succeed(['status']);

  const { url } = await probe();
  succeed(['detach', 'w1', 'api', '--apply']);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  assert.deepEqual(state().envs.w1.services, {});
  succeed(['destroy', 'w1', '--apply']);
  assert.equal(existsSync(stateFile), false);
  assert.equal(existsSync(endpointFile), false);
  t.diagnostic('process artifacts 2/2; rejected transitions 2/2; detached endpoints 1/1; destroyed environments 1/1');
});

test('overlay verify passes against the process backend that really starts a workload', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'grove-verify-process-'));
  const endpointFile = path.join(root, 'w1', 'endpoint.json');
  t.after(() => {
    if (existsSync(endpointFile)) {
      const { pid } = JSON.parse(readFileSync(endpointFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, '.agents'));
  writeFileSync(path.join(root, 'process-test-marker'), 'isolated');
  const source = `// verify artifact\n${WORKLOAD}`;
  const artifact = path.join(root, 'artifact-verify.mjs');
  writeFileSync(artifact, source);
  const image = `process/api@sha256:${createHash('sha256').update(source).digest('hex')}`;
  writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify({ [image]: artifact }));
  writeFileSync(path.join(root, '.agents/runtime-profile.yml'), stringify({
    project: { slug: 'process-verify' },
    addressing: { scheme: { overlay: '{service}--{env}.{project}.{tld}' } },
    runtime: { commands: { overlay: `${JSON.stringify(process.execPath)} ${JSON.stringify(BACKEND)}` } },
    services: { api: {} },
    overlay: { attachable: ['api'] },
    data: { infra: 'project' },
  }));

  const result = spawnSync(
    process.execPath,
    [CLI, 'overlay', 'verify', '--project', root, '--env', 'w1', '--image', image, '--json'],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        GROVE_STATE_DIR: path.join(root, 'state'),
        GROVE_PROCESS_TEST_ROOT: root,
        GROVE_OVERLAY_VERIFY_TIMEOUT_MS: '5000',
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.counts.failed, 0);
  // One service, no shared-only service to refuse: that case is counted skipped.
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.passed, report.counts.cases - 1);
  assert.equal(report.cleanup.ok, true);
  assert.equal(existsSync(endpointFile), false, 'the workload verify started is stopped again');
  assert.equal(existsSync(path.join(root, 'state', 'process-verify.yml')), false, 'no lease survives verify');
  t.diagnostic(`verify against a real backend: ${report.counts.passed}/${report.counts.cases - 1} cases, skipped 1, cleanup 1/1`);
});
