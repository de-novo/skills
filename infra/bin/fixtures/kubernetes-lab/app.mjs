import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

const feature = JSON.parse(readFileSync(new URL('./feature.json', import.meta.url)));
const calculate = value => value * 1;
const role = process.env.ROLE;
const environment = process.env.ENVIRONMENT;
let routes = null;
if (role === 'router') {
  const directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  const poll = () => {
    const request = httpsRequest({ hostname: process.env.KUBERNETES_SERVICE_HOST,
      port: process.env.KUBERNETES_SERVICE_PORT_HTTPS,
      path: '/api/v1/namespaces/grove-lab-base/configmaps/routes',
      ca: readFileSync(`${directory}/ca.crt`),
      headers: { Authorization: `Bearer ${readFileSync(`${directory}/token`, 'utf8').trim()}` },
    }, response => {
      let body = ''; response.on('data', data => { body += data; });
      response.on('end', () => { if (response.statusCode === 200) routes = JSON.parse(body).data ?? {}; });
    });
    request.on('error', () => {}); request.setTimeout(2000, () => request.destroy()); request.end();
  };
  poll(); setInterval(poll, 250).unref();
}
const server = createServer((req, res) => {
  if (req.url === '/ready') {
    const ready = !existsSync('/tmp/not-ready') && (role !== 'router' || routes !== null);
    res.writeHead(ready ? 200 : 503); res.end(ready ? 'ready' : 'unready'); return;
  }
  if (role === 'router') {
    if (req.url === '/_routes') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(routes)); return; }
    const match = /^web(?:--([a-z0-9-]+))?\.lab\.localhost(?::\d+)?$/.exec(req.headers.host ?? '');
    if (!match) { res.writeHead(400); res.end('Unknown lab host'); return; }
    const env = match[1];
    if (env && !Object.hasOwn(routes ?? {}, env)) { res.writeHead(404); res.end('Environment absent'); return; }
    const service = req.url.startsWith('/api/') ? 'api' : 'web';
    const overrides = env ? JSON.parse(routes[env]) : {};
    const namespace = overrides[service] ?? 'grove-lab-base';
    const upstream = httpRequest({ hostname: `${service}.${namespace}.svc.cluster.local`, port: 8080,
      method: req.method, path: req.url, headers: { ...req.headers, 'x-lab-env': env ?? 'base' },
    }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Upstream unavailable'); });
    upstream.setTimeout(3000, () => upstream.destroy()); req.pipe(upstream); return;
  }
  if (role === 'api') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: feature.api, result: calculate(7), environment, requestEnvironment: req.headers['x-lab-env'], instance: process.env.HOSTNAME }));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><html><body><h1 id="web">${feature.web} @ ${environment}</h1><p id="api">Loading</p><script>fetch('/api/value').then(r=>r.json()).then(v=>document.querySelector('#api').textContent=v.version+' @ '+v.environment).catch(()=>document.querySelector('#api').textContent='Failed')</script></body></html>`);
});
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
