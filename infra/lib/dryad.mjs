// Dryad — seats on Grove's ground. One worktree per seat, one overlay env
// when the project has overlays, one task. Dryad launches no agent: the
// launcher stays with the human. Grove is used only through its public CLI.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { normalizeClaim, pathsOutsideScope } from './claims.mjs';
import { parseProfile } from './profile.mjs';
import { claudeSettings, seatActivity, seatEventsDirectory, seatEventsPath, seatSettingsPath } from './seat-events.mjs';

export const DRYAD_PROFILE_RELPATH = '.agents/dryad-profile.yml';
const RUNTIME_PROFILE_RELPATH = '.agents/runtime-profile.yml';
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROFILE_VERSION = 1;
const STATE_VERSION = 1;
const STATUS_VALUES = Object.freeze(['planned', 'working', 'blocked', 'done']);
const REPORT_VALUES = Object.freeze(['working', 'blocked', 'done']);
const SEAT_FORMATS = Object.freeze(['json', 'env', 'shell', 'task']);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/cli.mjs');
// The seat carries the path to this skill so a worker can read it without the
// project vendoring or symlinking the catalog.
const SKILL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/dryad/SKILL.md');
const LOCK_WAIT_MS = 2000;
// A seat's `changes` lists at most this many paths each; the counts stay whole.
const CHANGE_LIMIT = 200;

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`dryad: ${message}`);
}

function assertOnlyKeys(value, allowed, field, source) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${source}: ${field} has unknown key ${JSON.stringify(key)}.`);
  }
}

function nonEmptyString(value, field, source) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${source}: ${field} must be a non-empty string.`);
  }
  return value;
}

export function assertSeatId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(`seat id must be a DNS label of at most 63 characters — ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------- profile

export function parseDryadProfile(yamlText, source = 'dryad-profile.yml') {
  const doc = parse(yamlText) ?? {};
  if (!isMap(doc)) fail(`${source}: profile must be a map.`);
  assertOnlyKeys(doc, ['version', 'project', 'worktrees'], 'profile', source);
  if (doc.version != null && doc.version !== PROFILE_VERSION) {
    fail(`${source}: version must be ${PROFILE_VERSION} (got ${JSON.stringify(doc.version)}).`);
  }
  // A project without Grove has no runtime-profile.yml to carry the slug, so
  // the Dryad profile may carry it. With a Grove profile present the slug
  // lives there only; loadDryadProject rejects the duplicate.
  let project = null;
  if (doc.project != null) {
    if (!isMap(doc.project)) fail(`${source}: project must be a map.`);
    assertOnlyKeys(doc.project, ['slug'], 'project', source);
    const slug = nonEmptyString(doc.project.slug, 'project.slug', source);
    if (!ID_PATTERN.test(slug)) fail(`${source}: project.slug must be a DNS label (got ${JSON.stringify(slug)}).`);
    project = { slug };
  }
  let worktrees = null;
  if (doc.worktrees != null) {
    if (!isMap(doc.worktrees)) fail(`${source}: worktrees must be a map.`);
    assertOnlyKeys(doc.worktrees, ['root', 'branch'], 'worktrees', source);
    const root = nonEmptyString(doc.worktrees.root, 'worktrees.root', source);
    const branch = nonEmptyString(doc.worktrees.branch, 'worktrees.branch', source);
    const placeholders = [...branch.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]);
    if (!placeholders.includes('id')) {
      fail(`${source}: worktrees.branch must contain {id} so every seat gets its own branch.`);
    }
    for (const name of placeholders) {
      if (name !== 'id') fail(`${source}: worktrees.branch allows only {id} (got {${name}}).`);
    }
    if (/\s/.test(branch)) fail(`${source}: worktrees.branch must not contain whitespace.`);
    worktrees = { root, branch };
  }
  return { version: PROFILE_VERSION, project, worktrees };
}

function findProfileUpward(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, DRYAD_PROFILE_RELPATH))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveDryadProject({ project = null, environment = process.env, cwd = process.cwd() }) {
  let root;
  if (project != null) {
    root = path.resolve(cwd, project);
  } else if (environment.DRYAD_PROJECT) {
    root = path.resolve(cwd, environment.DRYAD_PROJECT);
  } else {
    root = findProfileUpward(cwd);
    if (root == null) {
      fail(`no ${DRYAD_PROFILE_RELPATH} above ${cwd}; pass --project <baseline> or set DRYAD_PROJECT.`);
    }
  }
  const profilePath = path.join(root, DRYAD_PROFILE_RELPATH);
  if (!existsSync(profilePath)) fail(`dryad profile not found: ${profilePath}`);
  return { root: realpathSync(root), profilePath: realpathSync(profilePath) };
}

export function loadDryadProject(location) {
  const dryad = parseDryadProfile(readFileSync(location.profilePath, 'utf8'), location.profilePath);
  const runtimePath = path.join(location.root, RUNTIME_PROFILE_RELPATH);
  if (!existsSync(runtimePath)) {
    if (dryad.project == null) {
      fail(`${location.profilePath}: no ${RUNTIME_PROFILE_RELPATH} to take project.slug from; declare project.slug here for a project without Grove.`);
    }
    return { root: location.root, dryad, slug: dryad.project.slug, overlayActive: false };
  }
  if (dryad.project != null) {
    fail(`${location.profilePath}: project.slug is declared here and in ${RUNTIME_PROFILE_RELPATH}; keep it only in Grove's profile.`);
  }
  const runtime = parseProfile(readFileSync(runtimePath, 'utf8'), runtimePath);
  return {
    root: location.root,
    dryad,
    slug: runtime.project.slug,
    overlayActive: runtime.overlay?.mode === 'on',
    overlayCreateOn: runtime.overlay?.createOn ?? 'plan',
  };
}

// --------------------------------------------------------------- registry

export function dryadStateDirectory(environment = process.env) {
  // Grove keeps overlays/<slug>.yml; Dryad keeps dryads/<slug>.yml. Under
  // GROVE_STATE_DIR both live below the override so the two files never collide.
  const override = environment.GROVE_STATE_DIR;
  if (override != null) {
    if (override.length === 0) fail('GROVE_STATE_DIR must not be empty.');
    return path.join(path.resolve(override), 'dryads');
  }
  return path.join(homedir(), '.dev-infra', 'dryads');
}

export function dryadStatePath(slug, environment = process.env) {
  return path.join(dryadStateDirectory(environment), `${slug}.yml`);
}

function blankState(slug) {
  return { version: STATE_VERSION, project: slug, seats: {} };
}

export function dryadFinishedPath(slug, environment = process.env) {
  return path.join(dryadStateDirectory(environment), `${slug}.finished.yml`);
}

export function readDryadFinished(slug, environment = process.env) {
  const file = dryadFinishedPath(slug, environment);
  if (!existsSync(file)) return { file, seats: [] };
  const doc = parse(readFileSync(file, 'utf8'));
  if (!isMap(doc) || doc.version !== STATE_VERSION || doc.project !== slug || !Array.isArray(doc.seats)) {
    fail(`${file}: finished archive must have version ${STATE_VERSION}, project ${JSON.stringify(slug)}, and a seats list.`);
  }
  return { file, seats: doc.seats };
}

// finish drops the seat from the live registry; the record and its journal
// are appended here so a later audit can still read what happened.
function archiveFinishedSeat(slug, environment, id, seat) {
  const { file, seats } = readDryadFinished(slug, environment);
  seats.push({ id, finished_at: now(), ...seat });
  atomicWriteFile(file, stringify({ version: STATE_VERSION, project: slug, seats }));
}

// ---------------------------------------------------------- project index

// One machine-local file next to the registries so a tool can find every
// project that has seated a worker without scanning the disk. plan --apply
// records the baseline root under the slug; finish leaves it alone.
export function dryadProjectsIndexPath(environment = process.env) {
  return path.join(dryadStateDirectory(environment), 'projects.yml');
}

function blankProjectsIndex() {
  return { version: STATE_VERSION, projects: {} };
}

