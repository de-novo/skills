// Deliberately isolated Kubernetes adapter for exercising the public Grove CLI.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.env.GROVE_KUBERNETES_LAB;
if (!root || !existsSync(join(root, 'lab.json'))) throw new Error('Private Kubernetes lab configuration required');
const config = JSON.parse(readFileSync(join(root, 'lab.json'), 'utf8'));
if (!/^grove-test-[a-z0-9-]+$/.test(config.cluster) || config.context !== `k3d-${config.cluster}` || resolve(config.kubeconfig) !== join(resolve(root), 'kubeconfig')) throw new Error('Refusing a non-lab Kubernetes target');
export function kubectl(args, input) {
  const result = spawnSync('kubectl', ['--kubeconfig', config.kubeconfig, '--context', config.context, '--request-timeout=10s', ...args], {
    encoding: 'utf8', input: input == null ? undefined : JSON.stringify(input), timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`Lab kubectl failed: ${args.slice(0, 5).join(' ')}: ${result.stderr}`);
  return result.stdout;
}
const json = args => JSON.parse(kubectl([...args, '-o', 'json']));
const exists = (kind, name, ns) => {
  const result = kubectl([...(ns ? ['-n', ns] : []), 'get', kind, name, '--ignore-not-found', '-o', 'json']);
  return result.trim() ? JSON.parse(result) : null;
};
const marker = json(['get', 'namespace', 'grove-lab-base']);
if (marker.metadata.labels?.['grove.test/run'] !== config.cluster) throw new Error('Lab ownership marker mismatch');
const [verb, env, candidateService] = process.argv.slice(2);
const service = ['attach', 'detach'].includes(verb) ? candidateService : undefined;
if (!['status', 'create', 'attach', 'detach', 'destroy'].includes(verb)) throw new Error('Unknown lab verb');
if (env && !/^(w1|w2|w3|failure|timeout)$/.test(env)) throw new Error('Unknown lab environment');
const args = process.argv.slice(2); const apply = args.includes('--apply');
const image = args.includes('--image') ? args[args.indexOf('--image') + 1] : undefined;
const namespace = env ? `grove-lab-${env}` : null;
const labels = { 'grove.test/run': config.cluster, 'grove.test/environment': env };
const trace = stage => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ stage, verb, env, service, pid: process.pid, ppid: process.ppid, at: Date.now() }) + '\n');
const routes = () => json(['-n', 'grove-lab-base', 'get', 'configmap', 'routes']).data ?? {};
const updateRoute = value => kubectl(['-n', 'grove-lab-base', 'patch', 'configmap', 'routes', '--type=merge', '-p', JSON.stringify({ data: { [env]: value === null ? null : JSON.stringify(value) } })]);
const applyResources = items => kubectl(['apply', '-f', '-'], { apiVersion: 'v1', kind: 'List', items });
trace('start');
if (verb === 'status') {
  const namespaces = json(['get', 'namespaces', '-l', `grove.test/run=${config.cluster}`]).items;
  const routing = routes();
  const inventory = [];
  for (const name of env ? [env] : [...new Set([...namespaces.map(ns => ns.metadata.labels['grove.test/environment']).filter(Boolean), ...Object.keys(routing)])]) {
    const ns = `grove-lab-${name}`; const resource = namespaces.find(item => item.metadata.name === ns);
    if (!resource && !Object.hasOwn(routing, name)) continue;
    const services = resource ? json(['-n', ns, 'get', 'deployments']).items.map(deploy => {
      const pods = json(['-n', ns, 'get', 'pods', '-l', `app=${deploy.metadata.name}`]).items.filter(pod => !pod.metadata.deletionTimestamp);
      const images = new Set(pods.flatMap(pod => (pod.status.containerStatuses ?? []).map(container => container.imageID?.replace(/^\w+:\/\//, '')).filter(Boolean)));
      if (images.size !== 1) return deploy.metadata.name;
      const observedImage = [...images][0];
      if (!/@sha256:[a-f0-9]{64}$/.test(observedImage)) return deploy.metadata.name;
      const replicas = deploy.spec.replicas;
      const ready = replicas > 0 && pods.length === replicas && deploy.status.observedGeneration === deploy.metadata.generation &&
        deploy.status.updatedReplicas === replicas && deploy.status.readyReplicas === replicas && deploy.status.availableReplicas === replicas &&
        pods.every(pod => pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
      return { service: deploy.metadata.name, image: observedImage, ready };
    }) : [];
    inventory.push({ env: name, services });
  }
  console.log(JSON.stringify({ ok: true, verb, environments: inventory }));
} else {
  if (service && !['web', 'api'].includes(service)) throw new Error('Unknown lab service');
  if (apply) {
    if (verb === 'create') {
      applyResources([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels } }]);
      if (!Object.hasOwn(routes(), env)) updateRoute({});
    } else if (verb === 'attach') {
      if (!exists('namespace', namespace)) throw new Error('Create the lab environment first');
      if (!/^docker\.io\/grove-lab\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Lab digest image required');
      if (!existsSync(join(root, `skip-replace-${env}`))) {
        const appLabels = { ...labels, app: service };
        applyResources([
          { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: service, namespace, labels: appLabels }, spec: {
            replicas: 1, selector: { matchLabels: { app: service } }, template: { metadata: { labels: appLabels }, spec: {
              terminationGracePeriodSeconds: 1, containers: [{ name: 'app', image, imagePullPolicy: 'Never',
                env: [{ name: 'ROLE', value: service }, { name: 'ENVIRONMENT', value: env }], ports: [{ containerPort: 8080 }],
                readinessProbe: { httpGet: { path: '/ready', port: 8080 }, periodSeconds: 1, failureThreshold: 1 },
                resources: { requests: { cpu: '10m', memory: '24Mi' }, limits: { memory: '128Mi' } },
              }],
            } },
          } },
          { apiVersion: 'v1', kind: 'Service', metadata: { name: service, namespace, labels: appLabels }, spec: { selector: { app: service }, ports: [{ port: 8080, targetPort: 8080 }] } },
        ]);
        updateRoute({ ...JSON.parse(routes()[env] ?? '{}'), [service]: namespace });
      }
    } else if (verb === 'detach') {
      const mapping = JSON.parse(routes()[env] ?? '{}'); delete mapping[service]; updateRoute(mapping);
      kubectl(['-n', namespace, 'delete', `deployment/${service}`, `service/${service}`, '--ignore-not-found', '--timeout=20s']);
    } else if (verb === 'destroy') {
      updateRoute(null);
      kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--timeout=20s']);
    }
    trace('mutated');
    const hold = join(root, `hold-${verb}-${env}`);
    if (existsSync(hold)) {
      writeFileSync(hold + '.entered', JSON.stringify({ pid: process.pid, ppid: process.ppid }));
      while (existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (existsSync(join(root, `fail-${verb}-${env}`))) throw new Error('Injected failure after real Kubernetes mutation');
  }
  console.log(JSON.stringify({ ok: true, verb, env, ...(service && { service }), ...(image && { image }), plan: !apply }));
}
trace('end');
