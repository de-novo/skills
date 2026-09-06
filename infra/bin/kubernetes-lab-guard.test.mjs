import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('./fixtures/kubernetes-lab/backend.mjs', import.meta.url));
for (const kind of ['existing cluster', 'different context', 'external kubeconfig', 'valid private target']) {
  test(`Kubernetes acceptance lab target guard: ${kind}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grove-lab-guard-'));
    try {
      const config = { cluster: 'grove-test-owned', context: 'k3d-grove-test-owned', kubeconfig: path.join(root, 'kubeconfig') };
      if (kind === 'existing cluster') config.cluster = 'local';
      if (kind === 'different context') config.context = 'k3d-local';
      if (kind === 'external kubeconfig') config.kubeconfig = path.join(root, '..', 'kubeconfig');
      writeFileSync(path.join(root, 'lab.json'), JSON.stringify(config));
      // No executable kubectl is available, so even the positive control cannot reach a cluster.
      const result = spawnSync(process.execPath, [backend, 'create', 'w1', '--apply'], { env: { PATH: '', GROVE_KUBERNETES_LAB: root }, encoding: 'utf8', timeout: 3000 });
      assert.notEqual(result.status, 0);
      if (kind === 'valid private target') {
        assert.match(result.stderr, /Lab kubectl failed/);
        assert.doesNotMatch(result.stderr, /Refusing a non-lab/);
      } else assert.match(result.stderr, /Refusing a non-lab Kubernetes target/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