export function readDryadProjectsIndex(environment = process.env) {
  const file = dryadProjectsIndexPath(environment);
  if (!existsSync(file)) return { file, index: blankProjectsIndex() };
  let doc;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file}: cannot read project index: ${error.message}`);
  }
  if (!isMap(doc) || doc.version !== STATE_VERSION || !isMap(doc.projects)) {
    fail(`${file}: project index must have version ${STATE_VERSION} and a projects map.`);
  }
  for (const [slug, entry] of Object.entries(doc.projects)) {
    if (!ID_PATTERN.test(slug)) fail(`${file}: project ${JSON.stringify(slug)} is not a DNS label.`);
    if (!isMap(entry) || typeof entry.root !== 'string' || !path.isAbsolute(entry.root) || typeof entry.updated_at !== 'string') {
      fail(`${file}: project ${slug} must have an absolute root and updated_at.`);
    }
    if (entry.repository != null && typeof entry.repository !== 'string') fail(`${file}: project ${slug}.repository must be a string.`);
  }
  return { file, index: doc };
}

// Returns the root the slug pointed at before, or null when unchanged or new.
function recordProjectRoot(slug, root, repository, environment) {
  const file = dryadProjectsIndexPath(environment);
  const release = acquireStateLock(file, LOCK_WAIT_MS);
  try {
    const { index } = readDryadProjectsIndex(environment);
    const previous = index.projects[slug]?.root ?? null;
    index.projects[slug] = { root, repository, updated_at: now() };
    atomicWriteFile(file, stringify(index));
    return previous != null && previous !== root ? previous : null;
  } finally {
    release();
  }
}

function validateState(state, slug, file) {
  if (!isMap(state) || state.version !== STATE_VERSION || state.project !== slug) {
    fail(`${file}: registry must have version ${STATE_VERSION} and project ${JSON.stringify(slug)}.`);
  }
  if (!isMap(state.seats)) fail(`${file}: seats must be a map.`);
  if (state.repository != null && typeof state.repository !== 'string') fail(`${file}: repository must be a string.`);
  for (const [id, seat] of Object.entries(state.seats)) {
    assertSeatId(id);
    if (!isMap(seat)) fail(`${file}: seat ${id} must be a map.`);
    for (const field of ['worktree', 'branch', 'base', 'task', 'created_at', 'status']) {
      if (typeof seat[field] !== 'string') fail(`${file}: seat ${id}.${field} must be a string.`);
    }
    if (typeof seat.owned !== 'boolean') fail(`${file}: seat ${id}.owned must be a boolean.`);
    if (seat.env != null && typeof seat.env !== 'string') fail(`${file}: seat ${id}.env must be a string or null.`);
    if (!STATUS_VALUES.includes(seat.status)) fail(`${file}: seat ${id}.status must be one of ${STATUS_VALUES.join('|')}.`);
    if (!Array.isArray(seat.journal)) fail(`${file}: seat ${id}.journal must be a list.`);
    // Fields a seat planned before 2026-09-10 does not carry. Absent means
    // unknown, and every reader says so rather than guessing.
    if (seat.scope != null && !Array.isArray(seat.scope)) fail(`${file}: seat ${id}.scope must be a list or null.`);
    if (seat.revision != null && typeof seat.revision !== 'string') fail(`${file}: seat ${id}.revision must be a string or null.`);
    if (seat.inputs != null && !isMap(seat.inputs)) fail(`${file}: seat ${id}.inputs must be a map or null.`);
    if (seat.result != null && !isMap(seat.result)) fail(`${file}: seat ${id}.result must be a map or null.`);
    if (seat.integration != null && !isMap(seat.integration)) fail(`${file}: seat ${id}.integration must be a map or null.`);
    if (seat.attempt != null && (!Number.isInteger(seat.attempt) || seat.attempt < 1)) fail(`${file}: seat ${id}.attempt must be a positive integer.`);
  }
  return state;
}

export function readDryadState(slug, environment = process.env) {
  const file = dryadStatePath(slug, environment);
  if (!existsSync(file)) return { file, state: blankState(slug) };
  let state;
  try {
    state = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file}: cannot read registry: ${error.message}`);
  }
  return { file, state: validateState(state, slug, file) };
}

function atomicWriteFile(file, text) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function atomicWriteState(file, state) {
  if (Object.keys(state.seats).length === 0) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  atomicWriteFile(file, stringify(state));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Short read/merge/write critical section only. No git or Grove call runs
// while this lock is held. Exported for Mycelium, whose log sits under the
// same state root and needs the same rule around commit.
export function acquireStateLock(file, waitMs) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const descriptor = openSync(lock, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: hostname() }));
      return () => {
        closeSync(descriptor);
        if (existsSync(lock)) unlinkSync(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lock, 'utf8'));
      } catch {
        // Unreadable lock: not safe to steal.
      }
      if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0 && !processIsAlive(owner.pid)) {
        try {
          unlinkSync(lock);
        } catch {
          // Another reclaimer got there first.
        }
        continue;
      }
      if (Date.now() < deadline) {
        sleepSync(10);
        continue;
      }
      const detail = owner ? `pid ${owner.pid ?? '?'} on ${owner.host ?? '?'}` : 'unknown owner';
      fail(`registry is locked by ${detail}; retry after that command finishes.`);
    }
  }
}

function updateState(slug, environment, operation) {
  const file = dryadStatePath(slug, environment);
  const release = acquireStateLock(file, LOCK_WAIT_MS);
  try {
    const { state } = readDryadState(slug, environment);
    const result = operation(state);
    atomicWriteState(file, state);
    return result;
  } finally {
    release();
  }
}

function now() {
  return new Date().toISOString();
}

function journal(seat, actor, event, detail) {
  seat.journal.push({ at: now(), actor, event, detail });
}

// -------------------------------------------------------------------- git

function git(args, cwd) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

function gitOk(args, cwd) {
  const result = git(args, cwd);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitCommonDir(cwd) {
  return realpathSync(path.resolve(cwd, gitOk(['rev-parse', '--git-common-dir'], cwd)));
}

function gitHead(cwd) {
  return gitOk(['rev-parse', 'HEAD'], cwd);
}

function gitBranch(cwd) {
  const result = git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
  return result.status === 0 ? result.stdout.trim() : 'HEAD';
}

function gitIsClean(cwd) {
  return gitOk(['status', '--porcelain'], cwd).length === 0;
}

function gitAhead(base, cwd) {
  const result = git(['rev-list', '--count', `${base}..HEAD`], cwd);
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function gitBranchExists(branch, cwd) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd).status === 0;
}

// What makes this repository this repository across moves and clones: its
// first root commit. Two checkouts of one history share it; a different
// project that borrowed the same slug does not.
function gitRepositoryId(cwd) {
  const roots = gitOk(['rev-list', '--max-parents=0', 'HEAD'], cwd).split('\n').filter(Boolean).sort();
  if (roots.length === 0) fail(`no commits in ${cwd}; a seat needs a base commit.`);
  return roots[0];
}

// A full commit sha for a ref, or null when the repository has no such commit.
function gitResolveCommit(ref, cwd) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Two checkouts of one repository can spell the same directory differently
// (a symlinked temp root, /var vs /private/var). Compare what the disk says.
function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// -z output keeps paths raw; the default format quotes and escapes them.
function splitNulRecords(text) {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function committedChanges(base, cwd) {
  const result = git(['diff', '--name-status', '-z', `${base}..HEAD`], cwd);
  if (result.status !== 0) return null;
  const fields = splitNulRecords(result.stdout);
  const rows = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    // A rename or copy carries source then destination; the destination is
    // the path this seat holds now, and the source is a path it touched.
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const target = fields[index + paths];
    if (target == null) break;
    rows.push(paths === 2 ? { path: target, status, from: fields[index + 1] } : { path: target, status });
    index += paths + 1;
  }
  return rows;
}

function uncommittedChanges(cwd) {
  const result = git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (result.status !== 0) return null;
  const fields = splitNulRecords(result.stdout);
  const rows = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const code = field.slice(0, 2);
    const row = { path: field.slice(3), status: code.trim() };
    // A rename or copy is followed by its original path in its own record.
    if (/[RC]/.test(code)) {
      index += 1;
      row.from = fields[index];
    }
    rows.push(row);
  }
  return rows;
}

// Every path the seat touched since its base, whole: destinations, rename
// sources, deletions, and untracked files. This is what a scope is checked
// against, so it is never truncated.
function seatTouchedPaths(seat) {
  const committed = committedChanges(seat.base, seat.worktree);
  const uncommitted = uncommittedChanges(seat.worktree);
  if (committed == null || uncommitted == null) return null;
  const paths = new Set();
  for (const row of [...committed, ...uncommitted]) {
    paths.add(row.path);
    if (row.from != null) paths.add(row.from);
  }
  return [...paths].sort();
}

// git already knows what a seat changed; Dryad adds no tracking of its own.
// Returns the public `changes` object plus the full path set overlaps read,
// which is not truncated.
function seatChanges(seat) {
  if (!existsSync(seat.worktree)) return { changes: null, paths: [] };
  const committed = committedChanges(seat.base, seat.worktree);
  const uncommitted = uncommittedChanges(seat.worktree);
  if (committed == null || uncommitted == null) return { changes: null, paths: [] };
  return {
    changes: {
      base: seat.base,
      committed: committed.slice(0, CHANGE_LIMIT),
      uncommitted: uncommitted.slice(0, CHANGE_LIMIT),
      counts: {
        committed: committed.length,
        uncommitted: uncommitted.length,
        ahead: gitAhead(seat.base, seat.worktree),
      },
      truncated: committed.length > CHANGE_LIMIT || uncommitted.length > CHANGE_LIMIT,
    },
    paths: [...new Set([...committed, ...uncommitted].map((row) => row.path))],
  };
}

