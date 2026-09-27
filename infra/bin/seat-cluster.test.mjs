import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

import { parseSeatCliArgs } from '../lib/seat.mjs';
import {
  compareSeatCluster,
  renderSeatClusterManifests,
  runSeatCluster,
  seatClusterDocuments,
} from '../lib/seat-cluster.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const CREATE = [
  '--volume', 'hostPath=/tmp/seat-w1',
  '--image', 'example.invalid/pause:1',
  '--cpu', '100m',
  '--memory', '64Mi',
  '--quota-pods', '2',
  '--quota-cpu', '200m',
  '--quota-memory', '128Mi',
];

function documentsOf(spec) {
  return parseAllDocuments(renderSeatClusterManifests(spec)).map((doc) => doc.toJS());
}

function spec() {
  return parseSeatCliArgs(['cluster', 'w1', ...CREATE]).spec;
}

test('cluster seat renders a Namespace of stock objects and no Job', () => {
  const docs = documentsOf(spec());
  assert.deepEqual(docs.map((doc) => doc.kind), [
    'Namespace', 'ServiceAccount', 'Role', 'RoleBinding', 'Pod', 'ResourceQuota', 'NetworkPolicy',
  ]);
  assert.equal(docs[0].metadata.name, 'w1');
  assert.equal(docs[0].metadata.labels['app.kubernetes.io/managed-by'], 'ground');
  assert.equal(docs[0].metadata.labels['ground/seat'], 'w1');
  const pod = docs.find((doc) => doc.kind === 'Pod');
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.containers[0].command, undefined);
  assert.equal(pod.spec.volumes[0].hostPath.type, 'Directory');
  assert.equal(pod.spec.volumes[0].hostPath.path, '/tmp/seat-w1');
  assert.equal(docs.find((doc) => doc.kind === 'Role').rules.length, 0);
  assert.equal(docs.find((doc) => doc.kind === 'ServiceAccount').automountServiceAccountToken, false);
  const quota = docs.find((doc) => doc.kind === 'ResourceQuota').spec.hard;
  assert.equal(quota.pods, '2');
  assert.equal(quota['requests.cpu'], '200m');
  const policy = docs.find((doc) => doc.kind === 'NetworkPolicy');
  assert.deepEqual(policy.spec.podSelector, {});
  assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
  const peers = JSON.stringify(policy.spec.egress);
  assert.match(peers, /kube-system/);
  assert.match(peers, /ground-infra/);
  assert.doesNotMatch(peers, /ipBlock/);
  assert.equal(docs.some((doc) => doc.kind === 'Job' || doc.kind === 'Deployment'), false);
});

test('a pvc volume adds a claim and keeps the Pod on that claim', () => {
  const parsed = parseSeatCliArgs([
    'cluster', 'w1',
    '--volume', 'pvc=1Gi',
    '--storage-class', 'local-path',
    '--image', 'example.invalid/pause:1',
    '--cpu', '100m', '--memory', '64Mi',
    '--quota-pods', '1', '--quota-cpu', '100m', '--quota-memory', '64Mi',
    '--egress', 'namespace=app',
    '--egress', 'cidr=10.1.0.0/16,port=443',
  ]);
  const docs = seatClusterDocuments(parsed.spec);
  const claim = docs.find((doc) => doc.kind === 'PersistentVolumeClaim');
  assert.equal(claim.spec.resources.requests.storage, '1Gi');
  assert.equal(claim.spec.storageClassName, 'local-path');
  const pod = docs.find((doc) => doc.kind === 'Pod');
  assert.deepEqual(pod.spec.volumes[0].persistentVolumeClaim, { claimName: 'workspace' });
  const policy = docs.find((doc) => doc.kind === 'NetworkPolicy');
  const extra = policy.spec.egress.slice(-2);
  assert.equal(extra[0].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'app');
  assert.equal(extra[1].to[0].ipBlock.cidr, '10.1.0.0/16');
  assert.equal(extra[1].ports[0].port, 443);
  assert.equal(extra[1].ports[0].protocol, 'TCP');
});

test('cluster flags refuse a missing target, a reserved name, and a quota smaller than the Pod', () => {
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', ...CREATE, '--apply']), /--cluster/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', ...CREATE, '--cluster', 'ground-qa']), /only valid with --apply/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'default', ...CREATE]), /reserved namespace/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'ground-infra', ...CREATE]), /reserved namespace/);
  assert.throws(() => parseSeatCliArgs([
    'cluster', 'w1', '--volume', 'hostPath=/tmp/seat-w1', '--image', 'example.invalid/pause:1',
    '--cpu', '100m', '--memory', '64Mi', '--quota-pods', '1', '--quota-cpu', '50m', '--quota-memory', '128Mi',
  ]), /quota-cpu/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--volume', 'hostPath=relative', ...CREATE.slice(2)]), /absolute/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--volume', 'hostPath=/', ...CREATE.slice(2)]), /filesystem root/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--volume', 'hostPath=/tmp/../etc', ...CREATE.slice(2)]), /normalized/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--volume', 'pvc=1Gi', '--storage-class', 'Local', ...CREATE.slice(2)]), /storage-class/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', ...CREATE, '--storage-class', 'local-path']), /storage-class/);
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--delete', '--volume', 'hostPath=/tmp/seat-w1']), /does not take --volume/);
  const named = parseSeatCliArgs(['cluster', 'w1', ...CREATE, '--cluster', 'local', '--apply']);
  assert.equal(named.spec.cluster, 'local');
});

