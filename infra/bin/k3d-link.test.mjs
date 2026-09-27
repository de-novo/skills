import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';

import * as k3d from '../lib/k3d-link.mjs';

import {
  compareK3dJoin,
  formatK3dJoinReport,
  formatK3dLinkReport,
  k3dServerContainer,
  memberLabel,
  parseK3dArgs,
  renderK3dLinkManifests,
} from '../lib/k3d-link.mjs';

test('k3d server container name follows k3d-<cluster>-server-0', () => {
  assert.equal(k3dServerContainer('ground-qa'), 'k3d-ground-qa-server-0');
  assert.throws(() => k3dServerContainer(''), /malformed/);
  assert.throws(() => k3dServerContainer('Local'), /malformed/);
});

test('parseK3dArgs requires --cluster and does not default to local', () => {
  assert.throws(() => parseK3dArgs(['connect']), /--cluster/);
  const parsed = parseK3dArgs(['connect', '--cluster', 'ground-qa', '--dry-run']);
  assert.deepEqual(parsed, {
    verb: 'connect',
    cluster: 'ground-qa',
    namespace: 'ground-infra',
    kubeconfig: null,
    dryRun: true,
  });
});

test('parseK3dArgs rejects a namespace that is not a Kubernetes DNS label', () => {
  assert.throws(
    () => parseK3dArgs(['status', '--cluster', 'ground-qa', '--namespace', 'bad\nmetadata:']),
    /namespace/
  );
  assert.throws(
    () => parseK3dArgs(['status', '--cluster', 'ground-qa', '--namespace', 'A'.repeat(64)]),
    /namespace/
  );
});

test('k3d --dry-run is only valid for connect', () => {
  assert.throws(
    () => parseK3dArgs(['status', '--cluster', 'ground-qa', '--dry-run']),
    /dry-run.*connect/
  );
  assert.throws(
    () => parseK3dArgs(['join', '--cluster', 'ground-qa', '--dry-run']),
    /dry-run.*connect/
  );
});

test('join requires --cluster and does not default to local', () => {
  assert.throws(() => parseK3dArgs(['join']), /--cluster/);
  assert.equal(parseK3dArgs(['join', '--cluster', 'ground-qa']).verb, 'join');
  assert.equal(memberLabel('Host.Local'), 'host.local');
  assert.throws(() => memberLabel('...'), /hostname/);
});

test('join counts ready nodes, this computer, and linked engines', () => {
  const host = 'host.local';
  const nodes = [
    {
      metadata: { name: 'k3d-ground-qa-server-0', labels: { 'ground.seat/host': host } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    },
    {
      metadata: { name: 'k3d-ground-qa-agent-0', labels: {} },
      status: { conditions: [{ type: 'Ready', status: 'False' }] },
    },
  ];
  const services = [{ metadata: { name: 'mysql' } }];
  const compared = compareK3dJoin({ nodes, services, engines: ['mysql', 'pg'], host });
  assert.deepEqual(compared, {
    nodesReady: 1,
    nodesTotal: 2,
    member: 1,
    enginesReady: 1,
    enginesTotal: 2,
    missing: ['pg'],
  });
  const text = formatK3dJoinReport({ cluster: 'ground-qa', host, compared });
  assert.match(text, /nodes {4}1\/2/);
  assert.match(text, /member {3}host\.local 1\/2/);
  assert.match(text, /engines {2}1\/2/);
  assert.match(text, /pg not linked/);
  assert.match(text, /next {5}de-novo skills infra k3d connect --cluster ground-qa/);
  assert.equal(compareK3dJoin({ nodes: [], services: [], engines: [], host }).nodesTotal, 0);
});

test('renderK3dLinkManifests writes Service + EndpointSlice per engine', () => {
  const yaml = renderK3dLinkManifests({
    namespace: 'ground-infra',
    links: [
      { name: 'mysql', ip: '192.168.107.2', port: 3306 },
      { name: 'pg', ip: '192.168.107.3', port: 5432 },
    ],
  });
  assert.match(yaml, /name: ground-infra/);
  assert.match(yaml, /name: mysql/);
  assert.match(yaml, /kubernetes.io\/service-name: mysql/);
  assert.match(yaml, /192\.168\.107\.2/);
  assert.match(yaml, /port: 3306/);
  assert.match(yaml, /name: pg/);
  assert.match(yaml, /192\.168\.107\.3/);
});

test('formatK3dLinkReport counts linked engines', () => {
  const text = formatK3dLinkReport({
    cluster: 'ground-qa',
    network: 'dev-infra',
    node: 'k3d-ground-qa-server-0',
    nodeOnNetwork: true,
    links: [{ name: 'mysql', ip: '192.168.107.2', port: 3306 }],
    skipped: [{ name: 'kafka', reason: 'not running' }],
    dryRun: true,
  });
  assert.match(text, /cluster seat \(k3d\) — ground-qa/);
  assert.match(text, /engines {2}1\/2/);
  assert.match(text, /mysql 192\.168\.107\.2:3306/);
  assert.match(text, /kafka skipped/);
});

test('compareK3dLinks counts only matching Service and EndpointSlice pairs', () => {
  assert.equal(typeof k3d.compareK3dLinks, 'function');
  const result = k3d.compareK3dLinks({
    links: [{ name: 'mysql', ip: '192.168.107.2', port: 3306 }],
    services: [{
      metadata: { name: 'mysql' },
      spec: { ports: [{ name: 'tcp', port: 3306, targetPort: 3306 }] },
    }],
    endpointSlices: [{
      metadata: {
        name: 'mysql',
        labels: { 'kubernetes.io/service-name': 'mysql' },
      },
      ports: [{ name: 'tcp', protocol: 'TCP', port: 3306 }],
      endpoints: [{ addresses: ['192.168.107.2'] }],
    }],
  });
  assert.deepEqual(result, { ready: 1, total: 1, drift: [] });
});

test('compareK3dLinks reports missing, stale, and unexpected resources', () => {
  assert.equal(typeof k3d.compareK3dLinks, 'function');
  const result = k3d.compareK3dLinks({
    links: [{ name: 'mysql', ip: '192.168.107.2', port: 3306 }],
    services: [
      { metadata: { name: 'mysql' }, spec: { ports: [{ port: 9999, targetPort: 9999 }] } },
      { metadata: { name: 'old-engine' }, spec: { ports: [{ port: 1234 }] } },
    ],
    endpointSlices: [],
  });
  assert.equal(result.ready, 0);
  assert.equal(result.total, 1);
  assert.ok(result.drift.some((line) => line.includes('mysql Service port')));
  assert.ok(result.drift.some((line) => line.includes('mysql EndpointSlice missing')));
  assert.ok(result.drift.some((line) => line.includes('old-engine Service unexpected')));
});

test('temporary kubeconfig is private and cleanup removes its directory', () => {
  assert.equal(typeof k3d.writeTemporaryKubeconfig, 'function');
  const temp = k3d.writeTemporaryKubeconfig('ground-qa', 'apiVersion: v1\n');
  try {
    assert.equal(statSync(temp.file).mode & 0o777, 0o600);
    assert.equal(statSync(temp.directory).mode & 0o777, 0o700);
  } finally {
    temp.cleanup();
  }
  assert.equal(existsSync(temp.directory), false);
});
