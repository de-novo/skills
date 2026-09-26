// Link a k3d cluster to Ground engines on the compose docker network.
// Does not create clusters and does not default to an existing "local" cluster.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stringify } from 'yaml';

export const K3D_NAMESPACE = 'ground-infra';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertDnsLabel(value, field) {
  if (typeof value !== 'string' || !DNS_LABEL.test(value)) {
    throw new Error(`${field} must be a lowercase Kubernetes DNS label — ${JSON.stringify(value)}`);
  }
  return value;
}

export function k3dServerContainer(cluster) {
  try {
    assertDnsLabel(cluster, 'k3d cluster name');
  } catch {
    throw new Error(`k3d cluster name is missing or malformed — ${JSON.stringify(cluster)}`);
  }
  return `k3d-${cluster}-server-0`;
}

export function parseK3dArgs(args) {
  let verb;
  const opts = { cluster: null, namespace: K3D_NAMESPACE, kubeconfig: null, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--cluster' || arg === '--namespace' || arg === '--kubeconfig') {
      const value = args[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.`);
      }
      i += 1;
      if (arg === '--cluster') opts.cluster = value;
      if (arg === '--namespace') opts.namespace = value;
      if (arg === '--kubeconfig') opts.kubeconfig = value;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown option "${arg}"`);
    }
    if (verb != null) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
    verb = arg;
  }
  if (verb == null) verb = 'status';
  if (verb !== 'connect' && verb !== 'status') {
    throw new Error(`infra k3d: unknown command "${verb}" — connect | status`);
  }
  if (opts.cluster == null) {
    throw new Error('infra k3d requires --cluster <name> (will not pick the existing local cluster).');
  }
  if (opts.dryRun && verb !== 'connect') {
    throw new Error('infra k3d: --dry-run is only valid with connect.');
  }
  k3dServerContainer(opts.cluster);
  assertDnsLabel(opts.namespace, 'namespace');
  return { verb, ...opts };
}

export function renderK3dLinkManifests({ namespace, links }) {
  assertDnsLabel(namespace, 'namespace');
  const docs = [{
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: { 'app.kubernetes.io/managed-by': 'ground' },
    },
  }];
  for (const link of links) {
    assertDnsLabel(link.name, 'engine name');
    if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65535) {
      throw new Error(`engine ${link.name} has an invalid port — ${JSON.stringify(link.port)}`);
    }
    if (typeof link.ip !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(link.ip)) {
      throw new Error(`engine ${link.name} has an invalid IPv4 address — ${JSON.stringify(link.ip)}`);
    }
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: link.name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'ground',
          'ground.engine': link.name,
        },
      },
      spec: {
        ports: [{ name: 'tcp', port: link.port, targetPort: link.port }],
      },
    });
    docs.push({
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: link.name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'ground',
          'kubernetes.io/service-name': link.name,
          'ground.engine': link.name,
        },
      },
      addressType: 'IPv4',
      ports: [{ name: 'tcp', protocol: 'TCP', port: link.port }],
      endpoints: [{ addresses: [link.ip] }],
    });
  }
  return `${docs.map((doc) => stringify(doc).trimEnd()).join('\n---\n')}\n`;
}

export function compareK3dLinks({ links, services = [], endpointSlices = [] }) {
  const expectedNames = new Set(links.map((link) => link.name));
  const drift = [];
  let ready = 0;

  for (const link of links) {
    const before = drift.length;
    const service = services.find((item) => item?.metadata?.name === link.name);
    if (!service) {
      drift.push(`${link.name} Service missing`);
    } else {
      const port = service.spec?.ports?.find((item) => item?.name === 'tcp') ?? service.spec?.ports?.[0];
      if (port?.port !== link.port || port?.targetPort !== link.port) {
        drift.push(`${link.name} Service port stale (want ${link.port})`);
      }
    }

    const slices = endpointSlices.filter(
      (item) => item?.metadata?.labels?.['kubernetes.io/service-name'] === link.name
    );
    if (slices.length === 0) {
      drift.push(`${link.name} EndpointSlice missing`);
    } else {
      const matches = slices.some((slice) => {
        const port = slice.ports?.find((item) => item?.name === 'tcp') ?? slice.ports?.[0];
        const addresses = (slice.endpoints ?? []).flatMap((endpoint) => endpoint?.addresses ?? []);
        return port?.port === link.port && addresses.includes(link.ip);
      });
      if (!matches) {
        drift.push(`${link.name} EndpointSlice stale (want ${link.ip}:${link.port})`);
      }
    }
    if (drift.length === before) ready += 1;
  }

  for (const service of services) {
    const name = service?.metadata?.name;
    if (typeof name === 'string' && !expectedNames.has(name)) {
      drift.push(`${name} Service unexpected`);
    }
  }
  for (const slice of endpointSlices) {
    const name = slice?.metadata?.labels?.['kubernetes.io/service-name'];
    if (typeof name === 'string' && !expectedNames.has(name)) {
      drift.push(`${name} EndpointSlice unexpected`);
    }
  }

  return { ready, total: links.length, drift };
}

export function writeTemporaryKubeconfig(cluster, contents) {
  k3dServerContainer(cluster);
  if (typeof contents !== 'string' || contents.length === 0) {
    throw new Error('k3d kubeconfig output is empty.');
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'ground-k3d-'));
  chmodSync(directory, 0o700);
  const file = path.join(directory, 'kubeconfig');
  try {
    writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    file,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function formatK3dLinkReport({
  cluster,
  network,
  node,
  nodeOnNetwork,
  links,
  skipped,
  dryRun,
  resources = null,
}) {
  const linked = links.length;
  const known = linked + skipped.length;
  const lines = [
    `■ cluster seat (k3d) — ${cluster}`,
    `  node     ${node}${nodeOnNetwork ? ` on ${network}` : ` not on ${network}`}`,
    `  engines  ${linked}/${known}${dryRun ? '  dry-run' : ''}`,
  ];
  for (const link of links) {
    lines.push(`           ${link.name} ${link.ip}:${link.port}`);
  }
  for (const skip of skipped) {
    lines.push(`           ${skip.name} skipped (${skip.reason})`);
  }
  if (resources) {
    lines.push(`  resources ${resources.ready}/${resources.total}`);
    for (const item of resources.drift) lines.push(`           drift: ${item}`);
  }
  return lines.join('\n');
}