// Every worktree of the baseline repository, seated or not. A worktree with
// `seat: null` means somebody works in parallel and Dryad does not know it.
function repositoryWorktrees(project, state) {
  const result = git(['worktree', 'list', '--porcelain'], project.root);
  if (result.status !== 0) return [];
  const seatByPath = new Map(
    Object.entries(state.seats).map(([id, seat]) => [canonicalPath(seat.worktree), id])
  );
  const baseline = canonicalPath(project.root);
  const rows = [];
  let current = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, head: null, seat: null, baseline: false };
      rows.push(current);
    } else if (current == null) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  for (const row of rows) {
    const key = canonicalPath(row.path);
    row.seat = seatByPath.get(key) ?? null;
    row.baseline = key === baseline;
  }
  return rows;
}

// A fact, not a problem: two seats hold the same path. Who merges first is a
// person's call, so this never reaches the exit code.
function seatOverlaps(rows) {
  const holders = new Map();
  for (const row of rows) {
    for (const file of row.paths) {
      if (!holders.has(file)) holders.set(file, []);
      holders.get(file).push(row.id);
    }
  }
  return [...holders.entries()]
    .filter(([, seats]) => seats.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, seats]) => ({ path: file, seats }));
}

// ------------------------------------------------------------------ grove

function grove(args, project, environment) {
  return spawnSync(process.execPath, [CLI_PATH, 'overlay', ...args, '--project', project.root], {
    cwd: project.root,
    env: environment,
    encoding: 'utf8',
  });
}

// Seat hostnames come from Grove's `urls --json`; Dryad never renders a
// hostname itself. Returns { hostnames, error }.
function probeHostnames(project, env, environment) {
  const result = spawnSync(process.execPath, [CLI_PATH, 'urls', project.root, '--env', env, '--json'], {
    cwd: project.root,
    env: environment,
    encoding: 'utf8',
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { hostnames: [], error: `urls --env ${env} returned no JSON (exit ${result.status}): ${lastLine(result.stderr) || lastLine(result.stdout)}` };
  }
  if (result.status !== 0 || !Array.isArray(report.overlay)) {
    return { hostnames: [], error: `urls --env ${env} exited ${result.status}: ${lastLine(result.stderr)}` };
  }
  return { hostnames: report.overlay.map((row) => ({ host: row.host, service: row.service })), error: null };
}

function lastLine(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length === 0 ? '' : lines[lines.length - 1];
}

function relayFailure(label, result) {
  if (result.stdout.trim()) console.error(result.stdout.trimEnd());
  if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  console.error(`dryad: ${label} exited ${result.status}.`);
}

// Reads Grove's machine-readable report. Dryad does not open Grove's
// registry; `overlay status --json` is the seam and the contract owns it.
function probeOverlay(project, environment) {
  const result = grove(['status', '--json'], project, environment);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`overlay status --json returned no JSON (exit ${result.status}): ${lastLine(result.stderr) || lastLine(result.stdout)}`);
  }
  return {
    ok: result.status === 0 && report.ok === true,
    envs: new Set(report.environments.map((entry) => entry.env)),
    // Which services each env actually has attached. A hostname exists for
    // every service of the project; only these answer.
    attached: new Map(
      report.environments.map((entry) => [
        entry.env,
        new Set((entry.services ?? []).map((service) => service.service)),
      ])
    ),
    pending: report.pending.map((item) => ({
      target: `${item.verb} ${item.env}${item.service ? `/${item.service}` : ''}`,
      env: item.env,
      state: item.liveness,
    })),
    drift: (report.drift ?? []).map((item) => ({
      env: item.env,
      text: `${item.env}${item.service ? `/${item.service}` : ''}: ${item.message}`,
    })),
    stale: report.counts.stale,
    projectStatusOk: report.project_status.ok,
    driftNotMeasured: report.drift == null,
    result,
  };
}

// Grove returns non-zero for any pending journal. An in-flight one is another
// seat's work in progress, not a problem for the person counting seats; drift
// on that same environment is the mutation mid-way. Everything else stands.
function overlayProblems(probe) {
  if (probe.ok) return [];
  const problems = [];
  const busy = new Set(probe.pending.filter((item) => item.state === 'in-flight').map((item) => item.env));
  if (!probe.projectStatusOk) problems.push('overlay project status failed');
  if (probe.driftNotMeasured) problems.push('overlay drift notMeasured');
  if (probe.stale > 0) problems.push(`overlay stale envs ${probe.stale}`);
  for (const item of probe.pending) {
    if (item.state !== 'in-flight') problems.push(`overlay pending ${item.state}: ${item.target}; rerun it with --apply`);
  }
  for (const item of probe.drift) if (!busy.has(item.env)) problems.push(`overlay drift: ${item.text}`);
  if (problems.length === 0 && busy.size === 0) problems.push('overlay status returned non-zero');
  return problems;
}

// --------------------------------------------------------------- cli args

const VERBS = Object.freeze({
  plan: { positionals: [1, 1], options: ['task', 'task-file', 'worktree', 'by', 'revision', 'project'], multi: ['owns', 'input'], flags: ['apply', 'read-only', 'resume'] },
  seat: { positionals: [1, 1], options: ['project'], flags: ['json', 'env', 'shell', 'task'] },
  report: { positionals: [1, 1], options: ['status', 'note', 'session', 'evidence', 'project'], flags: ['accept-outside-scope'] },
  integrate: { positionals: [1, 1], options: ['commit', 'by', 'note', 'project'], flags: ['apply'] },
  status: { positionals: [0, 1], options: ['project'], flags: ['json', 'finished'] },
  diff: { positionals: [1, 1], options: ['project'], flags: ['json'] },
  finish: { positionals: [1, 1], options: ['project'], flags: ['apply'] },
  rebind: { positionals: [0, 0], options: ['project'], flags: ['apply'] },
  projects: { positionals: [0, 0], options: [], flags: ['json'] },
});

function takeOption(args, index, name) {
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) fail(`--${name} requires a value.`);
  return value;
}

export function parseDryadCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!(verb in VERBS)) fail(`unknown command ${JSON.stringify(verb)}.`);
  const spec = VERBS[verb];
  const options = { help: false, verb, id: null, project: null };
  for (const name of spec.options) options[camel(name)] = null;
  for (const name of spec.multi ?? []) options[camel(name)] = [];
  for (const name of spec.flags) options[camel(name)] = false;
  const positionals = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (spec.flags.includes(name)) {
        if (options[camel(name)]) fail(`--${name} may be passed only once.`);
        options[camel(name)] = true;
        continue;
      }
      if (spec.options.includes(name)) {
        if (options[camel(name)] != null) fail(`--${name} may be passed only once.`);
        options[camel(name)] = takeOption(input, index, name);
        index += 1;
        continue;
      }
      if ((spec.multi ?? []).includes(name)) {
        options[camel(name)].push(takeOption(input, index, name));
        index += 1;
        continue;
      }
      fail(`--${name} is not valid for ${verb}.`);
    }
    positionals.push(arg);
  }
  const [minimum, maximum] = spec.positionals;
  if (positionals.length > maximum) {
    fail(maximum === 0 ? `${verb} takes no positional arguments.` : `${verb} takes at most ${maximum} positional argument${maximum === 1 ? '' : 's'}.`);
  }
  if (positionals.length < minimum) fail(`${verb} requires a seat id.`);
  options.id = positionals[0] == null ? null : assertSeatId(positionals[0]);

  if (verb === 'plan') {
    if ((options.task == null) === (options.taskFile == null)) fail('plan requires exactly one of --task or --task-file.');
    if (options.readOnly && options.owns.length > 0) fail('--read-only and --owns exclude each other: a read-only seat claims no path.');
    if (options.resume && options.worktree != null) fail('--resume continues a Dryad-created branch; it cannot adopt --worktree.');
    options.owns = options.owns.map((claim, index) => normalizeClaim(claim, `--owns[${index}]`));
    const inputs = {};
    for (const entry of options.input) {
      const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)=([0-9a-f]{40})$/.exec(entry);
      if (match == null) fail(`--input must be <seat id>=<full commit sha> (got ${JSON.stringify(entry)}).`);
      inputs[match[1]] = match[2];
    }
    options.inputs = inputs;
  }
  if (verb === 'integrate') {
    if (options.commit == null) fail('integrate requires --commit <sha>.');
  }
  if (verb === 'seat') {
    const chosen = SEAT_FORMATS.filter((name) => options[name]);
    if (chosen.length > 1) fail('seat takes at most one of --json, --env, --shell, --task.');
    options.format = chosen[0] ?? 'text';
  }
  if (verb === 'report') {
    if (options.status == null) fail('report requires --status.');
    if (!REPORT_VALUES.includes(options.status)) fail(`--status must be one of ${REPORT_VALUES.join('|')}.`);
  }
  return options;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

