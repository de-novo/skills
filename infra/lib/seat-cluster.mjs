// A cluster seat is one Namespace of stock Kubernetes objects on k3s or k8s.
// The seat id is the namespace. This file renders and applies those objects.
// It does not create clusters, and the Pod's image is the place, not an agent.
import path from 'node:path';

import { stringify } from 'yaml';

import { K3D_NAMESPACE } from './k3d-link.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CPU = /^([0-9]+)(m)?$/;
const MEMORY = /^([0-9]+)(Ki|Mi|Gi|Ti)?$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const STORAGE_CLASS = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;

// Names Kubernetes already owns, plus the engine-link namespace.
const RESERVED_NAMESPACES = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease', K3D_NAMESPACE]);

const LABELS = (id) => ({
  'app.kubernetes.io/managed-by': 'ground',
  'app.kubernetes.io/name': 'seat',
  'ground/seat': id,
});

function fail(message) {
  throw new Error(message);
}

function assertDnsLabel(value, field) {
  if (typeof value !== 'string' || !DNS_LABEL.test(value)) {
    fail(`${field} must be a lowercase Kubernetes DNS label — ${JSON.stringify(value)}`);
  }
  return value;
}

function assertSeatNamespace(id) {
  assertDnsLabel(id, 'seat id');
  if (RESERVED_NAMESPACES.has(id)) fail(`seat id ${id} is a reserved namespace.`);
  return id;
}

