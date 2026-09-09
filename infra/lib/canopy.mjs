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
          ...live, ...project, counts: live.counts ?? null, seats: live.seats ?? [],
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
  // A card is a glance, not a transcript: a long report note is cut here; the
  // whole note stays in the journal and in /api/state.
  const clip = (value, limit = 240) => {
    const text = String(value ?? '');
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  };
  const journal = entry => entry ? `${entry.at ?? ''} ${entry.actor ?? ''} ${entry.event ?? ''} ${entry.detail ?? ''}`.trim() : '—';
  const link = hostname => {
    const text = hostname;
    try {
      const url = new URL(text.includes('://') ? text : `http://${text}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return esc(text);
      return `<a href="${esc(url.href)}" rel="noreferrer">${esc(text)}</a>`;
    } catch { return esc(text); }
  };
  // The only reader of the second-screen status fields. Keep the wire shape
  // here so older producers and the server/browser renderer share one fallback.
  const screen = project => {
    const overlaps = project.overlaps ?? [];
    const adaptSeat = seat => {
      const entries = seat.journal ?? [];
      const verbs = Object.create(null);
      for (const entry of entries) verbs[entry.event] = (verbs[entry.event] ?? 0) + 1;
      const changes = seat.changes;
      const paths = new Map();
      for (const [kind, files] of [['committed', changes?.committed], ['open', changes?.uncommitted]]) {
        for (const file of files ?? []) {
          const row = paths.get(file.path) ?? { path: file.path, labels: [], overlap: overlaps.some(item => item.path === file.path && item.seats.includes(seat.id)) };
          row.labels.push(`${file.status} ${kind}`);
          paths.set(file.path, row);
        }
      }
      return { ...seat, entries, verbs, last: entries.at(-1), report: entries.findLast(entry => entry.event === 'report'),
        hosts: (seat.hostnames ?? []).map(host => typeof host === 'string'
          ? { text: host, attached: true } : { text: host.host ?? host.url ?? host.hostname ?? '', service: host.service, attached: host.attached !== false }),
        files: changes ? { committed: changes.counts?.committed ?? changes.committed?.length ?? 0,
          open: changes.counts?.uncommitted ?? changes.uncommitted?.length ?? 0,
          truncated: changes.truncated, rows: [...paths.values()].sort((a, b) => Number(b.overlap) - Number(a.overlap) || a.path.localeCompare(b.path)) } : null };
    };
    const seats = (project.seats ?? []).map(adaptSeat).sort((a, b) => (Date.parse(b.last?.at) || 0) - (Date.parse(a.last?.at) || 0));
    const worktrees = project.worktrees;
    const unseated = (worktrees ?? []).filter(tree => !tree.seat);
    return { seats, unseated, overlaps, overlapCount: project.overlaps?.length, total: worktrees?.length, finished: (project.finished ?? []).map(adaptSeat) };
  };
  const elapsed = at => {
    const seconds = Math.max(0, Math.floor((Date.parse(state.updated_at) - Date.parse(at)) / 1000));
    if (!Number.isFinite(seconds)) return '';
    return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  };
  const card = (seat, grove, archived = false) => {
    const pending = (grove?.pending ?? []).filter(item => item.env === seat.env).map(item => item.liveness ?? 'unknown');
    const envState = [...new Set([seat.env ?? 'none', seat.env_state, ...pending].filter(Boolean))].join(' ');
    const files = seat.files;
    return `<article class="card ${archived ? 'archived' : 'seat'}" data-seat="${esc(seat.id)}">
      <h3>${esc(seat.id)} · ${esc(seat.by ?? '—')}${seat.last ? ` · <time datetime="${esc(seat.last.at)}" title="${esc(seat.last.at)}">${esc(elapsed(seat.last.at))}</time>` : ''}</h3>
      ${seat.task ? `<p class="task">${esc(seat.task.split(/\r?\n/)[0])}</p>` : ''}
      <p class="status">${esc(seat.status)}${seat.report ? ` · ${esc(clip(seat.report.detail))}` : ''}</p>
      ${seat.activity ? `<p class="doing">now ${esc(seat.activity.doing ?? seat.activity.state ?? '')}${seat.activity.state && seat.activity.doing ? ` · ${esc(seat.activity.state)}` : ''}${seat.activity.changed_at ? ` · ${esc(elapsed(seat.activity.changed_at))}` : ''}</p>` : ''}
      <p>env ${esc(envState)}${seat.hosts.length ? ' → ' + seat.hosts.map(host => `${host.attached ? link(host.text) : `${esc(host.text)} <span class="muted">(unattached)</span>`}${host.service ? ` <span class="muted">${esc(host.service)}</span>` : ''}`).join(' · ') : ''}</p>
      ${seat.entries.length ? `<p class="skills">skills · ${Object.entries(seat.verbs).map(([verb, count]) => `${esc(verb)} ${count}`).join(' · ')}<br><span class="muted">last ${esc(seat.last.event)} · ${esc(seat.last.at)}${seat.last.detail && seat.last.detail !== seat.report?.detail ? ` · ${esc(clip(seat.last.detail))}` : ''}</span></p>` : ''}
      ${files ? `<div class="files"><p>files · +${esc(files.committed)} committed · ${esc(files.open)} open</p><ul>${files.rows.slice(0, 12).map(file => `<li${file.overlap ? ' class="shared"' : ''}>${file.overlap ? '<span title="Overlapping path">⚠</span> ' : ''}${esc(file.path)} <span class="muted">${esc(file.labels.join(' · '))}</span></li>`).join('')}</ul>${files.rows.length > 12 ? `<p class="muted">${files.rows.length - 12} more files</p>` : ''}${files.truncated ? `<p class="muted">Source file list truncated; counts include omitted entries.</p>` : ''}</div>` : ''}
      <p class="meta">${esc(seat.worktree)}<br>${esc(seat.branch)}${seat.ahead == null ? '' : ` · +${esc(seat.ahead)}`}${seat.session ? `<br>session ${esc(seat.session)}` : ''}</p>
      ${archived ? `<pre>${seat.entries.map(entry => esc(journal(entry))).join('\n')}</pre>` : ''}
    </article>`;
  };
  return `${state.error ? `<p class="problem">${esc(state.error)}</p>` : ''}${state.projects.length === 0 && !state.error ? '<p>No projects registered.</p>' : ''}${state.projects.map(project => {
    const view = screen(project);
    const c = project.counts;
    const counts = c ? `seats ${c.seats}${view.total == null ? '' : ` · worktrees ${view.total} (${view.unseated.length} unseated)`} · envs ${c.envs_tracked}/${c.envs_wanted}${view.overlapCount == null ? '' : ` · overlaps ${view.overlapCount}`}` : 'counts notMeasured';
    const grove = project.grove;
    const gc = grove?.counts;
    const groveLine = grove?.inactive ? 'overlay inactive' : grove?.error ? esc(grove.error) : `environments ${shown(gc?.environments)} · attachments ${shown(gc?.attachments)} · pending ${shown(gc?.pending)}${(grove?.pending ?? []).map(item => ` · ${esc(item.env)} ${esc(item.verb)} ${esc(item.liveness ?? 'unknown')}`).join('')} · stale ${shown(gc?.stale)} · drift ${shown(gc?.drift)}`;
    return `<section><h2>${esc(project.slug)} — ${esc(counts)}</h2><p class="grove">Grove · ${groveLine}</p>${(project.problems ?? []).map(problem => `<p class="problem">problem · ${esc(problem)}</p>`).join('')}<p class="root">${esc(project.root)}</p><div class="cards">${view.seats.map(seat => card(seat, grove)).join('')}${view.unseated.map(tree => `<article class="card unseated"><h3>${esc(tree.branch ?? 'detached HEAD')}</h3><p>Not a seat</p><p>${esc(tree.path)}</p><p>HEAD ${esc(tree.head)}</p></article>`).join('')}</div>${view.overlaps.map(item => `<p class="overlap">⚠ overlap · ${esc(item.path)} · ${item.seats.map(esc).join(' · ')}</p>`).join('')}<details data-project="${esc(project.root)}"><summary>finished ${view.finished.length}</summary><div class="cards">${view.finished.map(seat => card(seat, grove, true)).join('')}</div></details></section>`;
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