// ----------------------------------------------------------- cli journal

// Which catalog verbs change something. Read-only verbs are left out on
// purpose: a dashboard polling `status` must not bury the journal it reads.
const CLI_JOURNAL_OVERLAY_VERBS = Object.freeze(['create', 'attach', 'detach', 'destroy', 'touch', 'prune']);

// The journal line for a command as typed, or null when the verb is read-only.
export function cliJournalDetail(args) {
  const [command, ...rest] = args ?? [];
  if (command == null) return null;
  const separator = rest.indexOf('--');
  const head = separator === -1 ? rest : rest.slice(0, separator);
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);
  let recorded = false;
  if (command === 'overlay') {
    recorded = CLI_JOURNAL_OVERLAY_VERBS.includes(head[0]) && head.includes('--apply');
  } else if (command === 'setup') {
    recorded = true;
  } else if (command === 'infra') {
    recorded = head[0] === 'up' || head[0] === 'provision';
  } else if (command === 'up' || command === 'provision') {
    recorded = true;
  }
  if (!recorded) return null;
  // Passthrough belongs to the project's own command and may carry values
  // Grove never sees; the overlay contract keeps a digest of it, not the text.
  const digest =
    passthrough.length === 0
      ? []
      : ['--', `sha256:${createHash('sha256').update(JSON.stringify(passthrough)).digest('hex')}`];
  return [command, ...head, ...digest].join(' ');
}