function cpuMillicores(value, field) {
  const match = CPU.exec(value ?? '');
  if (match == null) fail(`${field} must be an integer or millicores (500m) — ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  if (amount < 1) fail(`${field} must be at least 1 — ${JSON.stringify(value)}`);
  return match[2] == null ? amount * 1000 : amount;
}

function memoryBytes(value, field) {
  const match = MEMORY.exec(value ?? '');
  if (match == null) fail(`${field} must be an integer with an optional Ki, Mi, Gi, or Ti suffix — ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  if (amount < 1) fail(`${field} must be at least 1 — ${JSON.stringify(value)}`);
  const scale = { undefined: 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return amount * scale[match[2]];
}

function parseVolume(value) {
  if (typeof value !== 'string') fail('--volume must be hostPath=PATH or pvc=SIZE.');
  const host = /^hostPath=(.+)$/.exec(value);
  if (host != null) {
    if (!host[1].startsWith('/')) fail('--volume hostPath must be an absolute path.');
    const resolved = path.resolve(host[1]);
    if (resolved !== host[1]) fail('--volume hostPath must already be normalized.');
    if (resolved === '/') fail('--volume hostPath must not be the filesystem root.');
    return { kind: 'hostPath', path: resolved };
  }
  const pvc = /^pvc=([0-9]+(?:Ki|Mi|Gi|Ti))$/.exec(value);
  if (pvc != null) return { kind: 'pvc', size: pvc[1], storageClass: null };
  fail('--volume must be hostPath=PATH or pvc=SIZE.');
}

function parseCidr(value) {
  const match = CIDR.exec(value ?? '');
  if (match == null) fail(`--egress cidr must be an IPv4 CIDR — ${JSON.stringify(value)}`);
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) {
    fail(`--egress cidr must be an IPv4 CIDR — ${JSON.stringify(value)}`);
  }
  return value;
}

function parseEgress(value) {
  const namespace = /^namespace=([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.exec(value ?? '');
  if (namespace != null) return { namespace: namespace[1] };
  const parts = {};
  for (const piece of String(value ?? '').split(',')) {
    const split = piece.indexOf('=');
    if (split < 1) fail(`--egress must be namespace=NAME or cidr=CIDR,port=N — ${JSON.stringify(value)}`);
    parts[piece.slice(0, split)] = piece.slice(split + 1);
  }
  if (parts.cidr == null || parts.port == null) {
    fail(`--egress must be namespace=NAME or cidr=CIDR,port=N — ${JSON.stringify(value)}`);
  }
  const port = Number(parts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`--egress port must be 1–65535 — ${JSON.stringify(parts.port)}`);
  }
  const protocol = parts.protocol ?? 'TCP';
  if (protocol !== 'TCP' && protocol !== 'UDP') fail(`--egress protocol must be TCP or UDP — ${JSON.stringify(protocol)}`);
  const extra = Object.keys(parts).filter((key) => !['cidr', 'port', 'protocol'].includes(key));
  if (extra.length > 0) fail(`--egress has unknown field ${JSON.stringify(extra[0])}.`);
  return { cidr: parseCidr(parts.cidr), port, protocol };
}

function requireCreate(options) {
  const missing = [];
  if (options.volume == null) missing.push('--volume');
  if (options.image == null) missing.push('--image');
  if (options.cpu == null) missing.push('--cpu');
  if (options.memory == null) missing.push('--memory');
  if (options.quotaPods == null) missing.push('--quota-pods');
  if (options.quotaCpu == null) missing.push('--quota-cpu');
  if (options.quotaMemory == null) missing.push('--quota-memory');
  if (missing.length > 0) fail(`cluster requires ${missing.join(', ')}.`);
}

// Turns parsed CLI flags into the spec the renderer accepts.
export function seatClusterSpecFromOptions(options) {
  assertSeatNamespace(options.id);
  if (options.delete && options.suspend) fail('--suspend and --delete exclude each other.');
  const retiring = options.delete || options.suspend;
  if (retiring && options.volume != null) fail(`--${options.suspend ? 'suspend' : 'delete'} does not take --volume.`);
  if (retiring && (options.image != null || options.cpu != null || options.memory != null || options.quotaPods != null || options.quotaCpu != null || options.quotaMemory != null || options.storageClass != null || options.enginesNamespace != null || (options.egress ?? []).length > 0)) {
    fail(`--${options.suspend ? 'suspend' : 'delete'} does not take resource flags.`);
  }
  if (options.cluster != null && !options.apply) fail('--cluster is only valid with --apply.');
  if (options.kubeconfig != null && !options.apply) fail('--kubeconfig is only valid with --apply.');
  if (options.apply && options.cluster == null) fail('--apply requires --cluster NAME.');
  if (options.cluster != null) assertDnsLabel(options.cluster, '--cluster');
  if (options.delete) return { id: options.id, delete: true, suspend: false, cluster: options.cluster, kubeconfig: options.kubeconfig };
  if (options.suspend) return { id: options.id, delete: false, suspend: true, cluster: options.cluster, kubeconfig: options.kubeconfig };

  requireCreate(options);
  if (options.storageClass != null && !options.volume.startsWith('pvc=')) {
    fail('--storage-class is only valid with --volume pvc=SIZE.');
  }
  const volume = parseVolume(options.volume);
  if (volume.kind === 'pvc' && options.storageClass != null) {
    if (!STORAGE_CLASS.test(options.storageClass)) fail(`--storage-class must be a DNS subdomain — ${JSON.stringify(options.storageClass)}`);
    volume.storageClass = options.storageClass;
  }
  if (!IMAGE.test(options.image)) fail(`--image must be an image reference without spaces — ${JSON.stringify(options.image)}`);
  const resources = { cpu: options.cpu, memory: options.memory };
  const pods = Number(options.quotaPods);
  if (!/^[0-9]+$/.test(options.quotaPods) || !Number.isInteger(pods) || pods < 1) {
    fail(`--quota-pods must be an integer of at least 1 — ${JSON.stringify(options.quotaPods)}`);
  }
  const quota = { pods, cpu: options.quotaCpu, memory: options.quotaMemory };
  if (cpuMillicores(resources.cpu, '--cpu') > cpuMillicores(quota.cpu, '--quota-cpu')) {
    fail('--quota-cpu must cover the Pod --cpu.');
  }
  if (memoryBytes(resources.memory, '--memory') > memoryBytes(quota.memory, '--quota-memory')) {
    fail('--quota-memory must cover the Pod --memory.');
  }
  const enginesNamespace = options.enginesNamespace ?? K3D_NAMESPACE;
  assertDnsLabel(enginesNamespace, '--engines-namespace');
  return {
    id: options.id,
    delete: false,
    suspend: false,
    image: options.image,
    resources,
    quota,
    volume,
    enginesNamespace,
    egress: (options.egress ?? []).map(parseEgress),
    cluster: options.cluster,
    kubeconfig: options.kubeconfig,
  };
}

function metadata(id, name) {
  return { name, namespace: id, labels: LABELS(id) };
}

function workspaceVolume(spec) {
  if (spec.volume.kind === 'hostPath') {
    // Directory, not DirectoryOrCreate: a missing worktree must fail, not
    // be created as root on the node.
    return { name: 'workspace', hostPath: { path: spec.volume.path, type: 'Directory' } };
  }
  return { name: 'workspace', persistentVolumeClaim: { claimName: 'workspace' } };
}

function networkPolicy(spec) {
  const egress = [
    { to: [{ podSelector: {} }] },
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': spec.enginesNamespace } } }] },
  ];
  for (const peer of spec.egress) {
    if (peer.namespace != null) {
      egress.push({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': peer.namespace } } }] });
    } else {
      egress.push({
        to: [{ ipBlock: { cidr: peer.cidr } }],
        ports: [{ protocol: peer.protocol, port: peer.port }],
      });
    }
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadata(spec.id, 'seat'),
    spec: {
      // The namespace is the boundary, so every Pod in it is selected.
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ podSelector: {} }] }],
      egress,
    },
  };
}

