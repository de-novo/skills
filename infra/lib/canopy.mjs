// Canopy consumes public CLI JSON only. No registry or profile readers belong here.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const TEMPLATE = readFileSync(new URL('./canopy.html', import.meta.url), 'utf8');

export function parseCanopyArgs(args) {
  const options = { port: 7420, once: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--host' || arg.startsWith('--host=')) {
      throw new Error('canopy: --host is refused; the listener binds only to 127.0.0.1.');
    } else if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) > 65535) {
        throw new Error('canopy: --port must be an integer from 0 to 65535 (0 selects an ephemeral port).');
      }
      options.port = Number(value);
    } else throw new Error(`canopy: unknown argument ${JSON.stringify(arg)}.`);
  }
  return options;
}

// Asynchronous, shell-free, and bounded in time and output. A nonzero status
// with a JSON report is useful evidence (for example, a blocked Dryad seat).
export function cliJson(args, { cli = CLI, environment = process.env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let bytes = 0; let settled = false;
    const child = spawn(process.execPath, [cli, ...args], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const stop = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* The child may already have exited. */ }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      stop();
      finish({ error: `${args.join(' ')} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const collect = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        stop();
        finish({ error: `${args.join(' ')} exceeded the output limit` });
      } else if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => collect('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => collect('stderr', chunk));
    child.once('error', error => finish({ error: error.message }));
    child.once('close', code => {
      if (settled) return;
      try {
        const report = JSON.parse(stdout);
        if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('expected an object');
        finish(report);
      } catch {
        finish({ error: `${args.join(' ')} returned invalid JSON (exit ${code})${stderr.trim() ? ': ' + stderr.trim() : ''}` });
      }
    });
  });
}

// The sole discovery call site. Tests can substitute the agreed CLI fixture
// until dryad projects lands; production always uses the public catalog CLI.
export function discoverProjects(options = {}) {
  return cliJson(['dryad', 'projects', '--json'], { ...options, cli: options.projectsCli ?? CLI });
}

export async function collectState(options = {}) {
  const discovery = await discoverProjects(options);
  if (discovery.error || !Array.isArray(discovery.projects)) {
    return { updated_at: new Date().toISOString(), projects: [], error: discovery.error ?? 'dryad projects returned no projects list' };
  }
  const projects = [];
  // Limit process fan-out on machines with many registered projects.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, discovery.projects.length) }, async () => {
    while (next < discovery.projects.length) {
      const index = next++;
      const project = discovery.projects[index];
      try {
        if (!project || typeof project.root !== 'string') throw new Error('project root is missing');
        const [live, archive, grove] = await Promise.all([
          cliJson(['dryad', 'status', '--json', '--project', project.root], options),
          cliJson(['dryad', 'status', '--finished', '--json', '--project', project.root], options),
          project.overlay === true
            ? cliJson(['overlay', 'status', '--json', '--project', project.root], options)
            : Promise.resolve({ inactive: true }),
        ]);
        const problems = [...(live.problems ?? [])];
        for (const [label, report] of [['Dryad', live], ['Finished', archive], ['Grove', grove]]) {
          if (report.error) problems.push(`${label}: ${report.error}`);
        }
        if (grove.project_status?.error) problems.push(`Grove: ${grove.project_status.error}`);
        projects[index] = {
          ...project, counts: live.counts ?? null, seats: live.seats ?? [],
          finished: archive.finished ?? [], grove, problems,
          ...(live.error ? { error: live.error } : {}),
          ...(archive.error ? { finished_error: archive.error } : {}),
        };
      } catch (error) {
        projects[index] = { ...project, error: error.message, seats: [], finished: [], problems: [error.message] };
      }
    }
  }));
  return { updated_at: new Date().toISOString(), projects };
}

// One renderer for the server's first response and the browser's refreshes.
// All CLI text is escaped; only HTTP(S) hostnames become navigable links.
export function renderState(state) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shown = value => value == null ? 'notMeasured' : esc(value);
  const journal = entry => entry ? `${entry.at ?? ''} ${entry.actor ?? ''} ${entry.event ?? ''} ${entry.detail ?? ''}`.trim() : '—';
  const link = hostname => {
    const text = typeof hostname === 'string' ? hostname : hostname.url ?? hostname.hostname ?? '';
    try {
      const url = new URL(text.includes('://') ? text : `http://${text}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return esc(text);
      return `<a href="${esc(url.href)}" rel="noreferrer">${esc(text)}</a>`;
    } catch { return esc(text); }
  };
  const table = (seats, grove, fullJournal = false) => `<div class="table-wrap"><table><thead><tr>${['id', 'branch', '+n', 'env state', 'status', 'by', 'last journal line', 'hostnames', 'session'].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${seats.map(seat => {
    const pending = (grove?.pending ?? []).filter(item => item.env === seat.env).map(item => item.liveness ?? 'unknown');
    const envState = [...new Set([seat.env ?? 'none', seat.env_state, ...pending].filter(Boolean))].join(' ');
    const values = [esc(seat.id), esc(seat.branch), seat.ahead == null ? '—' : `+${esc(seat.ahead)}`, esc(envState), esc(seat.status), esc(seat.by ?? '—'), esc(journal(seat.journal?.at(-1))), (seat.hostnames ?? []).map(link).join('<br>') || '—', esc(seat.session ?? '—')];
    return `<tr>${values.map(value => `<td>${value}</td>`).join('')}</tr>${fullJournal ? `<tr><td colspan="9"><pre>${(seat.journal ?? []).map(entry => esc(journal(entry))).join('\n')}</pre></td></tr>` : ''}`;
  }).join('')}</tbody></table></div>`;
  return `${state.error ? `<p class="problem">${esc(state.error)}</p>` : ''}${state.projects.length === 0 && !state.error ? '<p>No projects registered.</p>' : ''}${state.projects.map(project => {
    const c = project.counts;
    const reported = Object.entries(c?.reported ?? {}).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(', ') || 'none';
    const counts = c ? `seats ${c.seats} · worktrees ${c.worktrees_present}/${c.seats} present · ${project.overlay === true ? `envs ${c.envs_tracked}/${c.envs_wanted} tracked${c.envs_in_flight > 0 ? `, ${c.envs_in_flight} in-flight` : ''}` : 'envs none (overlay inactive)'} · reported ${reported}` : 'counts notMeasured';
    const grove = project.grove;
    const gc = grove?.counts;
    const groveLine = grove?.inactive ? 'overlay inactive' : grove?.error ? esc(grove.error) : `environments ${shown(gc?.environments)} · attachments ${shown(gc?.attachments)} · pending ${shown(gc?.pending)}${(grove?.pending ?? []).map(item => ` · ${esc(item.env)} ${esc(item.verb)} ${esc(item.liveness ?? 'unknown')}`).join('')} · stale ${shown(gc?.stale)} · drift ${shown(gc?.drift)}`;
    return `<section><h2>${esc(project.slug)} — ${esc(counts)}</h2><p class="root">${esc(project.root)}</p>${table(project.seats, grove)}<p class="grove">Grove · ${groveLine}</p>${(project.problems ?? []).map(problem => `<p class="problem">problem · ${esc(problem)}</p>`).join('')}<details data-project="${esc(project.root)}"><summary>finished ${project.finished.length}</summary>${table(project.finished, grove, true)}</details></section>`;
  }).join('')}`;
}

export function renderPage(state) {
  return TEMPLATE.replace('/* CANOPY_RENDERER */', () => renderState.toString())
    .replace('<!-- CANOPY_STATE -->', () => renderState(state))
    .replace('<!-- CANOPY_UPDATED -->', () => state.updated_at);
}

export async function startCanopy({ port = 7420, ...options } = {}) {
  let pending;
  const state = () => pending ??= collectState(options).finally(() => { pending = null; });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end('Read-only: use GET.');
      return;
    }
    if (req.url !== '/' && req.url !== '/api/state') {
      res.writeHead(404).end('Not found.');
      return;
    }
    try {
      const report = await state();
      res.setHeader('Content-Type', req.url === '/' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
      res.end(req.url === '/' ? renderPage(report) : JSON.stringify(report));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

export async function runCanopy(args, options = {}) {
  const parsed = parseCanopyArgs(args);
  if (parsed.help) {
    console.log('usage: de-novo skills canopy [--port N] [--once]\nRead-only local dashboard. Binds 127.0.0.1 only (default port 7420).\n--once prints the state JSON and exits; --host is refused.');
  } else if (parsed.once) {
    console.log(JSON.stringify(await collectState(options), null, 2));
  } else {
    const server = await startCanopy({ ...options, port: parsed.port });
    console.log(`http://127.0.0.1:${server.address().port}/`);
    const close = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    server.once('close', () => {
      process.removeListener('SIGINT', close);
      process.removeListener('SIGTERM', close);
    });
  }
  return 0;
}