// The seat records what it tried, with the exit code, so a failed attach is
// in the journal too. This observes a command; it must never fail one. A
// finished seat, an unresolvable project, or a locked registry records
// nothing and says so only through the return value.
export function recordSeatCliEvent(args, exit, environment = process.env, cwd = process.cwd()) {
  try {
    const id = environment.DRYAD_ID;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
    const detail = cliJournalDetail(args);
    if (detail == null) return false;
    const project = loadDryadProject(resolveDryadProject({ environment, cwd }));
    return updateState(project.slug, environment, (state) => {
      const seat = state.seats[id];
      if (seat == null) return false;
      seat.journal.push({ at: now(), actor: 'seat', event: 'cli', detail, exit });
      return true;
    });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ verbs

function seatOf(state, id) {
  const seat = state.seats[id];
  if (seat == null) fail(`seat ${id} is not registered for ${state.project}.`);
  return seat;
}

function readTask(options, cwd) {
  if (options.task != null) return options.task;
  const file = path.resolve(cwd, options.taskFile);
  if (!existsSync(file)) fail(`--task-file not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  if (text.trim().length === 0) fail(`--task-file is empty: ${file}`);
  return text;
}

// The attempts already made at this seat id, oldest first, from the
// finished archive. Attempt n+1 starts after n finished seats.
function previousAttempts(finished, id) {
  return finished.seats.filter((record) => record.id === id);
}

function resolveWorktreePlan(options, project, cwd, existing, finished) {
  const previous = previousAttempts(finished, options.id);
  const attempt = previous.length + 1;
  if (options.worktree != null) {
    const target = path.resolve(cwd, options.worktree);
    if (!existsSync(target) || !statSync(target).isDirectory()) fail(`--worktree is not a directory: ${target}`);
    const real = realpathSync(target);
    if (real === project.root) fail('--worktree must not be the baseline checkout itself.');
    if (gitCommonDir(real) !== gitCommonDir(project.root)) {
      fail(`--worktree belongs to a different repository: ${real}`);
    }
    return { path: real, owned: false, branch: gitBranch(real), base: gitHead(real), exists: true, attempt, resumedFrom: null };
  }
  if (project.dryad.worktrees == null) {
    fail('dryad-profile.yml has no worktrees section; pass --worktree <existing-path> to adopt one.');
  }
  const { root, branch } = project.dryad.worktrees;
  const target = path.resolve(project.root, root, options.id);
  if (isInside(target, project.root)) {
    fail(`worktrees.root resolves inside the baseline checkout: ${target}`);
  }
  if (existing != null) {
    return { path: existing.worktree, owned: true, branch: existing.branch, base: existing.base, exists: existsSync(existing.worktree), attempt: existing.attempt ?? attempt, resumedFrom: existing.resumed_from ?? null };
  }
  const exists = existsSync(target);
  const last = previous.at(-1) ?? null;
  if (options.resume) {
    // Continue the previous attempt on its own branch: same base, so diff
    // and scope still cover the whole of the work.
    if (last == null) fail(`--resume: no finished attempt of ${options.id} to continue.`);
    if (last.owned === false) fail(`--resume: attempt ${previous.length} adopted ${last.worktree}; plan it again with --worktree.`);
    if (!gitBranchExists(last.branch, project.root)) fail(`--resume: branch ${last.branch} of attempt ${previous.length} is gone.`);
    return { path: target, owned: true, branch: last.branch, base: last.base, exists, attempt, resumedFrom: last.attempt ?? previous.length, create: ['worktree', 'add', target, last.branch] };
  }
  // Every attempt gets a branch of its own; the branches of earlier attempts
  // are kept, as finish promised. A branch that already exists is never
  // reused or overwritten: it is somebody's work.
  const seatBranch = attempt === 1 ? branch.replaceAll('{id}', options.id) : `${branch.replaceAll('{id}', options.id)}-${attempt}`;
  if (!exists && gitBranchExists(seatBranch, project.root)) {
    fail(`branch ${seatBranch} already exists in ${project.root}; Dryad never overwrites a branch. Move it aside yourself, or pass --resume to continue attempt ${previous.length} on its own branch.`);
  }
  return { path: target, owned: true, branch: seatBranch, base: gitHead(project.root), exists, attempt, resumedFrom: null, create: ['worktree', 'add', '--no-track', '-b', seatBranch, target, 'HEAD'] };
}

// The slug is bound to one repository on this machine. A second repository
// that borrowed the same slug must not quietly join the first one's registry
// and archive; it is refused by name until a person rebinds.
function assertRepositoryBinding(project, environment, repository) {
  const { index } = readDryadProjectsIndex(environment);
  const entry = index.projects[project.slug] ?? null;
  const { state } = readDryadState(project.slug, environment);
  const bound = state.repository ?? entry?.repository ?? null;
  if (bound != null && bound !== repository) {
    fail(`project ${project.slug} is bound to repository ${bound.slice(0, 12)} (${entry?.root ?? 'root unknown'}); this checkout is repository ${repository.slice(0, 12)} (${project.root}). Give this project its own slug, or run dryad rebind --apply from here after its live seats are finished.`);
  }
  return bound;
}

function runPlan({ options, project, environment, cwd }) {
  const { state } = readDryadState(project.slug, environment);
  const finished = readDryadFinished(project.slug, environment);
  const existing = state.seats[options.id] ?? null;
  if (existing != null && existing.env !== 'pending') {
    fail(`seat ${options.id} already exists; finish it before planning it again.`);
  }
  const task = readTask(options, cwd);
  const repository = gitRepositoryId(project.root);
  assertRepositoryBinding(project, environment, repository);
  const plan = resolveWorktreePlan(options, project, cwd, existing, finished);
  const envWanted = project.overlayActive ? options.id : null;
  const scope = options.readOnly ? [] : options.owns.length > 0 ? options.owns : null;
  const attemptLine = plan.resumedFrom != null
    ? `resumes attempt ${plan.resumedFrom} on ${plan.branch} as attempt ${plan.attempt}`
    : `${plan.attempt}${plan.attempt > 1 ? ` (earlier branches kept)` : ''}`;

  if (!options.apply) {
    console.log(
      [
        `■ ${project.slug} — seat ${options.id} (plan)`,
        `  worktree  ${plan.path} (${plan.owned ? (plan.exists ? 'exists' : 'would create') : 'adopt'})`,
        `  branch    ${plan.branch}`,
        `  base      ${plan.base.slice(0, 12)}`,
        `  attempt   ${attemptLine}`,
        `  scope     ${scope == null ? 'unchecked' : scope.length === 0 ? 'read-only' : scope.join(' ')}`,
        `  env       ${envWanted ?? 'none'}${existing?.env === 'pending' ? ' (pending, would retry)' : ''}`,
        `  task      ${task.split('\n')[0].slice(0, 72)}`,
        '  apply     nothing created; rerun with --apply',
      ].join('\n')
    );
    return 0;
  }

  const journalLines = [];
  let created = false;
  if (plan.owned) {
    if (plan.exists) {
      const real = realpathSync(plan.path);
      if (gitCommonDir(real) !== gitCommonDir(project.root) || gitBranch(real) !== plan.branch) {
        fail(`${plan.path} exists but is not a worktree of this repository on ${plan.branch}.`);
      }
      journalLines.push(`worktree present on ${plan.branch}`);
    } else {
      gitOk(plan.create, project.root);
      created = true;
      journalLines.push(plan.resumedFrom != null
        ? `worktree add ${plan.branch} resuming attempt ${plan.resumedFrom} at ${gitHead(plan.path).slice(0, 12)} (base ${plan.base.slice(0, 12)})`
        : `worktree add ${plan.branch} at ${plan.base.slice(0, 12)} (attempt ${plan.attempt})`);
    }
  } else {
    journalLines.push(`adopt ${plan.path} on ${plan.branch}`);
  }

  let env = envWanted;
  let envFailure = null;
  if (envWanted != null && project.overlayCreateOn === 'attach') {
    journalLines.push(`overlay env ${envWanted} will be created by the seat's first attach (create_on: attach)`);
  } else if (envWanted != null) {
    const result = grove(['create', envWanted, '--apply'], project, environment);
    if (result.status === 0) {
      journalLines.push(`overlay.create ok ${lastLine(result.stdout)}`);
    } else {
      env = 'pending';
      envFailure = result;
      journalLines.push(`overlay.create failed exit ${result.status}: ${lastLine(result.stderr) || lastLine(result.stdout)}`);
    }
  }

  const seat = updateState(project.slug, environment, (current) => {
    const record = current.seats[options.id] ?? {
      worktree: plan.path,
      owned: plan.owned,
      branch: plan.branch,
      base: plan.base,
      attempt: plan.attempt,
      resumed_from: plan.resumedFrom,
      task,
      scope,
      revision: options.revision ?? null,
      inputs: Object.keys(options.inputs).length === 0 ? null : options.inputs,
      env: null,
      by: options.by ?? null,
      session: null,
      created_at: now(),
      status: 'planned',
      result: null,
      integration: null,
      journal: [],
    };
    record.env = env;
    if (options.by != null) record.by = options.by;
    journal(record, 'dryad', existing == null ? 'plan' : 'plan.retry', journalLines.join('; '));
    current.seats[options.id] = record;
    current.repository = repository;
    return record;
  });
  prepareSeatEvents(project.slug, options.id, environment);

  const movedFrom = recordProjectRoot(project.slug, project.root, repository, environment);
  if (movedFrom != null) {
    console.error(`dryad: project index: ${project.slug} root moved from ${movedFrom} to ${project.root}; index keeps the latest.`);
  }

  console.log(
    [
      `■ ${project.slug} — seat ${options.id}`,
      `  worktree  1/1 ${seat.worktree} (${seat.owned ? (created ? 'created' : 'present') : 'adopted'})`,
      `  branch    ${seat.branch}`,
      `  base      ${seat.base.slice(0, 12)}`,
      `  attempt   ${attemptLine}`,
      `  scope     ${scope == null ? 'unchecked' : scope.length === 0 ? 'read-only' : scope.join(' ')}`,
      `  env       ${env == null ? 'none' : env === 'pending' ? '0/1 pending' : '1/1 ' + env}`,
      `  journal   ${seat.journal.length}`,
    ].join('\n')
  );
  if (envFailure != null) {
    relayFailure('overlay create', envFailure);
    console.error(`dryad: seat ${options.id} kept with env pending; rerun the same plan --apply to retry.`);
    return 1;
  }
  return 0;
}

// The seat's environment for whatever launches the worker. DRYAD_EVENTS is
// the file the tool's hooks append to, so the seat's state and what it is
// doing can be read by anyone (dryad status, Canopy, Understory) whoever
// launched it; DRYAD_CLAUDE_SETTINGS is the hooks file a Claude Code
// launcher passes as --settings.
export function seatEnvironment(seat, id, project, environment = process.env) {
  return {
    DRYAD_ID: id,
    DRYAD_ENV: seat.env == null || seat.env === 'pending' ? '' : seat.env,
    DRYAD_BRANCH: seat.branch,
    DRYAD_PROJECT: project.root,
    DRYAD_SKILL: SKILL_PATH,
    DRYAD_EVENTS: seatEventsPath(project.slug, id, environment),
    DRYAD_CLAUDE_SETTINGS: seatSettingsPath(project.slug, id, environment),
  };
}

// plan --apply lays the events file and the Claude settings beside the
// registry; finish removes them with the seat.
export function prepareSeatEvents(slug, id, environment = process.env) {
  mkdirSync(seatEventsDirectory(slug, environment), { recursive: true, mode: 0o700 });
  const events = seatEventsPath(slug, id, environment);
  writeFileSync(events, '');
  writeFileSync(seatSettingsPath(slug, id, environment), JSON.stringify(claudeSettings(events), null, 2));
  return events;
}

export function removeSeatEvents(slug, id, environment = process.env) {
  for (const file of [seatEventsPath(slug, id, environment), seatSettingsPath(slug, id, environment)]) {
    try { unlinkSync(file); } catch {}
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runSeat({ options, project, environment }) {
  const { state } = readDryadState(project.slug, environment);
  const seat = seatOf(state, options.id);
  const present = existsSync(seat.worktree);
  const envVars = seatEnvironment(seat, options.id, project, environment);
  switch (options.format) {
    case 'json':
      console.log(
        JSON.stringify(
          {
            id: options.id,
            project: project.root,
            worktree: seat.worktree,
            worktree_present: present,
            owned: seat.owned,
            branch: seat.branch,
            base: seat.base,
            attempt: seat.attempt ?? null,
            resumed_from: seat.resumed_from ?? null,
            scope: seat.scope ?? null,
            revision: seat.revision ?? null,
            inputs: seat.inputs ?? null,
            env: seat.env,
            task: seat.task,
            by: seat.by,
            session: seat.session,
            status: seat.status,
            result: seat.result ?? null,
            integration: seat.integration ?? null,
            env_vars: envVars,
            skill: SKILL_PATH,
          },
          null,
          2
        )
      );
      break;
    case 'task':
      process.stdout.write(seat.task.endsWith('\n') ? seat.task : `${seat.task}\n`);
      break;
    case 'env':
      console.log(Object.entries(envVars).map(([key, value]) => `${key}=${value}`).join('\n'));
      break;
    case 'shell':
      console.log(
        `cd ${shellQuote(seat.worktree)} && export ` +
          Object.entries(envVars).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
      );
      break;
    default:
      console.log(
        [
          `■ ${project.slug} — seat ${options.id}`,
          `  worktree  ${present ? '1/1' : '0/1'} ${seat.worktree} (${seat.owned ? 'owned' : 'adopted'})`,
          `  branch    ${seat.branch}`,
          `  env       ${seat.env ?? 'none'}`,
          `  status    ${seat.status}${seat.by ? '  by ' + seat.by : ''}`,
          `  task      ${seat.task.split('\n')[0].slice(0, 72)}`,
        ].join('\n')
      );
  }
  if (!present) console.error(`dryad: worktree missing: ${seat.worktree}`);
  return present ? 0 : 1;
}

// What a worker hands in with done: the checks it ran, each with the exact
// command, where, the exit, and what was counted; and the boundaries it did
// not measure, each with the reason. Recorded as given, never judged here.
export function parseEvidence(text, source = 'evidence') {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    fail(`${source}: ${error.message}`);
  }
  if (!isMap(doc)) fail(`${source}: evidence must be a map with checks and not_measured.`);
  assertOnlyKeys(doc, ['checks', 'not_measured'], 'evidence', source);
  const checks = doc.checks == null ? [] : doc.checks;
  const notMeasured = doc.not_measured == null ? [] : doc.not_measured;
  if (!Array.isArray(checks)) fail(`${source}: checks must be a list.`);
  if (!Array.isArray(notMeasured)) fail(`${source}: not_measured must be a list.`);
  const out = { checks: [], not_measured: [] };
  checks.forEach((row, index) => {
    if (!isMap(row)) fail(`${source}: checks[${index}] must be a map.`);
    assertOnlyKeys(row, ['command', 'cwd', 'exit', 'observed'], `checks[${index}]`, source);
    const command = nonEmptyString(row.command, `checks[${index}].command`, source);
    const cwd = row.cwd == null ? '.' : nonEmptyString(row.cwd, `checks[${index}].cwd`, source);
    if (!Number.isInteger(row.exit)) fail(`${source}: checks[${index}].exit must be an integer exit code.`);
    const observed = nonEmptyString(row.observed, `checks[${index}].observed`, source);
    out.checks.push({ command, cwd, exit: row.exit, observed });
  });
  notMeasured.forEach((row, index) => {
    if (!isMap(row)) fail(`${source}: not_measured[${index}] must be a map.`);
    assertOnlyKeys(row, ['boundary', 'reason'], `not_measured[${index}]`, source);
    out.not_measured.push({
      boundary: nonEmptyString(row.boundary, `not_measured[${index}].boundary`, source),
      reason: nonEmptyString(row.reason, `not_measured[${index}].reason`, source),
    });
  });
  return out;
}

function readEvidence(options, cwd) {
  if (options.evidence == null) return null;
  if (options.status !== 'done') fail('--evidence goes with --status done.');
  const file = path.resolve(cwd, options.evidence);
  if (!existsSync(file)) fail(`--evidence not found: ${file}`);
  return parseEvidence(readFileSync(file, 'utf8'), file);
}

// A done report records the seat's own head, whether the tree was clean,
// and every path touched, then holds those against the seat's scope. The
// worker's word is the status; the git facts are read here, not supplied.
function doneResult(seat, id, options) {
  if (!existsSync(seat.worktree)) fail(`seat ${id}: worktree missing at ${seat.worktree}; done needs a head to record.`);
  const head = gitHead(seat.worktree);
  const touched = seatTouchedPaths(seat);
  const uncommitted = uncommittedChanges(seat.worktree);
  if (touched == null || uncommitted == null) fail(`seat ${id}: git could not read ${seat.worktree}.`);
  const outside = seat.scope == null ? [] : pathsOutsideScope(touched, seat.scope);
  return {
    head,
    base: seat.base,
    ahead: gitAhead(seat.base, seat.worktree),
    clean: uncommitted.length === 0,
    changed: touched.length,
    scope_checked: seat.scope != null,
    outside_scope: outside,
    at: now(),
    evidence: options.evidence ?? null,
  };
}

function runReport({ options, project, environment, cwd }) {
  const evidence = readEvidence(options, cwd);
  const { state } = readDryadState(project.slug, environment);
  const current = seatOf(state, options.id);
  const result = options.status === 'done' ? doneResult(current, options.id, { evidence }) : null;
  if (result != null && result.outside_scope.length > 0 && !options.acceptOutsideScope) {
    updateState(project.slug, environment, (live) => {
      journal(seatOf(live, options.id), 'seat', 'report.refused', `done: ${result.outside_scope.length} path${result.outside_scope.length === 1 ? '' : 's'} outside scope: ${result.outside_scope.join(' ')}`);
    });
    console.error(
      [
        `dryad: seat ${options.id} changed ${result.outside_scope.length} path${result.outside_scope.length === 1 ? '' : 's'} outside its scope (${current.scope.length === 0 ? 'read-only' : current.scope.join(' ')}):`,
        ...result.outside_scope.map((file) => `  ${file}`),
        `dryad: narrow the change and report again, or a person accepts it with --accept-outside-scope.`,
      ].join('\n')
    );
    return 1;
  }
  const seat = updateState(project.slug, environment, (live) => {
    const record = seatOf(live, options.id);
    record.status = options.status;
    record.result = result;
    if (options.session != null) record.session = options.session;
    // The report line is the worker's own words, the seam Mycelium reads;
    // what git said about the result is a line of Dryad's beside it.
    journal(record, 'seat', 'report', options.note == null ? options.status : `${options.status}: ${options.note}`);
    if (result != null) {
      journal(record, 'dryad', 'result', `head ${result.head.slice(0, 12)}${result.clean ? '' : ' (uncommitted changes)'} · ${result.changed} path${result.changed === 1 ? '' : 's'}${result.outside_scope.length > 0 ? ` · outside scope accepted: ${result.outside_scope.join(' ')}` : ''}${result.evidence == null ? ' · no evidence' : ` · checks ${result.evidence.checks.length}, not measured ${result.evidence.not_measured.length}`}`);
    }
    return record;
  });
  console.log(
    [
      `■ ${project.slug} — seat ${options.id}`,
      `  status    ${seat.status}`,
      ...(result == null ? [] : [`  result    head ${result.head.slice(0, 12)} · ${result.clean ? 'clean' : 'uncommitted changes'} · ${result.changed} path${result.changed === 1 ? '' : 's'} touched · scope ${result.scope_checked ? (result.outside_scope.length === 0 ? 'kept' : `${result.outside_scope.length} outside, accepted`) : 'unchecked'} · ${result.evidence == null ? 'unverified' : `checks ${result.evidence.checks.length}, not measured ${result.evidence.not_measured.length}`}`]),
      `  journal   ${seat.journal.length}`,
    ].join('\n')
  );
  if (result != null && !result.clean) {
    console.error(`dryad: seat ${options.id} reported done with uncommitted changes; only what is committed at ${result.head.slice(0, 12)} can reach another seat.`);
  }
  if (result != null && result.evidence == null) {
    console.error(`dryad: seat ${options.id} reported done without --evidence; the result stays unverified until a person checks it.`);
  }
  if (options.status === 'done' && seat.session == null) {
    console.error(`dryad: seat ${options.id} has no session reference; if your tool exposes a session id or transcript path, run report --session <ref>.`);
  }
  return 0;
}

// A person says where a seat's result landed when git ancestry cannot: a
// squash or a rebase gives the same work a new commit. The commit must be
// one this repository has; the seat's own reported head is kept beside it.
function runIntegrate({ options, project, environment }) {
  const commit = gitResolveCommit(options.commit, project.root);
  if (commit == null) fail(`${options.commit} is not a commit of this repository (${project.root}).`);
  const { state } = readDryadState(project.slug, environment);
  const live = state.seats[options.id] ?? null;
  const finished = readDryadFinished(project.slug, environment);
  const archived = previousAttempts(finished, options.id);
  const target = live ?? archived.at(-1) ?? null;
  if (target == null) fail(`seat ${options.id} is not registered for ${project.slug} and not in its finished archive.`);
  if (target.status !== 'done' || target.result == null) {
    fail(`seat ${options.id} has no done result to integrate (status ${target.status}${target.result == null ? ', no result recorded' : ''}).`);
  }
  const record = { commit, result_head: target.result.head, by: options.by ?? null, note: options.note ?? null, at: now() };
  const where = live != null ? 'live seat' : `finished attempt ${target.attempt ?? archived.length}`;
  if (!options.apply) {
    console.log(
      [
        `■ ${project.slug} — seat ${options.id} (integrate plan)`,
        `  result    ${target.result.head.slice(0, 12)} (${where})`,
        `  commit    ${commit.slice(0, 12)}`,
        `  apply     would record the integration; rerun with --apply`,
      ].join('\n')
    );
    return 0;
  }
  const detail = `${target.result.head.slice(0, 12)} integrated as ${commit.slice(0, 12)}${options.by ? ` by ${options.by}` : ''}${options.note ? `: ${options.note}` : ''}`;
  if (live != null) {
    updateState(project.slug, environment, (current) => {
      const seat = seatOf(current, options.id);
      seat.integration = record;
      journal(seat, 'dryad', 'integrate', detail);
    });
  } else {
    const release = acquireStateLock(finished.file, LOCK_WAIT_MS);
    try {
      const fresh = readDryadFinished(project.slug, environment);
      const index = fresh.seats.map((row, position) => [row, position]).filter(([row]) => row.id === options.id).at(-1)?.[1];
      if (index == null) fail(`seat ${options.id} left the finished archive while integrating; retry.`);
      fresh.seats[index].integration = record;
      fresh.seats[index].journal = fresh.seats[index].journal ?? [];
      journal(fresh.seats[index], 'dryad', 'integrate', detail);
      atomicWriteFile(fresh.file, stringify({ version: STATE_VERSION, project: project.slug, seats: fresh.seats }));
    } finally {
      release();
    }
  }
  console.log(
    [
      `■ ${project.slug} — seat ${options.id}`,
      `  result    ${target.result.head.slice(0, 12)} (${where})`,
      `  commit    1/1 ${commit.slice(0, 12)} recorded${options.by ? ` by ${options.by}` : ''}`,
    ].join('\n')
  );
  return 0;
}

// Bind the slug to this checkout's repository. Refused while seats from the
// other repository are live; the finished archive is kept as it is, and a
// reader that compares repositories sees those records as another project's.
function runRebind({ options, project, environment }) {
  const repository = gitRepositoryId(project.root);
  const { index } = readDryadProjectsIndex(environment);
  const { state } = readDryadState(project.slug, environment);
  const entry = index.projects[project.slug] ?? null;
  const bound = state.repository ?? entry?.repository ?? null;
  const seats = Object.keys(state.seats).length;
  const lines = [
    `■ ${project.slug} — rebind${options.apply ? '' : ' (plan)'}`,
    `  bound     ${bound == null ? 'nothing' : `${bound.slice(0, 12)} at ${entry?.root ?? 'root unknown'}`}`,
    `  checkout  ${repository.slice(0, 12)} at ${project.root}`,
  ];
  if (bound === repository) {
    console.log([...lines, '  rebind    nothing to do; already bound here'].join('\n'));
    return 0;
  }
  if (seats > 0) fail(`${project.slug} has ${seats} live seat${seats === 1 ? '' : 's'} from repository ${bound == null ? 'unknown' : bound.slice(0, 12)}; finish them before rebinding.`);
  if (!options.apply) {
    console.log([...lines, '  apply     nothing changed; rerun with --apply'].join('\n'));
    return 0;
  }
  recordProjectRoot(project.slug, project.root, repository, environment);
  console.log([...lines, `  rebind    1/1 index now names ${repository.slice(0, 12)}; the finished archive is kept as it was`].join('\n'));
  return 0;
}

function runFinishedStatus({ options, project, environment }) {
  const { seats } = readDryadFinished(project.slug, environment);
  const selected = seats.filter((seat) => options.id == null || seat.id === options.id);
  if (options.id != null && selected.length === 0) fail(`seat ${options.id} is not in the finished archive for ${project.slug}.`);
  if (options.json) {
    console.log(JSON.stringify({ project: project.slug, finished: selected }, null, 2));
    return 0;
  }
  const lines = [`■ ${project.slug} — finished seats ${selected.length}`];
  for (const seat of selected) {
    lines.push(`  ${seat.id}  ${seat.branch}  ${seat.status}${seat.by ? '  by ' + seat.by : ''}  finished ${seat.finished_at}  journal ${seat.journal.length}`);
    if (options.id != null) {
      for (const entry of seat.journal) lines.push(`  ${entry.at}  ${entry.actor.padEnd(5)}  ${entry.event.padEnd(14)}  ${entry.detail}`);
    }
  }
  console.log(lines.join('\n'));
  return 0;
}

// The seat's work as a patch: everything its worktree holds that its base
// does not, committed and uncommitted alike, plus the untracked files git
// would not diff. Read-only; capped so a dashboard cannot be buried.
const DIFF_LIMIT = 512 * 1024;

function runDiff({ options, project, environment }) {
  const { state } = readDryadState(project.slug, environment);
  const seat = seatOf(state, options.id);
  if (!existsSync(seat.worktree)) fail(`seat ${options.id}: worktree missing at ${seat.worktree}.`);
  const head = git(['rev-parse', 'HEAD'], seat.worktree);
  const patch = git(['diff', seat.base, '--'], seat.worktree);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], seat.worktree);
  if (head.status !== 0 || patch.status !== 0 || untracked.status !== 0) fail(`seat ${options.id}: git failed in ${seat.worktree}: ${(patch.stderr || head.stderr || untracked.stderr).trim()}`);
  const truncated = patch.stdout.length > DIFF_LIMIT;
  const report = {
    id: options.id,
    worktree: seat.worktree,
    base: seat.base,
    head: head.stdout.trim(),
    patch: truncated ? patch.stdout.slice(0, DIFF_LIMIT) : patch.stdout,
    untracked: untracked.stdout.split('\n').filter(Boolean),
    truncated,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    process.stdout.write(report.patch);
    for (const file of report.untracked) console.log(`untracked: ${file}`);
    if (truncated) console.log(`(patch truncated at ${DIFF_LIMIT} bytes)`);
  }
  return 0;
}

function runStatus({ options, project, environment }) {
  if (options.finished) return runFinishedStatus({ options, project, environment });
  const { state } = readDryadState(project.slug, environment);
  const entries = Object.entries(state.seats)
    .filter(([id]) => options.id == null || id === options.id)
    .sort(([left], [right]) => left.localeCompare(right));
  if (options.id != null && entries.length === 0) fail(`seat ${options.id} is not registered for ${project.slug}.`);

  const problems = [];
  const repository = gitRepositoryId(project.root);
  if (state.repository != null && state.repository !== repository) {
    problems.push(`registry bound to repository ${state.repository.slice(0, 12)}; this checkout is ${repository.slice(0, 12)} (dryad rebind)`);
  }
  const wantsEnv = entries.filter(([, seat]) => seat.env != null);
  let tracked = null;
  let attached = null;
  let busy = new Set();
  if (project.overlayActive && (wantsEnv.length > 0 || options.id == null)) {
    const probe = probeOverlay(project, environment);
    tracked = probe.envs;
    attached = probe.attached;
    busy = new Set(probe.pending.filter((item) => item.state === 'in-flight').map((item) => item.env));
    problems.push(...overlayProblems(probe));
  }

  const worktrees = repositoryWorktrees(project, state);

  const rows = entries.map(([id, seat]) => {
    const present = existsSync(seat.worktree);
    const { changes, paths } = seatChanges(seat);
    const ahead = changes?.counts.ahead ?? null;
    let envState = 'none';
    if (seat.env === 'pending') envState = 'pending';
    else if (seat.env != null) {
      envState = tracked == null ? 'notMeasured' : tracked.has(seat.env) ? 'tracked' : 'missing';
      if (envState === 'missing' && project.overlayCreateOn === 'attach') envState = 'unattached';
      if (busy.has(seat.env)) envState = 'in-flight';
    }
    if (!present) problems.push(`${id}: worktree missing ${seat.worktree}`);
    if (envState === 'missing') problems.push(`${id}: env ${seat.env} not tracked by overlay status`);
    if (envState === 'pending') problems.push(`${id}: env pending; rerun plan --apply`);
    if (seat.status === 'blocked') problems.push(`${id}: blocked`);
    let hostnames = [];
    if (options.json && project.overlayActive && seat.env != null && seat.env !== 'pending') {
      const probe = probeHostnames(project, seat.env, environment);
      const live = attached?.get(seat.env) ?? null;
      hostnames = probe.hostnames.map((row) => ({ ...row, attached: live?.has(row.service) ?? false }));
      if (probe.error != null) problems.push(`${id}: ${probe.error}`);
    }
    return { id, seat, present, ahead, envState, hostnames, changes, paths, activity: seatActivity(project.slug, id, environment, { worktree: seat.worktree }) };
  });
  if (options.id == null && tracked != null) {
    const seated = new Set(entries.map(([, seat]) => seat.env).filter(Boolean));
    for (const env of tracked) if (!seated.has(env)) problems.push(`env ${env} tracked by overlay status has no seat`);
  }

  const overlaps = seatOverlaps(rows);
  const unseated = worktrees.filter((row) => !row.baseline && row.seat == null).length;

  const counts = {
    seats: rows.length,
    worktrees_present: rows.filter((row) => row.present).length,
    envs_wanted: wantsEnv.length,
    envs_tracked: rows.filter((row) => row.envState === 'tracked' || row.envState === 'in-flight').length,
    envs_in_flight: rows.filter((row) => row.envState === 'in-flight').length,
    reported: Object.fromEntries(STATUS_VALUES.map((value) => [value, rows.filter((row) => row.seat.status === value).length])),
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          project: project.slug,
          counts,
          worktrees,
          overlaps,
          problems,
          repository: { bound: state.repository ?? null, checkout: repository },
          seats: rows.map((row) => ({
            id: row.id,
            worktree: row.seat.worktree,
            worktree_present: row.present,
            owned: row.seat.owned,
            branch: row.seat.branch,
            base: row.seat.base,
            attempt: row.seat.attempt ?? null,
            resumed_from: row.seat.resumed_from ?? null,
            scope: row.seat.scope ?? null,
            revision: row.seat.revision ?? null,
            inputs: row.seat.inputs ?? null,
            ahead: row.ahead,
            changes: row.changes,
            env: row.seat.env,
            env_state: row.envState,
            hostnames: row.hostnames,
            status: row.seat.status,
            result: row.seat.result ?? null,
            integration: row.seat.integration ?? null,
            by: row.seat.by,
            session: row.seat.session,
            activity: row.activity,
            journal: row.seat.journal,
          })),
        },
        null,
        2
      )
    );
    return problems.length === 0 ? 0 : 1;
  }

  const reported = STATUS_VALUES.filter((value) => counts.reported[value] > 0)
    .map((value) => `${value} ${counts.reported[value]}`)
    .join(', ');
  const lines = [
    `■ ${project.slug} — seats ${counts.seats}`,
    `  worktrees  ${counts.worktrees_present}/${counts.seats} present`,
    project.overlayActive
      ? `  envs       ${counts.envs_tracked}/${counts.envs_wanted} tracked${tracked == null ? ' (notMeasured)' : ''}${counts.envs_in_flight > 0 ? `, ${counts.envs_in_flight} in-flight` : ''}`
      : '  envs       none (overlay inactive)',
    `  reported   ${reported || 'none'}`,
    `  worktrees  ${worktrees.length} (${unseated} unseated)`,
    `  overlaps   ${overlaps.length}`,
  ];
  for (const row of rows) {
    const envLabel = row.seat.env == null ? '-' : `env ${row.seat.env} ${row.envState}`;
    const last = row.seat.journal.at(-1);
    const note = row.seat.status === 'blocked' && last?.detail?.includes(': ') ? `  "${last.detail.split(': ').slice(1).join(': ')}"` : '';
    lines.push(
      `  ${row.id}  ${row.seat.branch}  ${row.present ? `+${row.ahead ?? '?'}` : 'missing'}  ${envLabel}  ${row.seat.status}${row.seat.by ? '  by ' + row.seat.by : ''}${note}${row.activity?.doing ? `  · now ${row.activity.doing}` : row.activity?.state ? `  · session ${row.activity.state}` : ''}`
    );
  }
  for (const item of overlaps) lines.push(`  overlap  ${item.path}  ${item.seats.join(' · ')}`);
  for (const problem of problems) lines.push(`  problem  ${problem}`);
  if (options.id != null) {
    for (const entry of rows[0].seat.journal) lines.push(`  ${entry.at}  ${entry.actor.padEnd(5)}  ${entry.event.padEnd(14)}  ${entry.detail}`);
  }
  console.log(lines.join('\n'));
  return problems.length === 0 ? 0 : 1;
}