// The objects for one seat, in apply order. A pvc volume adds a claim.
export function seatClusterDocuments(spec) {
  const id = assertSeatNamespace(spec.id);
  if (spec.volume?.kind !== 'hostPath' && spec.volume?.kind !== 'pvc') fail('volume kind must be hostPath or pvc.');
  if (spec.image == null) fail('image is required.');
  if (spec.resources?.cpu == null || spec.resources?.memory == null) fail('Pod resources are required.');
  if (spec.quota?.pods == null || spec.quota?.cpu == null || spec.quota?.memory == null) fail('ResourceQuota is required.');
  if (spec.enginesNamespace == null) fail('engines namespace is required.');
  const documents = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: id, labels: LABELS(id) },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: metadata(id, 'seat'),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: metadata(id, 'seat'),
      rules: [],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: metadata(id, 'seat'),
      subjects: [{ kind: 'ServiceAccount', name: 'seat', namespace: id }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'seat' },
    },
  ];
  if (spec.volume.kind === 'pvc') {
    const claim = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: metadata(id, 'workspace'),
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: spec.volume.size } },
      },
    };
    if (spec.volume.storageClass != null) claim.spec.storageClassName = spec.volume.storageClass;
    documents.push(claim);
  }
  documents.push(
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: metadata(id, 'seat'),
      spec: {
        serviceAccountName: 'seat',
        automountServiceAccountToken: false,
        // Completion is the worker's report, not this process exiting.
        restartPolicy: 'Never',
        enableServiceLinks: false,
        containers: [
          {
            name: 'seat',
            image: spec.image,
            resources: {
              requests: { cpu: spec.resources.cpu, memory: spec.resources.memory },
              limits: { cpu: spec.resources.cpu, memory: spec.resources.memory },
            },
            volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
          },
        ],
        volumes: [workspaceVolume(spec)],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: metadata(id, 'seat'),
      spec: {
        hard: {
          pods: String(spec.quota.pods),
          'requests.cpu': spec.quota.cpu,
          'requests.memory': spec.quota.memory,
          'limits.cpu': spec.quota.cpu,
          'limits.memory': spec.quota.memory,
        },
      },
    },
    networkPolicy(spec),
  );
  return documents;
}

export function renderSeatClusterManifests(spec) {
  const documents = seatClusterDocuments(spec);
  return `${documents.map((document) => stringify(document).trimEnd()).join('\n---\n')}\n`;
}

export function formatSeatClusterReport({ id, cluster, ready, total, dryRun = false, deleted = false, suspended = false, kept = null }) {
  const where = cluster == null ? '' : ` — ${cluster}`;
  const lines = [`cluster seat ${id}${where}`];
  if (suspended) {
    lines.push('pod 0/1');
    lines.push(`kept ${kept}`);
  } else {
    lines.push(`objects ${ready}/${total}`);
  }
  if (deleted) lines.push(`deleted namespace ${id}`);
  if (dryRun) lines.push('dry-run');
  return lines.join('\n');
}

export function clusterSeatTargetWarning(cluster) {
  if (cluster === 'local') return '--cluster local is the existing machine cluster; not a sandbox.';
  return null;
}

