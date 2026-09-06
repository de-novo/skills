import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const image = 'process/api@sha256:' + createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const server = createServer((req, res) => {
  if (req.url === '/shutdown' && req.method === 'POST') {
    res.end(); server.close(() => process.exit(0)); return;
  }
  res.writeHead(existsSync(join(root, 'not-ready')) ? 503 : 200, {'content-type': 'application/json'});
  res.end(JSON.stringify({image}));
});
server.listen(0, '127.0.0.1', () => process.send({pid: process.pid, url: 'http://127.0.0.1:' + server.address().port}));
// Bound lifetime even if the parent test is interrupted.
setTimeout(() => server.close(() => process.exit(0)), 60000).unref();
