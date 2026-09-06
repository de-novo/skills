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
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { parseProfile } from './profile.mjs';

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

function validateState(state, slug, file) {
  if (!isMap(state) || state.version !== STATE_VERSION || state.project !== slug) {
    fail(`${file}: registry must have version ${STATE_VERSION} and project ${JSON.stringify(slug)}.`);
  }
  if (!isMap(state.seats)) fail(`${file}: seats must be a map.`);
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
// while this lock is held.
function acquireStateLock(file, waitMs) {
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

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// ------------------------------------------------------------------ grove

function grove(args, project, environment) {
  return spawnSync(process.execPath, [CLI_PATH, 'overlay', ...args, '--project', project.root], {
    cwd: project.root,
    env: environment,
    encoding: 'utf8',
  });
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
  plan: { positionals: [1, 1], options: ['task', 'task-file', 'worktree', 'by', 'project'], flags: ['apply'] },
  seat: { positionals: [1, 1], options: ['project'], flags: ['json', 'env', 'shell', 'task'] },
  report: { positionals: [1, 1], options: ['status', 'note', 'session', 'project'], flags: [] },
  status: { positionals: [0, 1], options: ['project'], flags: ['json', 'finished'] },
  finish: { positionals: [1, 1], options: ['project'], flags: ['apply'] },
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
  for (const name of spec.flags) options[name] = false;
  const positionals = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (spec.flags.includes(name)) {
        if (options[name]) fail(`--${name} may be passed only once.`);
        options[name] = true;
        continue;
      }
      if (spec.options.includes(name)) {
        if (options[camel(name)] != null) fail(`--${name} may be passed only once.`);
        options[camel(name)] = takeOption(input, index, name);
        index += 1;
        continue;
      }
      fail(`--${name} is not valid for ${verb}.`);
    }
    positionals.push(arg);
  }
  const [minimum, maximum] = spec.positionals;
  if (positionals.length > maximum) fail(`${verb} takes at most ${maximum} positional argument${maximum === 1 ? '' : 's'}.`);
  if (positionals.length < minimum) fail(`${verb} requires a seat id.`);
  options.id = positionals[0] == null ? null : assertSeatId(positionals[0]);

  if (verb === 'plan') {
    if ((options.task == null) === (options.taskFile == null)) fail('plan requires exactly one of --task or --task-file.');
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

function resolveWorktreePlan(options, project, cwd, existing) {
  if (options.worktree != null) {
    const target = path.resolve(cwd, options.worktree);
    if (!existsSync(target) || !statSync(target).isDirectory()) fail(`--worktree is not a directory: ${target}`);
    const real = realpathSync(target);
    if (real === project.root) fail('--worktree must not be the baseline checkout itself.');
    if (gitCommonDir(real) !== gitCommonDir(project.root)) {
      fail(`--worktree belongs to a different repository: ${real}`);
    }
    return { path: real, owned: false, branch: gitBranch(real), base: gitHead(real), exists: true };
  }
  if (project.dryad.worktrees == null) {
    fail('dryad-profile.yml has no worktrees section; pass --worktree <existing-path> to adopt one.');
  }
  const { root, branch } = project.dryad.worktrees;
  const target = path.resolve(project.root, root, options.id);
  if (isInside(target, project.root)) {
    fail(`worktrees.root resolves inside the baseline checkout: ${target}`);
  }
  const seatBranch = branch.replaceAll('{id}', options.id);
  if (existing != null) {
    return { path: existing.worktree, owned: true, branch: existing.branch, base: existing.base, exists: existsSync(existing.worktree) };
  }
  const exists = existsSync(target);
  return { path: target, owned: true, branch: seatBranch, base: gitHead(project.root), exists };
}

function runPlan({ options, project, environment, cwd }) {
  const { state } = readDryadState(project.slug, environment);
  const existing = state.seats[options.id] ?? null;
  if (existing != null && existing.env !== 'pending') {
    fail(`seat ${options.id} already exists; finish it before planning it again.`);
  }
  const task = readTask(options, cwd);
  const plan = resolveWorktreePlan(options, project, cwd, existing);
  const envWanted = project.overlayActive ? options.id : null;

  if (!options.apply) {
    console.log(
      [
        `■ ${project.slug} — seat ${options.id} (plan)`,
        `  worktree  ${plan.path} (${plan.owned ? (plan.exists ? 'exists' : 'would create') : 'adopt'})`,
        `  branch    ${plan.branch}`,
        `  base      ${plan.base.slice(0, 12)}`,
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
      gitOk(['worktree', 'add', '--no-track', '-b', plan.branch, plan.path, 'HEAD'], project.root);
      created = true;
      journalLines.push(`worktree add ${plan.branch} at ${plan.base.slice(0, 12)}`);
    }
  } else {
    journalLines.push(`adopt ${plan.path} on ${plan.branch}`);
  }

  let env = envWanted;
  let envFailure = null;
  if (envWanted != null) {
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
      task,
      env: null,
      by: options.by ?? null,
      session: null,
      created_at: now(),
      status: 'planned',
      journal: [],
    };
    record.env = env;
    if (options.by != null) record.by = options.by;
    journal(record, 'dryad', existing == null ? 'plan' : 'plan.retry', journalLines.join('; '));
    current.seats[options.id] = record;
    return record;
  });

  console.log(
    [
      `■ ${project.slug} — seat ${options.id}`,
      `  worktree  1/1 ${seat.worktree} (${seat.owned ? (created ? 'created' : 'present') : 'adopted'})`,
      `  branch    ${seat.branch}`,
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

function seatEnvironment(seat, id, project) {
  return {
    DRYAD_ID: id,
    DRYAD_ENV: seat.env == null || seat.env === 'pending' ? '' : seat.env,
    DRYAD_BRANCH: seat.branch,
    DRYAD_PROJECT: project.root,
    DRYAD_SKILL: SKILL_PATH,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runSeat({ options, project, environment }) {
  const { state } = readDryadState(project.slug, environment);
  const seat = seatOf(state, options.id);
  const present = existsSync(seat.worktree);
  const envVars = seatEnvironment(seat, options.id, project);
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
            env: seat.env,
            task: seat.task,
            by: seat.by,
            session: seat.session,
            status: seat.status,
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

function runReport({ options, project, environment }) {
  const seat = updateState(project.slug, environment, (state) => {
    const record = seatOf(state, options.id);
    record.status = options.status;
    if (options.session != null) record.session = options.session;
    journal(record, 'seat', 'report', options.note == null ? options.status : `${options.status}: ${options.note}`);
    return record;
  });
  console.log(
    [`■ ${project.slug} — seat ${options.id}`, `  status    ${seat.status}`, `  journal   ${seat.journal.length}`].join('\n')
  );
  if (options.status === 'done' && seat.session == null) {
    console.error(`dryad: seat ${options.id} has no session reference; if your tool exposes a session id or transcript path, run report --session <ref>.`);
  }
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

function runStatus({ options, project, environment }) {
  if (options.finished) return runFinishedStatus({ options, project, environment });
  const { state } = readDryadState(project.slug, environment);
  const entries = Object.entries(state.seats)
    .filter(([id]) => options.id == null || id === options.id)
    .sort(([left], [right]) => left.localeCompare(right));
  if (options.id != null && entries.length === 0) fail(`seat ${options.id} is not registered for ${project.slug}.`);

  const problems = [];
  const wantsEnv = entries.filter(([, seat]) => seat.env != null);
  let tracked = null;
  let busy = new Set();
  if (project.overlayActive && (wantsEnv.length > 0 || options.id == null)) {
    const probe = probeOverlay(project, environment);
    tracked = probe.envs;
    busy = new Set(probe.pending.filter((item) => item.state === 'in-flight').map((item) => item.env));
    problems.push(...overlayProblems(probe));
  }

  const rows = entries.map(([id, seat]) => {
    const present = existsSync(seat.worktree);
    const ahead = present ? gitAhead(seat.base, seat.worktree) : null;
    let envState = 'none';
    if (seat.env === 'pending') envState = 'pending';
    else if (seat.env != null) {
      envState = tracked == null ? 'notMeasured' : tracked.has(seat.env) ? 'tracked' : 'missing';
      if (busy.has(seat.env)) envState = 'in-flight';
    }
    if (!present) problems.push(`${id}: worktree missing ${seat.worktree}`);
    if (envState === 'missing') problems.push(`${id}: env ${seat.env} not tracked by overlay status`);
    if (envState === 'pending') problems.push(`${id}: env pending; rerun plan --apply`);
    if (seat.status === 'blocked') problems.push(`${id}: blocked`);
    return { id, seat, present, ahead, envState };
  });
  if (options.id == null && tracked != null) {
    const seated = new Set(entries.map(([, seat]) => seat.env).filter(Boolean));
    for (const env of tracked) if (!seated.has(env)) problems.push(`env ${env} tracked by overlay status has no seat`);
  }

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
          problems,
          seats: rows.map((row) => ({
            id: row.id,
            worktree: row.seat.worktree,
            worktree_present: row.present,
            owned: row.seat.owned,
            branch: row.seat.branch,
            base: row.seat.base,
            ahead: row.ahead,
            env: row.seat.env,
            env_state: row.envState,
            status: row.seat.status,
            by: row.seat.by,
            session: row.seat.session,
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
  ];
  for (const row of rows) {
    const envLabel = row.seat.env == null ? '-' : `env ${row.seat.env} ${row.envState}`;
    const last = row.seat.journal.at(-1);
    const note = row.seat.status === 'blocked' && last?.detail?.includes(': ') ? `  "${last.detail.split(': ').slice(1).join(': ')}"` : '';
    lines.push(
      `  ${row.id}  ${row.seat.branch}  ${row.present ? `+${row.ahead ?? '?'}` : 'missing'}  ${envLabel}  ${row.seat.status}${row.seat.by ? '  by ' + row.seat.by : ''}${note}`
    );
  }
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

export function runDryad({ options, environment = process.env, cwd = process.cwd() }) {
  const location = resolveDryadProject({ project: options.project, environment, cwd });
  const project = loadDryadProject(location);
  switch (options.verb) {
    case 'plan':
      return runPlan({ options, project, environment, cwd });
    case 'seat':
      return runSeat({ options, project, environment });
    case 'report':
      return runReport({ options, project, environment });
    case 'status':
      return runStatus({ options, project, environment });
    case 'finish':
      return runFinish({ options, project, environment });
    default:
      fail(`unsupported command ${JSON.stringify(options.verb)}.`);
  }
}

export function dryadHelp(cli = 'de-novo skills') {
  return `seats for workers on Grove's ground (worktree + overlay env + task; no agent launch)

usage:
  ${cli} dryad plan   ID (--task TEXT | --task-file PATH) [--worktree PATH] [--by LABEL] [--project ROOT] [--apply]
  ${cli} dryad seat   ID [--json | --env | --shell | --task] [--project ROOT]
  ${cli} dryad report ID --status working|blocked|done [--note TEXT] [--session REF] [--project ROOT]
  ${cli} dryad status [ID] [--json] [--finished] [--project ROOT]
  ${cli} dryad finish ID [--project ROOT] [--apply]

plan creates a worktree (or adopts --worktree) and, when the runtime profile
has overlays, calls \`overlay create\`. seat prints the seat for any launcher.
Workers report their own status. finish destroys the env, removes only a
clean, Dryad-created worktree, and keeps the seat's journal in the finished
archive; branches are always kept. The seat carries DRYAD_SKILL, the path to
this skill, so a worker can read it from any launcher. ROOT defaults to
DRYAD_PROJECT, then the nearest .agents/dryad-profile.yml above the cwd.`;
}