function kubectl(run, kubeconfig, args, extra = {}) {
  if (typeof run !== 'function') fail('seat: cluster --apply needs a command runner.');
  const result = run('kubectl', ['--kubeconfig', kubeconfig, ...args], extra);
  if (result == null || result.status !== 0) {
    const detail = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`.trim();
    const error = new Error(`seat: ${detail.length > 0 ? detail : 'kubectl failed.'}`);
    error.notFound = /NotFound/.test(detail);
    throw error;
  }
  return result;
}

function kubectlJson(run, kubeconfig, args) {
  const result = kubectl(run, kubeconfig, [...args, '-o', 'json']);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('seat: kubectl returned malformed JSON.');
  }
}

function owned(object, id) {
  const labels = object?.metadata?.labels ?? {};
  return labels['app.kubernetes.io/managed-by'] === 'ground' && labels['ground/seat'] === id;
}

export function compareSeatCluster({ expected, actual, id }) {
  const want = new Set(expected.map((document) => `${document.kind}/${document.metadata.name}`));
  const got = new Set();
  const drift = [];
  for (const object of actual) {
    const key = `${object.kind}/${object.metadata?.name}`;
    if (!owned(object, id)) {
      drift.push(`${key} is not labeled as seat ${id}`);
      continue;
    }
    if (!want.has(key)) drift.push(`${key} unexpected`);
    else got.add(key);
  }
  return {
    ready: got.size,
    total: want.size,
    missing: [...want].filter((key) => !got.has(key)),
    drift,
  };
}

const LIST_RESOURCES = 'serviceaccount,role,rolebinding,pod,resourcequota,networkpolicy,persistentvolumeclaim';

export function readSeatClusterObjects({ run, kubeconfig, id }) {
  const namespace = kubectlJson(run, kubeconfig, ['get', 'namespace', id]);
  const listed = kubectlJson(run, kubeconfig, ['get', LIST_RESOURCES, '-n', id, '-l', 'app.kubernetes.io/managed-by=ground']);
  if (!Array.isArray(listed.items)) fail('seat: kubectl get did not return a List.');
  return [namespace, ...listed.items];
}

export function runSeatCluster({ options, run }) {
  const spec = options.spec ?? seatClusterSpecFromOptions(options);
  const warning = clusterSeatTargetWarning(spec.cluster);
  if (warning != null) console.error(`seat cluster: ${warning}`);

  if (spec.delete && !options.apply) {
    console.log(`cluster seat ${spec.id}\ndelete namespace ${spec.id}\ndry-run`);
    return 0;
  }

  if (spec.suspend && !options.apply) {
    console.log(`cluster seat ${spec.id}\nsuspend pod seat\ndry-run`);
    return 0;
  }

  if (!spec.delete && !spec.suspend && !options.apply) {
    const documents = seatClusterDocuments(spec);
    console.log(renderSeatClusterManifests(spec));
    console.error(formatSeatClusterReport({ id: spec.id, cluster: null, ready: documents.length, total: documents.length, dryRun: true }));
    return 0;
  }

  if (spec.kubeconfig == null) fail('seat: --apply needs a kubeconfig.');

  if (spec.delete) {
    let namespace;
    try {
      namespace = kubectlJson(run, spec.kubeconfig, ['get', 'namespace', spec.id]);
    } catch (error) {
      if (error.notFound) fail(`seat: namespace ${spec.id} is not on the cluster.`);
      throw error;
    }
    if (!owned(namespace, spec.id)) fail(`seat: namespace ${spec.id} is not this seat's; refusing to delete it.`);
    const present = readSeatClusterObjects({ run, kubeconfig: spec.kubeconfig, id: spec.id }).filter((object) => owned(object, spec.id));
    kubectl(run, spec.kubeconfig, ['delete', 'namespace', spec.id, '--wait=true']);
    let gone = false;
    try {
      kubectlJson(run, spec.kubeconfig, ['get', 'namespace', spec.id]);
    } catch (error) {
      if (!error.notFound) throw error;
      gone = true;
    }
    if (!gone) fail(`seat: namespace ${spec.id} is still on the cluster.`);
    console.log(formatSeatClusterReport({
      id: spec.id,
      cluster: spec.cluster,
      ready: 0,
      total: present.length,
      deleted: true,
    }));
    return 0;
  }

  if (spec.suspend) {
    let namespace;
    try {
      namespace = kubectlJson(run, spec.kubeconfig, ['get', 'namespace', spec.id]);
    } catch (error) {
      if (error.notFound) fail(`seat: namespace ${spec.id} is not on the cluster.`);
      throw error;
    }
    if (!owned(namespace, spec.id)) fail(`seat: namespace ${spec.id} is not this seat's; refusing to suspend it.`);
    try {
      kubectl(run, spec.kubeconfig, ['delete', 'pod', 'seat', '-n', spec.id, '--wait=true']);
    } catch (error) {
      if (!error.notFound) throw error;
    }
    const after = readSeatClusterObjects({ run, kubeconfig: spec.kubeconfig, id: spec.id }).filter((object) => owned(object, spec.id));
    const pod = after.find((object) => object.kind === 'Pod' && object.metadata?.name === 'seat');
    if (pod != null) fail(`seat: pod seat is still in namespace ${spec.id}.`);
    const kept = after.filter((object) => object.kind !== 'Pod').length;
    console.log(formatSeatClusterReport({
      id: spec.id,
      cluster: spec.cluster,
      ready: 0,
      total: 1,
      suspended: true,
      kept,
    }));
    return 0;
  }

  const documents = seatClusterDocuments(spec);
  kubectl(run, spec.kubeconfig, ['apply', '-f', '-'], { input: renderSeatClusterManifests(spec) });
  const compared = compareSeatCluster({
    expected: documents,
    actual: readSeatClusterObjects({ run, kubeconfig: spec.kubeconfig, id: spec.id }),
    id: spec.id,
  });
  console.log(formatSeatClusterReport({
    id: spec.id,
    cluster: spec.cluster,
    ready: compared.ready,
    total: compared.total,
  }));
  if (compared.missing.length > 0 || compared.drift.length > 0) {
    for (const line of [...compared.missing.map((key) => `${key} missing`), ...compared.drift]) {
      console.error(line);
    }
    return 1;
  }
  return 0;
}