function runFinish({ options, project, environment }) {
  const { state } = readDryadState(project.slug, environment);
  const seat = seatOf(state, options.id);
  const present = existsSync(seat.worktree);
  const hasEnv = seat.env != null;

  if (!options.apply) {
    console.log(
      [
        `■ ${project.slug} — seat ${options.id} (finish plan)`,
        `  env       ${hasEnv ? `would destroy ${seat.env === 'pending' ? options.id + ' (pending)' : seat.env}` : 'none'}`,
        `  worktree  ${seat.owned ? (present ? `would remove ${seat.worktree} if clean` : 'already gone') : `kept (adopted) ${seat.worktree}`}`,
        `  branch    kept ${seat.branch}`,
        '  apply     nothing changed; rerun with --apply',
      ].join('\n')
    );
    return 0;
  }

  let envResult = 'none';
  if (hasEnv) {
    const result = grove(['destroy', options.id, '--apply'], project, environment);
    if (result.status !== 0) {
      updateState(project.slug, environment, (current) => {
        journal(seatOf(current, options.id), 'dryad', 'finish.destroy', `failed exit ${result.status}: ${lastLine(result.stderr) || lastLine(result.stdout)}`);
      });
      relayFailure('overlay destroy', result);
      console.error(`dryad: seat ${options.id} kept; fix the overlay and rerun finish --apply.`);
      return 1;
    }
    envResult = '1/1 destroyed';
  }

  let worktreeResult;
  if (!seat.owned) {
    worktreeResult = 'kept (adopted)';
  } else if (!present) {
    git(['worktree', 'prune'], project.root);
    worktreeResult = 'already gone';
  } else if (!gitIsClean(seat.worktree)) {
    updateState(project.slug, environment, (current) => {
      const record = seatOf(current, options.id);
      if (hasEnv) record.env = null;
      journal(record, 'dryad', 'finish.worktree', `kept: uncommitted changes in ${seat.worktree}`);
    });
    console.error(`dryad: ${seat.worktree} has uncommitted changes; commit or clean it, then rerun finish --apply.`);
    console.log([`■ ${project.slug} — seat ${options.id}`, `  env       ${envResult}`, `  worktree  0/1 kept (dirty)`].join('\n'));
    return 1;
  } else {
    gitOk(['worktree', 'remove', seat.worktree], project.root);
    worktreeResult = '1/1 removed';
  }

  updateState(project.slug, environment, (current) => {
    const record = seatOf(current, options.id);
    journal(record, 'dryad', 'finish', `env ${envResult}; worktree ${worktreeResult}; branch kept ${seat.branch}`);
    archiveFinishedSeat(project.slug, environment, options.id, record);
    removeSeatEvents(project.slug, options.id, environment);
    delete current.seats[options.id];
  });
  console.log(
    [
      `■ ${project.slug} — seat ${options.id}`,
      `  env       ${envResult}`,
      `  worktree  ${worktreeResult}`,
      `  branch    kept ${seat.branch}`,
      '  seat      removed (journal kept in the finished archive; status --finished)',
    ].join('\n')
  );
  return 0;
}

