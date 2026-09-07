// web — the playground sample project's HTML service.
//
// It renders which revision it is and which api name it reached. Calling the
// api by name, server-side, through the project's router is what makes the
// lesson visible: attach only `web` to an environment and this page still
// shows the baseline api answering, because `api--<env>` falls through.
import { createServer, request as httpRequest } from 'node:http';

const LOOPBACK = '127.0.0.1';
const API_TIMEOUT_MS = 3_000;

function required(name) {
  const value = process.env[name];
  if (value == null || value === '') throw new Error(`${name} is required`);
  return value;
}

const service = required('PLAYGROUND_SERVICE');
const image = required('PLAYGROUND_IMAGE');
const environment = required('PLAYGROUND_ENV');
const revision = image.split(':').at(-1);
// Optional: an instance started before the router exists still serves, and
// says so on the page instead of failing readiness for someone else's outage.
const routerUrl = process.env.PLAYGROUND_ROUTER_URL || null;
const apiHost = process.env.PLAYGROUND_API_HOST || null;

// Same rule as the api: /health reaches nothing outside this process.
const identity = { ok: true, service, image, revision, env: environment, ready: true };

const escape = (value) => String(value).replaceAll(/[&<>"']/g, (character) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));

// The Host header is the address here, so the call is made with node:http and
// the header set explicitly rather than trusting name resolution.
function callApi() {
  return new Promise((resolve) => {
    if (routerUrl == null || apiHost == null) {
      resolve({ ok: false, error: 'no api is configured for this instance' });
      return;
    }
    const target = new URL('/notes', routerUrl);
    const call = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { host: apiHost, accept: 'application/json' },
        timeout: API_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ ok: response.statusCode < 400, route: response.headers['x-playground-route'] ?? null, body: JSON.parse(text) });
          } catch {
            resolve({ ok: false, error: `api answered ${response.statusCode} with ${text.slice(0, 200)}` });
          }
        });
      }
    );
    call.on('timeout', () => call.destroy(new Error(`no answer within ${API_TIMEOUT_MS}ms`)));
    call.on('error', (error) => resolve({ ok: false, error: error.message }));
    call.end();
  });
}

function page(observed) {
  const rows = [
    ['this service', service],
    ['this revision', revision],
    ['this image', image],
    ['this environment', environment],
    ['api reached by name', apiHost ?? '(none)'],
    ['api answered from', observed.body?.env ? `env ${observed.body.env}` : '(no answer)'],
    ['api revision', observed.body?.revision ?? '(no answer)'],
    ['route taken', observed.route ?? '(none)'],
  ];
  const notes = Array.isArray(observed.body?.notes) ? observed.body.notes : [];
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>playground ${escape(service)} — ${escape(revision.slice(0, 12))}</title></head>
<body>
<h1>playground / ${escape(service)}</h1>
<table>
${rows.map(([label, value]) => `<tr><th align="left">${escape(label)}</th><td><code>${escape(value)}</code></td></tr>`).join('\n')}
</table>
<h2>notes from the api</h2>
${observed.ok ? `<ul>${notes.map((note) => `<li>${escape(note.title ?? note)}</li>`).join('')}</ul>` : `<p>api unavailable: <code>${escape(observed.error ?? observed.body?.error ?? 'unknown')}</code></p>`}
</body>
</html>
`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${LOOPBACK}`);
  if (url.pathname === '/health') {
    const payload = `${JSON.stringify(identity, null, 2)}\n`;
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'x-playground-image': image,
      'x-playground-env': environment,
    });
    response.end(payload);
    return;
  }
  if (url.pathname !== '/') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`no such path ${url.pathname}\n`);
    return;
  }
  const observed = await callApi();
  const body = page(observed);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-playground-image': image,
    'x-playground-env': environment,
  });
  response.end(body);
});

// Port 0 here too: the kernel decides and the process reports back.
server.listen(0, LOOPBACK, () => {
  const { port } = server.address();
  const endpoint = { service, image, env: environment, url: `http://${LOOPBACK}:${port}` };
  process.send?.(endpoint);
  console.log(JSON.stringify(endpoint));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
