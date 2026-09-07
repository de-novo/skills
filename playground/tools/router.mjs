// router — one listener that serves every name this project has.
//
//   <service>.<project>.<tld>            the baseline instance
//   <service>--<env>.<project>.<tld>     the overlay instance, baseline as
//                                        fallthrough when nothing is attached
//
// The names come from the Grove profile, so this file holds no domain of its
// own. Records are read per request, so an attach or a detach is visible to
// the next request without restarting anything.
import { existsSync, readdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';

import { LOOPBACK, baselineRecord, overlayDir, overlayRecord, readJson, runPath } from './lib/sandbox.mjs';
import { parseHost, readProfile, renderHost } from './lib/profile.mjs';

const UPSTREAM_TIMEOUT_MS = 10_000;
// The one service this project declares shared_only: there is one router, and
// every name it can be asked for resolves to it.
const SELF = 'router';

const profile = readProfile();
const identity = { ok: true, service: SELF, image: null, env: 'baseline', ready: true };

// Overlay first, baseline as fallthrough. Nothing is cached: the answer is
// whatever the run/ area says right now.
export function resolveTarget(name) {
  const parsed = parseHost(name, profile);
  if (parsed == null) return null;
  const { service, env } = parsed;
  if (env != null) {
    const overlay = readJson(overlayRecord(env, service));
    if (overlay?.url) return { ...parsed, role: 'overlay', record: overlay };
  }
  const baseline = readJson(baselineRecord(service));
  if (baseline?.url) return { ...parsed, role: 'baseline', record: baseline };
  return { ...parsed, role: null, record: null };
}

// Every name this router answers, and what is behind it right now. This is
// what a 404 shows, so a wrong name teaches the right one.
function known() {
  const rows = [];
  for (const service of profile.services) {
    const record = readJson(baselineRecord(service));
    const name = renderHost(profile.scheme.shared, profile, { service });
    rows.push(`baseline  ${name}  ${record?.url ? record.image ?? '(this router)' : '(not running)'}`);
  }
  const overlays = runPath('overlays');
  if (!existsSync(overlays)) return rows;
  for (const env of readdirSync(overlays).sort()) {
    const services = path.join(overlayDir(env), 'services');
    if (!existsSync(services)) continue;
    for (const file of readdirSync(services).sort()) {
      if (!file.endsWith('.json')) continue;
      const service = file.slice(0, -'.json'.length);
      const record = readJson(overlayRecord(env, service));
      const name = renderHost(profile.scheme.overlay, profile, { service, env });
      rows.push(`overlay   ${name}  ${record?.image ?? '(no image)'}`);
    }
  }
  return rows;
}

function text(response, status, body) {
  const payload = `${body}\n`;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function proxy(request, response, target) {
  const upstream = new URL(target.record.url);
  const forwarded = httpRequest(
    {
      host: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, 'x-playground-route': target.role },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, {
        ...upstreamResponse.headers,
        'x-playground-route': target.role,
        'x-playground-service': target.service,
        'x-playground-target-env': target.env ?? 'baseline',
      });
      upstreamResponse.pipe(response);
    }
  );
  forwarded.on('timeout', () => forwarded.destroy(new Error(`upstream did not answer within ${UPSTREAM_TIMEOUT_MS}ms`)));
  forwarded.on('error', (error) => text(response, 502, `${target.service} at ${target.record.url} did not answer: ${error.message}`));
  request.pipe(forwarded);
}

const server = createServer((request, response) => {
  const name = request.headers.host;
  const target = resolveTarget(name);
  if (target == null) {
    text(response, 404, [`no name matches ${name}`, '', ...known()].join('\n'));
    return;
  }
  // The router serves its own name too, so `urls` names nothing that does not
  // answer. Its overlay name resolves here as well: shared_only means there is
  // no second copy to fall through to.
  if (target.service === SELF) {
    if (new URL(request.url, `http://${LOOPBACK}`).pathname === '/health') {
      text(response, 200, JSON.stringify(identity));
      return;
    }
    text(response, 200, ['router', '', ...known()].join('\n'));
    return;
  }
  if (target.record == null) {
    text(response, 503, [`nothing serves ${name} yet`, '', ...known()].join('\n'));
    return;
  }
  proxy(request, response, target);
});

server.listen(0, LOOPBACK, () => {
  const { port } = server.address();
  const endpoint = { service: SELF, image: null, env: 'baseline', url: `http://${LOOPBACK}:${port}` };
  process.send?.(endpoint);
  console.log(JSON.stringify(endpoint));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