// Overlay mode of an indexed project, read from its Grove profile. Absent or
// unreadable profiles count as no overlay; the reason goes to stderr.
function projectOverlayActive(slug, root) {
  const runtimePath = path.join(root, RUNTIME_PROFILE_RELPATH);
  if (!existsSync(runtimePath)) return false;
  try {
    return parseProfile(readFileSync(runtimePath, 'utf8'), runtimePath).overlay?.mode === 'on';
  } catch (error) {
    console.error(`dryad: ${slug}: ${error.message}`);
    return false;
  }
}

function runProjects({ options, environment }) {
  const { index } = readDryadProjectsIndex(environment);
  const projects = Object.entries(index.projects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, entry]) => {
      const rootPresent = existsSync(entry.root);
      return {
        slug,
        root: entry.root,
        root_present: rootPresent,
        seats: Object.keys(readDryadState(slug, environment).state.seats).length,
        finished: readDryadFinished(slug, environment).seats.length,
        overlay: rootPresent && projectOverlayActive(slug, entry.root),
        updated_at: entry.updated_at,
      };
    });
  if (options.json) {
    console.log(JSON.stringify({ projects }, null, 2));
    return 0;
  }
  const lines = [`■ dryad — projects ${projects.length}`];
  for (const row of projects) {
    lines.push(
      `  ${row.slug}  ${row.root}  ${row.root_present ? 'present' : 'missing'}  seats ${row.seats}  finished ${row.finished}  overlay ${row.overlay ? 'on' : 'off'}  updated ${row.updated_at}`
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

export function runDryad({ options, environment = process.env, cwd = process.cwd() }) {
  // projects is machine-wide: it reads the index, not a project.
  if (options.verb === 'projects') return runProjects({ options, environment });
  const location = resolveDryadProject({ project: options.project, environment, cwd });
  const project = loadDryadProject(location);
  switch (options.verb) {
    case 'plan':
      return runPlan({ options, project, environment, cwd });
    case 'seat':
      return runSeat({ options, project, environment });
    case 'report':
      return runReport({ options, project, environment, cwd });
    case 'integrate':
      return runIntegrate({ options, project, environment });
    case 'status':
      return runStatus({ options, project, environment });
    case 'diff':
      return runDiff({ options, project, environment });
    case 'finish':
      return runFinish({ options, project, environment });
    case 'rebind':
      return runRebind({ options, project, environment });
    default:
      fail(`unsupported command ${JSON.stringify(options.verb)}.`);
  }
}

export function dryadHelp(cli = 'de-novo skills') {
  return `seats for workers on Grove's ground (worktree + overlay env + task; no agent launch)

usage:
  ${cli} dryad plan   ID (--task TEXT | --task-file PATH) [--worktree PATH | --resume] [--owns CLAIM ...| --read-only]
                      [--revision TEXT] [--input ID=SHA ...] [--by LABEL] [--project ROOT] [--apply]
  ${cli} dryad seat   ID [--json | --env | --shell | --task] [--project ROOT]
  ${cli} dryad report ID --status working|blocked|done [--note TEXT] [--session REF] [--evidence PATH]
                      [--accept-outside-scope] [--project ROOT]
  ${cli} dryad integrate ID --commit SHA [--by LABEL] [--note TEXT] [--project ROOT] [--apply]
  ${cli} dryad status [ID] [--json] [--finished] [--project ROOT]
  ${cli} dryad diff ID [--json] [--project ROOT]    the seat's work as a patch against its base, committed or not, plus untracked files
  ${cli} dryad finish ID [--project ROOT] [--apply]
  ${cli} dryad rebind [--project ROOT] [--apply]    bind the slug to this checkout's repository
  ${cli} dryad projects [--json]

plan creates a worktree (or adopts --worktree) and, when the runtime profile
has overlays, calls \`overlay create\`. Every attempt at an id gets its own
branch (the template, then -2, -3, …); earlier branches are kept, and an
existing branch is never overwritten. --resume continues the previous
attempt's branch instead. --owns records the seat's scope; --read-only
records an empty one; neither leaves it unchecked. seat prints the seat for
any launcher. Workers report their own status; a done report records the
seat's own head, whether the tree was clean, every path touched, and the
--evidence file (checks with command, cwd, exit, observed; not_measured with
boundary, reason). A done that touched paths outside the scope is refused
with the paths named until a person passes --accept-outside-scope.
integrate records, from a person, the commit a squash or rebase gave the
seat's result. finish destroys the env, removes only a clean, Dryad-created
worktree, and keeps the seat's journal in the finished archive. The seat
carries DRYAD_SKILL, the path to this skill, so a worker can read it from
any launcher. ROOT defaults to DRYAD_PROJECT, then the nearest
.agents/dryad-profile.yml above the cwd. A slug is bound to one repository
on this machine (its root commit); another repository with the same slug is
refused until rebind. projects lists every project that has planned a seat
on this machine with live seat, finished, and overlay counts. status --json
carries each seat's overlay hostnames (read from \`urls --json\`, marked
attached or not), the files it changed, every worktree of the baseline
repository whether seated or not, and the paths two seats both hold. A seat
also journals the state-changing catalog verbs it runs, with their exit code.`;
}
