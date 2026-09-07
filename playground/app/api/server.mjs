// api — the playground sample project's JSON service.
//
// It is copied into an image directory named for a git sha and started there,
// so it reads nothing from the checkout it was built from. Every value it
// needs arrives in the environment the adapter sets, and every path in that
// environment is inside the sandbox.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const LOOPBACK = '127.0.0.1';

function required(name) {
  const value = process.env[name];
  if (value == null || value === '') throw new Error(`${name} is required`);
  return value;
}

const service = required('PLAYGROUND_SERVICE');
const image = required('PLAYGROUND_IMAGE');
const environment = required('PLAYGROUND_ENV');
const notesFile = required('PLAYGROUND_NOTES_FILE');
const revision = image.split(':').at(-1);

// /health reaches nothing outside this process: no file, no socket, no other
// service. It answers from this object, which is built before the listener
// exists. That is the property the planting procedure demands of a health
// path — a health check that calls a dependency reports the dependency, not
// the service, and cannot say whether a restart took effect.
const identity = { ok: true, service, image, revision, env: environment, ready: true };

function send(response, status, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-playground-image': image,
    'x-playground-env': environment,
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${LOOPBACK}`);
  if (url.pathname === '/health') {
    send(response, 200, identity);
    return;
  }
  if (url.pathname === '/notes') {
    // The one path that leaves the process: a JSON file inside the sandbox,
    // named by the environment the adapter set.
    try {
      const notes = JSON.parse(await readFile(notesFile, 'utf8'));
      send(response, 200, { ...identity, source: notesFile, notes });
    } catch (error) {
      send(response, 503, { ok: false, service, image, env: environment, source: notesFile, error: error.message });
    }
    return;
  }
  if (url.pathname === '/') {
    send(response, 200, { ...identity, paths: ['/health', '/notes'] });
    return;
  }
  send(response, 404, { ok: false, service, image, env: environment, error: `no such path ${url.pathname}` });
});

// Port 0: the kernel picks, and what it picked is reported back rather than
// agreed in advance. No port constant appears anywhere in this project.
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