test('dry-run prints the manifests and a count, and does not need a project', () => {
  const result = spawnSync(process.execPath, [CLI, 'seat', 'cluster', 'w1', ...CREATE], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const docs = parseAllDocuments(result.stdout).map((doc) => doc.toJS());
  assert.equal(docs.length, 7);
  assert.match(result.stderr, /objects 7\/7/);
  assert.match(result.stderr, /dry-run/);
  const remove = spawnSync(process.execPath, [CLI, 'seat', 'cluster', 'w1', '--delete'], { encoding: 'utf8' });
  assert.equal(remove.status, 0, remove.stderr);
  assert.match(remove.stdout, /delete namespace w1/);
  assert.match(remove.stdout, /dry-run/);
  assert.doesNotMatch(remove.stdout, /kind:/);
});

test('delete refuses a namespace that is not this seat and counts a labeled one', () => {
  const labeled = {
    kind: 'Namespace',
    metadata: { name: 'w1', labels: { 'app.kubernetes.io/managed-by': 'ground', 'ground/seat': 'w1' } },
  };
  const stranger = { kind: 'Namespace', metadata: { name: 'w1', labels: { app: 'other' } } };
  const objects = [
    labeled,
    { kind: 'Pod', metadata: { name: 'seat', labels: labeled.metadata.labels } },
  ];
  let deleted = false;
  const run = (command, args) => {
    assert.equal(command, 'kubectl');
    const joined = args.join(' ');
    if (joined.includes('delete namespace')) {
      deleted = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('get namespace')) {
      if (deleted) return { status: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "w1" not found' };
      return { status: 0, stdout: JSON.stringify(stranger), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
  };
  const refused = parseSeatCliArgs(['cluster', 'w1', '--delete', '--cluster', 'ground-qa', '--apply']);
  assert.throws(
    () => runSeatCluster({ options: { ...refused, spec: { ...refused.spec, kubeconfig: '/tmp/kubeconfig' } }, run }),
    /not this seat/,
  );
  assert.equal(deleted, false);

  const runOwned = (command, args) => {
    const joined = args.join(' ');
    if (joined.includes('delete namespace')) {
      deleted = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('get namespace')) {
      if (deleted) return { status: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "w1" not found' };
      return { status: 0, stdout: JSON.stringify(labeled), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ items: objects.slice(1) }), stderr: '' };
  };
  deleted = false;
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const code = runSeatCluster({
      options: { ...refused, spec: { ...refused.spec, kubeconfig: '/tmp/kubeconfig' } },
      run: runOwned,
    });
    assert.equal(code, 0);
  } finally {
    console.log = original;
  }
  assert.equal(deleted, true);
  assert.match(lines.join('\n'), /objects 0\/2/);
  assert.match(lines.join('\n'), /deleted namespace w1/);
});

test('suspend drops the pod and keeps the namespace', () => {
  assert.throws(() => parseSeatCliArgs(['cluster', 'w1', '--suspend', '--delete']), /exclude each other/);
  const dry = spawnSync(process.execPath, [CLI, 'seat', 'cluster', 'w1', '--suspend'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /suspend pod seat/);
  assert.match(dry.stdout, /dry-run/);
  const labeled = {
    kind: 'Namespace',
    metadata: { name: 'w1', labels: { 'app.kubernetes.io/managed-by': 'ground', 'ground/seat': 'w1' } },
  };
  const claim = { kind: 'PersistentVolumeClaim', metadata: { name: 'workspace', labels: labeled.metadata.labels } };
  let dropped = false;
  const run = (command, args) => {
    const joined = args.join(' ');
    if (joined.includes('delete pod seat')) {
      dropped = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('get namespace')) return { status: 0, stdout: JSON.stringify(labeled), stderr: '' };
    const items = dropped ? [claim] : [claim, { kind: 'Pod', metadata: { name: 'seat', labels: labeled.metadata.labels } }];
    return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
  };
  const options = parseSeatCliArgs(['cluster', 'w1', '--suspend', '--cluster', 'ground-qa', '--apply']);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  let code = 1;
  try {
    code = runSeatCluster({ options: { ...options, spec: { ...options.spec, kubeconfig: '/tmp/kubeconfig' } }, run });
  } finally {
    console.log = original;
  }
  assert.equal(code, 0);
  assert.equal(dropped, true);
  assert.match(lines.join('\n'), /pod 0\/1/);
  assert.match(lines.join('\n'), /kept 2/);
});

test('compareSeatCluster counts only the objects this seat rendered', () => {
  const expected = seatClusterDocuments(spec());
  const actual = expected.map((doc) => ({ ...doc }));
  actual.pop();
  actual.push({ kind: 'Pod', metadata: { name: 'stray', labels: { app: 'no' } } });
  const compared = compareSeatCluster({ expected, actual, id: 'w1' });
  assert.equal(compared.ready, expected.length - 1);
  assert.equal(compared.total, expected.length);
  assert.deepEqual(compared.missing, ['NetworkPolicy/seat']);
  assert.deepEqual(compared.drift, ['Pod/stray is not labeled as seat w1']);
});
