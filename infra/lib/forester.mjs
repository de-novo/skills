// de-novo Forester — analyse the work into a plan, keep this machine's slots
// full. The plan is a tracked file; the budget is the plan's own `parallel`
// or, when the plan sets none, the untracked local file's. Allocation is a
// pure function of the plan, the Dryad seats, and the budget: no model call,
// no daemon, the same inputs give the same assignment.
//
// Values live in the consuming project:
//   .agents/forester-plan.yml    the items (tracked)
//   .agents/forester.local.yml   this machine's budget (gitignored)
// Pattern lives in skills/forester/SKILL.md. Fields in skills/forester/references/plan.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { claimSegments, claimsIntersect, normalizeClaim } from './claims.mjs';
import {
  assertSeatId,
  dryadStateDirectory,
  loadDryadProject,
  parseDryadCliArgs,
  readDryadFinished,
  readDryadState,
  resolveDryadProject,
  runDryad,
} from './dryad.mjs';

export { claimSegments, claimsIntersect };

export const PLAN_RELPATH = '.agents/forester-plan.yml';
export const LOCAL_RELPATH = '.agents/forester.local.yml';
const PLAN_VERSION = 1;
const PLAN_KEYS = Object.freeze(['version', 'parallel', 'tasks']);
const TASK_KEYS = Object.freeze(['task', 'brief', 'owns', 'read_only', 'depends_on', 'verify', 'tool', 'retry']);
const RETRY_KEYS = Object.freeze(['max_attempts']);
const DEPENDENCY_KEYS = Object.freeze(['item', 'needs']);
const DEPENDENCY_NEEDS = Object.freeze(['result', 'order']);
const LOCAL_KEYS = Object.freeze(['version', 'parallel', 'tool', 'tools']);
const TOOL_KEYS = Object.freeze(['command', 'pretrust_worktrees']);
export const ITEM_STATES = Object.freeze(['done', 'active', 'waiting', 'failed', 'blocked', 'ready']);

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`forester: ${message}`);
}

function assertOnlyKeys(value, allowed, field, source) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${source}: ${field} has unknown key ${JSON.stringify(key)}.`);
  }
}

function nonEmptyString(value, field, source) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${source}: ${field} must be a non-empty string.`);
  return value;
}

function stringList(value, field, source) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${source}: ${field} must be a list.`);
  return value.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`, source));
}

function parallelValue(value, source) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) fail(`${source}: parallel must be an integer of at least 1.`);
  return value;
}

// ------------------------------------------------------------------- plan

export function parseForesterPlan(yamlText, source = 'forester-plan.yml') {
  let doc;
  try {
    doc = parse(yamlText);
  } catch (error) {
    fail(`${source}: ${error.message}`);
  }
  if (!isMap(doc)) fail(`${source}: plan must be a map.`);
  assertOnlyKeys(doc, PLAN_KEYS, 'plan', source);
  if (doc.version !== PLAN_VERSION) fail(`${source}: version must be ${PLAN_VERSION}.`);
  const parallel = parallelValue(doc.parallel, source);
  if (!isMap(doc.tasks)) fail(`${source}: tasks must be a map of item id to item.`);

  const tasks = [];
  for (const [id, raw] of Object.entries(doc.tasks)) {
    try {
      assertSeatId(id);
    } catch (error) {
      fail(`${source}: item id ${JSON.stringify(id)} must be a DNS label of at most 63 characters, because it becomes the seat id.`);
    }
    if (!isMap(raw)) fail(`${source}: tasks.${id} must be a map.`);
    assertOnlyKeys(raw, TASK_KEYS, `tasks.${id}`, source);
    if (raw.read_only != null && typeof raw.read_only !== 'boolean') fail(`${source}: tasks.${id}.read_only must be true or false.`);
    const owns = stringList(raw.owns, `tasks.${id}.owns`, source).map((claim, index) => {
      try {
        return normalizeClaim(claim, 'claim');
      } catch (error) {
        fail(`${source}: tasks.${id}.owns[${index}] ${error.message.replace(/^claim /, '')}`);
      }
    });
    if (raw.read_only === true && owns.length > 0) fail(`${source}: tasks.${id}: a read_only item must not own paths.`);
    const item = {
      id,
      task: nonEmptyString(raw.task, `tasks.${id}.task`, source),
      brief: raw.brief == null ? null : nonEmptyString(raw.brief, `tasks.${id}.brief`, source),
      owns,
      readOnly: raw.read_only === true,
      dependencies: dependencyList(raw.depends_on, id, source),
      verify: stringList(raw.verify, `tasks.${id}.verify`, source),
      tool: raw.tool == null ? null : nonEmptyString(raw.tool, `tasks.${id}.tool`, source),
      retry: { maxAttempts: 1 },
    };
    item.dependsOn = item.dependencies.map((dependency) => dependency.id);
    if (raw.retry != null) {
      if (!isMap(raw.retry)) fail(`${source}: tasks.${id}.retry must be a map.`);
      assertOnlyKeys(raw.retry, RETRY_KEYS, `tasks.${id}.retry`, source);
      if (!Number.isInteger(raw.retry.max_attempts) || raw.retry.max_attempts < 1) {
        fail(`${source}: tasks.${id}.retry.max_attempts must be an integer of at least 1.`);
      }
      item.retry.maxAttempts = raw.retry.max_attempts;
    }
    tasks.push(item);
  }
  if (tasks.length === 0) fail(`${source}: tasks must name at least one item.`);

  const ids = new Set(tasks.map((item) => item.id));
  for (const item of tasks) {
    for (const dep of item.dependsOn) {
      if (dep === item.id) fail(`${source}: tasks.${item.id} depends on itself.`);
      if (!ids.has(dep)) fail(`${source}: tasks.${item.id} depends on unknown item ${JSON.stringify(dep)}.`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle != null) fail(`${source}: dependency cycle ${cycle.join(' -> ')}.`);

  return { version: PLAN_VERSION, parallel, tasks };
}

// `depends_on: [a]` needs a's result in this item's base; `{ item: a,
// needs: order }` needs only a's done report. The bare id is the strict
// form on purpose: a dependency that is really only an ordering says so.
function dependencyList(value, id, source) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${source}: tasks.${id}.depends_on must be a list.`);
  const out = [];
  value.forEach((entry, index) => {
    const field = `tasks.${id}.depends_on[${index}]`;
    if (typeof entry === 'string') {
      out.push({ id: nonEmptyString(entry, field, source), needs: 'result' });
      return;
    }
    if (!isMap(entry)) fail(`${source}: ${field} must be an item id or a map { item, needs }.`);
    assertOnlyKeys(entry, DEPENDENCY_KEYS, field, source);
    const needs = entry.needs == null ? 'result' : entry.needs;
    if (!DEPENDENCY_NEEDS.includes(needs)) fail(`${source}: ${field}.needs must be one of ${DEPENDENCY_NEEDS.join('|')}.`);
    out.push({ id: nonEmptyString(entry.item, `${field}.item`, source), needs });
  });
  const seen = new Set();
  for (const dependency of out) {
    if (seen.has(dependency.id)) fail(`${source}: tasks.${id} depends on ${dependency.id} twice.`);
    seen.add(dependency.id);
  }
  return out;
}

// Depth-first walk over declared order. Returns the first cycle as a path
// that begins and ends on the same id, or null.
function findCycle(tasks) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const colour = new Map();
  const stack = [];
  const visit = (id) => {
    colour.set(id, 'grey');
    stack.push(id);
    for (const dep of byId.get(id).dependsOn) {
      const seen = colour.get(dep);
      if (seen === 'grey') return [...stack.slice(stack.indexOf(dep)), dep];
      if (seen == null) {
        const found = visit(dep);
        if (found != null) return found;
      }
    }
    stack.pop();
    colour.set(id, 'black');
    return null;
  };
  for (const item of tasks) {
    if (colour.has(item.id)) continue;
    const found = visit(item.id);
    if (found != null) return found;
  }
  return null;
}

// ------------------------------------------------------------------ local

export function parseForesterLocal(yamlText, source = 'forester.local.yml') {
  let doc;
  try {
    doc = parse(yamlText);
  } catch (error) {
    fail(`${source}: ${error.message}`);
  }
  if (!isMap(doc)) fail(`${source}: local file must be a map.`);
  assertOnlyKeys(doc, LOCAL_KEYS, 'local file', source);
  if (doc.version !== PLAN_VERSION) fail(`${source}: version must be ${PLAN_VERSION}.`);
  const tools = {};
  if (doc.tools != null) {
    if (!isMap(doc.tools)) fail(`${source}: tools must be a map of tool name to launch template.`);
    for (const [name, raw] of Object.entries(doc.tools)) {
      if (!isMap(raw)) fail(`${source}: tools.${name} must be a map.`);
      assertOnlyKeys(raw, TOOL_KEYS, `tools.${name}`, source);
      const command = stringList(raw.command, `tools.${name}.command`, source);
      if (command.length === 0) fail(`${source}: tools.${name}.command must name the executable.`);
      if (raw.pretrust_worktrees != null && typeof raw.pretrust_worktrees !== 'boolean') {
        fail(`${source}: tools.${name}.pretrust_worktrees must be true or false.`);
      }
      tools[name] = { command, pretrustWorktrees: raw.pretrust_worktrees === true };
    }
  }
  const tool = doc.tool == null ? null : nonEmptyString(doc.tool, 'tool', source);
  if (tool != null && tools[tool] == null) fail(`${source}: tool ${JSON.stringify(tool)} is not declared under tools.`);
  return { version: PLAN_VERSION, parallel: parallelValue(doc.parallel, source), tool, tools };
}

// The project's budget wins; the local one is the fallback; no budget at all
// is an error, never a silent default.
export function resolveBudget({ plan, local, planFile, localFile }) {
  if (plan.parallel != null) return { parallel: plan.parallel, source: 'plan' };
  if (local?.parallel != null) return { parallel: local.parallel, source: 'local' };
  fail(`no budget: set parallel in ${planFile} or in ${localFile}.`);
}

// ----------------------------------------------------------------- claims

// Claims are compared by infra/lib/claims.mjs: the literal segments before
// the first wildcard, one a prefix of the other. Conservative on purpose.
function firstIntersection(owns, others) {
  for (const other of others) {
    for (const mine of owns) {
      for (const theirs of other.owns) {
        if (claimsIntersect(mine, theirs)) return { id: other.id, mine, theirs };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ state

// ------------------------------------------------------------- identity

// What makes a task this task: its text (whitespace aside), its claims,
// its dependencies and the exact results they handed in, its brief, its
// checks, and the repository. A seat carries the revision it was planned
// for; a done for another revision is somebody else's completion.
export function itemRevision(item, { inputs = {}, repository = null, brief = null } = {}) {
  const canonical = {
    task: item.task.replace(/\s+/g, ' ').trim(),
    brief,
    owns: [...item.owns].sort(),
    read_only: item.readOnly === true,
    depends_on: (item.dependencies ?? []).map((dependency) => `${dependency.id}:${dependency.needs}`).sort(),
    inputs: Object.fromEntries(Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right))),
    verify: item.verify ?? [],
    repository,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : String(sha);
}

// The result a done row hands to the items that depend on it, and whether
// it is verified: evidence with every check at exit 0.
function verificationOf(result, integration) {
  if (result == null) return null;
  if (integration != null) return 'accepted';
  if (result.evidence == null || result.evidence.checks.length === 0) return 'unverified';
  return result.evidence.checks.every((check) => check.exit === 0) ? 'verified' : 'failing';
}

// What the baseline repository says, read once by loadForester and handed
// in so this stays a function of its inputs: the baseline head, whether a
// commit is an ancestor of it, and a worktree's current head.
export const NOTHING_OBSERVED = Object.freeze({ head: null, contains: () => false, headOf: () => null });

// ------------------------------------------------------------------ state

// One row per item. `state` is the live Dryad registry, `finished` the
// archive, `observed` the baseline's git facts. Dependencies resolve first,
// because an item's revision includes the results it starts from.
//
//   done     a seat for this revision reported done, live or archived
//   active   a live seat exists (or reported done and then moved)
//   waiting  every dependency reported done; a result is not yet in the baseline
//   failed   as many finished seats for this revision as max_attempts, none done
//   blocked  a dependency is not done
//   ready    everything else
export function itemStates({ plan, state, finished, observed = NOTHING_OBSERVED, repository = null, briefs = {} }) {
  const byId = new Map(plan.tasks.map((item) => [item.id, item]));
  const rows = new Map();
  const resolve = (id) => {
    if (rows.has(id)) return rows.get(id);
    const item = byId.get(id);
    const dependencies = item.dependencies.map((dependency) => ({ ...dependency, row: resolve(dependency.id) }));
    const blocked = [];
    const waiting = [];
    const via = [];
    const inputs = {};
    for (const dependency of dependencies) {
      const { row } = dependency;
      if (row.state !== 'done') {
        blocked.push(dependency.id);
        continue;
      }
      if (dependency.needs === 'order') continue;
      const result = row.result;
      if (result == null) {
        waiting.push(`${dependency.id} reported done with no result recorded; report it done again`);
      } else if (result.clean !== true) {
        waiting.push(`${dependency.id} reported done with uncommitted changes at ${short(result.head)}; commit and report again`);
      } else if (observed.contains(result.head)) {
        inputs[dependency.id] = result.head;
      } else if (row.integration != null && observed.contains(row.integration.commit)) {
        inputs[dependency.id] = result.head;
        via.push(`${dependency.id} integrated as ${short(row.integration.commit)}`);
      } else {
        waiting.push(`${dependency.id} done at ${short(result.head)} is not in baseline HEAD${observed.head ? ` ${short(observed.head)}` : ''}; merge it, or record dryad integrate ${dependency.id} --commit <sha>`);
      }
    }
    const revision = itemRevision(item, { inputs, repository, brief: briefs[id] ?? null });
    const seat = state.seats[id] ?? null;
    const archived = finished.seats.filter((record) => record.id === id);
    // A finished seat without done spends an attempt when it was for this
    // revision, or was planned by hand without one; another revision's
    // attempts are another task's.
    const attempts = archived.filter((record) => record.status !== 'done' && (record.revision == null || record.revision === revision)).length;
    const row = { ...item, revision, inputs, attempts, result: null, integration: null, note: null, seat: seat == null ? null : { id, status: seat.status, worktree: seat.worktree, env: seat.env, revision: seat.revision ?? null, attempt: seat.attempt ?? null } };
    if (seat != null) {
      if (seat.revision != null && seat.revision !== revision) {
        row.state = 'active';
        row.why = `seat ${seat.status} for revision ${seat.revision}; the plan is now ${revision}; finish that seat`;
      } else if (seat.status === 'done' && seat.result == null) {
        row.state = 'done';
        row.why = 'seat reported done (no result recorded)';
      } else if (seat.status === 'done') {
        const head = observed.headOf(seat.worktree);
        if (head != null && head !== seat.result.head) {
          row.state = 'active';
          row.why = `reported done at ${short(seat.result.head)} but the worktree moved to ${short(head)}; report again`;
        } else {
          row.state = 'done';
          row.why = `seat reported done${seat.revision == null ? ' (no revision)' : ''}`;
          row.result = seat.result;
          row.integration = seat.integration ?? null;
        }
      } else {
        row.state = 'active';
        row.why = `seat ${seat.status}`;
      }
    } else {
      const dones = archived.filter((record) => record.status === 'done');
      const match = dones.filter((record) => record.revision === revision).at(-1) ?? null;
      const last = dones.at(-1) ?? null;
      if (match != null) {
        row.state = 'done';
        row.why = 'finished';
        row.result = match.result ?? null;
        row.integration = match.integration ?? null;
      } else if (last != null) {
        row.note = last.revision == null
          ? `archived done for ${id} has no revision (planned before revisions) and is not reused`
          : `archived done is for revision ${last.revision}, not ${revision}`;
      }
      if (row.state == null && attempts >= item.retry.maxAttempts) {
        row.state = 'failed';
        row.why = `${attempts}/${item.retry.maxAttempts} attempt${attempts === 1 ? '' : 's'} finished without done`;
      } else if (row.state == null && blocked.length > 0) {
        row.state = 'blocked';
        row.why = `waits for ${blocked.join(', ')}`;
      } else if (row.state == null && waiting.length > 0) {
        row.state = 'waiting';
        row.why = waiting.join('; ');
      } else if (row.state == null) {
        row.state = 'ready';
        row.why = dependencies.length === 0 ? 'no dependencies' : `${dependencies.map((dependency) => dependency.id).join(', ')} done${Object.keys(inputs).length > 0 ? ' and in the baseline' : ''}${via.length > 0 ? ` (${via.join(', ')})` : ''}`;
      }
      if (row.note != null) row.why = `${row.why}; ${row.note}`;
    }
    row.verification = verificationOf(row.result, row.integration);
    rows.set(id, row);
    return row;
  };
  for (const item of plan.tasks) resolve(item.id);
  return plan.tasks.map((item) => rows.get(item.id));
}

// Walk the ready items in declared order; skip one whose claims intersect an
// active or already chosen item's; stop when active reaches parallel.
export function allocate({ items, budget }) {
  const active = items.filter((item) => item.state === 'active');
  const chosen = [];
  const held = [];
  for (const item of items) {
    if (item.state !== 'ready') continue;
    if (active.length + chosen.length >= budget.parallel) {
      held.push({ id: item.id, reason: `budget full (${budget.parallel})` });
      continue;
    }
    const hit = firstIntersection(item.owns, [...active, ...chosen]);
    if (hit != null) {
      const other = items.find((row) => row.id === hit.id);
      held.push({ id: item.id, reason: `claim ${hit.mine} intersects ${hit.theirs} of ${hit.id} (${other.state})` });
      continue;
    }
    chosen.push(item);
  }
  return { active: active.length, free: Math.max(0, budget.parallel - active.length), chosen, held };
}

// ---------------------------------------------------------------- git

function git(args, cwd) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

// The baseline's facts, read once per load and memoized: its head, its
// root commit (the repository's identity), ancestry, and worktree heads.
export function observeRepository(root) {
  const headResult = git(['rev-parse', 'HEAD'], root);
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const roots = git(['rev-list', '--max-parents=0', 'HEAD'], root);
  const repository = roots.status === 0 ? roots.stdout.split('\n').filter(Boolean).sort()[0] ?? null : null;
  const ancestry = new Map();
  return {
    head,
    repository,
    contains(sha) {
      if (typeof sha !== 'string' || head == null) return false;
      if (!ancestry.has(sha)) ancestry.set(sha, git(['merge-base', '--is-ancestor', sha, 'HEAD'], root).status === 0);
      return ancestry.get(sha);
    },
    headOf(worktree) {
      if (typeof worktree !== 'string' || !existsSync(worktree)) return null;
      const result = git(['rev-parse', 'HEAD'], worktree);
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

// ---------------------------------------------------------------- project

// Each item's brief, read from the baseline and digested, so the seat gets
// the text as it was when seated and the revision names it.
function readBriefs(plan, root) {
  const briefs = {};
  for (const item of plan.tasks) {
    if (item.brief == null) continue;
    const file = path.resolve(root, item.brief);
    if (!file.startsWith(`${root}${path.sep}`)) fail(`tasks.${item.id}.brief must be inside the baseline checkout (got ${item.brief}).`);
    if (!existsSync(file)) fail(`tasks.${item.id}.brief not found: ${file}`);
    const text = readFileSync(file, 'utf8');
    if (text.trim().length === 0) fail(`tasks.${item.id}.brief is empty: ${file}`);
    briefs[item.id] = { path: item.brief, text, digest: createHash('sha256').update(text).digest('hex') };
  }
  return briefs;
}

export function loadForester({ project = null, environment = process.env, cwd = process.cwd() }) {
  const location = resolveDryadProject({ project, environment, cwd });
  const dryad = loadDryadProject(location);
  const planFile = path.join(dryad.root, PLAN_RELPATH);
  const localFile = path.join(dryad.root, LOCAL_RELPATH);
  if (!existsSync(planFile)) fail(`plan not found: ${planFile}`);
  const plan = parseForesterPlan(readFileSync(planFile, 'utf8'), planFile);
  const local = existsSync(localFile) ? parseForesterLocal(readFileSync(localFile, 'utf8'), localFile) : null;
  const budget = resolveBudget({ plan, local, planFile, localFile });
  const sessions = readSessions(dryad.slug, environment);
  const { state } = readDryadState(dryad.slug, environment);
  const finished = readDryadFinished(dryad.slug, environment);
  const observed = observeRepository(dryad.root);
  const briefs = readBriefs(plan, dryad.root);
  const items = itemStates({
    plan,
    state,
    finished,
    observed,
    repository: observed.repository,
    briefs: Object.fromEntries(Object.entries(briefs).map(([id, brief]) => [id, brief.digest])),
  });
  const allocation = allocate({ items, budget });
  // Seats the plan does not name are somebody else's work on the same
  // project. They take no slot, because the budget counts items, but they
  // are shown so the count of what is moving is honest.
  const planned = new Set(plan.tasks.map((item) => item.id));
  const outside = Object.keys(state.seats).filter((id) => !planned.has(id));
  return { project: dryad, planFile, localFile, plan, local, budget, items, allocation, outside, sessions, observed, briefs };
}

// ---------------------------------------------------------------- handoff

// The text a seat is given: everything a worker in a fresh context needs
// to start, and nothing the seat, the skill, or the repository already
// says. The brief is copied with its path and digest so the copy names its
// source; the source stays the one place to edit.
export function renderHandoff({ item, project, observed, briefs }) {
  const brief = briefs[item.id] ?? null;
  const lines = [
    `# ${item.id}: ${item.task}`,
    '',
    `Forester handoff · item ${item.id} · revision ${item.revision}`,
    `Base: ${observed.head ?? 'unknown'} (baseline HEAD when seated)`,
    `Scope: ${item.readOnly ? 'read-only; change nothing' : item.owns.length > 0 ? `edit only ${item.owns.join(', ')}` : 'unchecked (the plan claims nothing)'}`,
  ];
  if (item.dependencies.length > 0) {
    lines.push('Depends on:');
    for (const dependency of item.dependencies) {
      const input = item.inputs[dependency.id];
      lines.push(`  - ${dependency.id}: ${dependency.needs === 'order' ? 'reported done; nothing of it is promised in your base' : `result ${input} is in your base`}`);
    }
  }
  if (item.verify.length > 0) {
    lines.push('Verify, and record each in the evidence file:');
    for (const command of item.verify) lines.push(`  - ${command}`);
  }
  lines.push(
    `Report: de-novo skills dryad report ${item.id} --status done --evidence <file> after committing on your branch; the rules are in $DRYAD_SKILL under "Rules for a seated worker".`,
  );
  if (brief != null) {
    lines.push('', `Brief (${brief.path}, sha256:${brief.digest.slice(0, 12)}):`, '', brief.text.trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

function seatArguments(item, loaded) {
  const args = ['plan', item.id, '--task', renderHandoff({ item, project: loaded.project, observed: loaded.observed, briefs: loaded.briefs }), '--by', 'forester', '--revision', item.revision];
  if (item.readOnly) args.push('--read-only');
  for (const claim of item.owns) args.push('--owns', claim);
  for (const [id, sha] of Object.entries(item.inputs)) args.push('--input', `${id}=${sha}`);
  args.push('--project', loaded.project.root, '--apply');
  return args;
}

function counts(items) {
  const out = {};
  for (const name of ITEM_STATES) out[name] = items.filter((item) => item.state === name).length;
  return out;
}

export function foresterJson(loaded) {
  const { project, budget, items, allocation } = loaded;
  return {
    project: project.slug,
    budget,
    counts: counts(items),
    items: items.map((item) => ({
      id: item.id,
      state: item.state,
      why: item.why,
      task: item.task,
      brief: item.brief,
      owns: item.owns,
      read_only: item.readOnly,
      depends_on: item.dependsOn,
      needs: Object.fromEntries(item.dependencies.map((dependency) => [dependency.id, dependency.needs])),
      verify: item.verify,
      tool: item.tool,
      revision: item.revision,
      inputs: item.inputs,
      attempts: item.attempts,
      max_attempts: item.retry.maxAttempts,
      result: item.result,
      integration: item.integration,
      verification: item.verification,
      seat: item.seat,
      session: loaded.sessions?.seats?.[item.id] ?? null,
    })),
    next: allocation.chosen.map((item) => item.id),
    held: allocation.held,
    slots: { active: allocation.active, free: allocation.free, parallel: budget.parallel },
    seats_outside_plan: loaded.outside,
    serve: loaded.sessions == null ? null : { pid: loaded.sessions.pid, alive: loaded.sessions.alive, socket: loaded.sessions.socket },
  };
}

// -------------------------------------------------------------------- cli

const VERBS = Object.freeze({
  plan: { flags: ['json'], options: ['project'] },
  next: { flags: ['json'], options: ['project'] },
  assign: { flags: ['apply', 'json'], options: ['project'] },
  status: { flags: ['json', 'watch'], options: ['project'] },
  serve: { flags: [], options: ['project'] },
  attach: { flags: [], options: ['project'], positional: 'seat id' },
  restart: { flags: [], options: ['project'], positional: 'seat id' },
  hooks: { flags: ['apply', 'remove', 'json'], options: [] },
});

export function parseForesterCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!(verb in VERBS)) fail(`unknown command ${JSON.stringify(verb)}.`);
  const spec = VERBS[verb];
  const options = { help: false, verb, project: null, json: false, watch: false, apply: false, remove: false, id: null };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (!arg.startsWith('--')) {
      if (spec.positional == null) fail(`${verb} takes no positional arguments.`);
      if (options.id != null) fail(`${verb} takes one ${spec.positional}.`);
      options.id = assertSeatId(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.flags.includes(name)) {
      if (options[name]) fail(`--${name} may be passed only once.`);
      options[name] = true;
      continue;
    }
    if (spec.options.includes(name)) {
      if (options[name] != null) fail(`--${name} may be passed only once.`);
      const value = input[index + 1];
      if (value == null || value.startsWith('--')) fail(`--${name} requires a value.`);
      options[name] = value;
      index += 1;
      continue;
    }
    fail(`--${name} is not valid for ${verb}.`);
  }
  if (spec.positional != null && options.id == null) fail(`${verb} requires a ${spec.positional}.`);
  return options;
}

function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function countsLine(items) {
  const c = counts(items);
  return `items ${items.length} · done ${c.done} · active ${c.active} · ready ${c.ready} · waiting ${c.waiting} · blocked ${c.blocked} · failed ${c.failed}`;
}

export { seatArguments };

function runPlanVerb(loaded, options) {
  if (options.json) {
    console.log(JSON.stringify(foresterJson(loaded), null, 2));
    return 0;
  }
  const { project, budget, items } = loaded;
  const width = Math.max(...items.map((item) => item.id.length));
  const lines = [`■ ${project.slug} — forester plan (parallel ${budget.parallel} from ${budget.source})`];
  for (const item of items) {
    lines.push(`  ${pad(item.id, width)}  ${pad(item.state, 7)}  ${item.why}`);
  }
  lines.push(`  ${countsLine(items)}`);
  console.log(lines.join('\n'));
  return 0;
}

function nextLines(loaded) {
  const { allocation, items } = loaded;
  const width = Math.max(...items.map((item) => item.id.length));
  const lines = [];
  for (const item of allocation.chosen) {
    lines.push(`  assign  ${pad(item.id, width)}  ${item.owns.length > 0 ? `owns ${item.owns.join(' ')}` : 'owns nothing'}`);
  }
  for (const hold of allocation.held) {
    lines.push(`  hold    ${pad(hold.id, width)}  ${hold.reason}`);
  }
  return lines;
}

function runNextVerb(loaded, options) {
  if (options.json) {
    console.log(JSON.stringify(foresterJson(loaded), null, 2));
    return 0;
  }
  const { project, budget, allocation } = loaded;
  const lines = [
    `■ ${project.slug} — forester next (parallel ${budget.parallel} · active ${allocation.active} · free ${allocation.free})`,
    ...nextLines(loaded),
    `  would assign ${allocation.chosen.length}/${allocation.free}; changes nothing`,
  ];
  console.log(lines.join('\n'));
  return 0;
}

function runAssignVerb(loaded, options, environment, cwd) {
  const { project, budget, allocation } = loaded;
  if (!options.apply) {
    if (options.json) {
      console.log(JSON.stringify(foresterJson(loaded), null, 2));
      return 0;
    }
    console.log(
      [
        `■ ${project.slug} — forester assign (parallel ${budget.parallel} · active ${allocation.active} · free ${allocation.free})`,
        ...nextLines(loaded),
        `  apply     nothing created; rerun with --apply`,
      ].join('\n')
    );
    return 0;
  }
  let assigned = 0;
  const failures = [];
  for (const item of allocation.chosen) {
    const args = seatArguments(item, loaded);
    let code;
    try {
      code = runDryad({ options: parseDryadCliArgs(args), environment, cwd });
    } catch (error) {
      console.error(error.message);
      code = 1;
    }
    if (code === 0) assigned += 1;
    else failures.push(item.id);
  }
  const after = loadForester({ project: project.root, environment, cwd });
  const summary = `assigned ${assigned}/${allocation.chosen.length} · slots ${after.allocation.active}/${budget.parallel}`;
  if (options.json) {
    console.log(JSON.stringify({ ...foresterJson(after), assigned, failed: failures }, null, 2));
  } else {
    console.log(`  ${summary}${failures.length > 0 ? ` · failed ${failures.join(', ')}` : ''}`);
  }
  return failures.length === 0 ? 0 : 1;
}

// The serve snapshot, when a daemon holds sessions for this project. Read
// only; the daemon owns the file. `alive` is whether that daemon's pid is
// still there: a stale snapshot is shown as such, never as running sessions.
export function sessionsPath(slug, environment = process.env) {
  return path.join(path.dirname(dryadStateDirectory(environment)), 'foresters', `${slug}.yml`);
}

export function readSessions(slug, environment = process.env) {
  const file = sessionsPath(slug, environment);
  if (!existsSync(file)) return null;
  let doc;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isMap(doc) || !isMap(doc.seats)) return null;
  let alive = false;
  try {
    process.kill(doc.pid, 0);
    alive = true;
  } catch (error) {
    alive = error.code === 'EPERM';
  }
  return { file, pid: doc.pid, socket: doc.socket, alive, seats: doc.seats };
}

// "3s", "2m", "1h": how long ago an ISO moment was, for a reader's eye.
export function ageOf(iso, at = Date.now()) {
  const seconds = Math.max(0, Math.round((at - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function sessionLines(loaded) {
  const sessions = loaded.sessions;
  if (sessions == null) return ['  serve    none'];
  if (!sessions.alive) return [`  serve    stale snapshot from pid ${sessions.pid}; no daemon`];
  const rows = Object.entries(sessions.seats);
  const lines = [`  serve    pid ${sessions.pid} · sessions ${rows.length}`];
  for (const [id, session] of rows) {
    const doing = session.doing == null ? '' : `  · ${session.doing}${session.doing_since ? ` (${ageOf(session.doing_since)})` : ''}`;
    const failure = session.failure == null ? '' : `  · ${session.failure.kind}: ${session.failure.note}`;
    lines.push(`    ${id}  ${session.tool}  ${session.state}${session.exit != null ? ' ' + session.exit : ''}${doing}${failure}`);
  }
  return lines;
}

function runStatusVerb(loaded, options) {
  const { project, budget, items, allocation } = loaded;
  const c = counts(items);
  if (options.json) {
    console.log(JSON.stringify(foresterJson(loaded), null, 2));
  } else {
    console.log(
      [
        `■ ${project.slug} — forester (parallel ${budget.parallel} from ${budget.source})`,
        `  slots    ${allocation.active}/${budget.parallel}`,
        `  waiting  ${c.ready} ready · ${c.waiting} waiting for integration · ${c.blocked} blocked`,
        `  done     ${c.done}/${items.length}`,
        `  failed   ${c.failed}${c.failed > 0 ? '  ' + items.filter((item) => item.state === 'failed').map((item) => item.id).join(', ') : ''}`,
        `  outside  ${loaded.outside.length} seat${loaded.outside.length === 1 ? '' : 's'} not in the plan${loaded.outside.length > 0 ? '  ' + loaded.outside.join(', ') : ''}`,
        ...sessionLines(loaded),
      ].join('\n')
    );
  }
  return c.failed === 0 ? 0 : 1;
}

export async function runForester({ options, environment = process.env, cwd = process.cwd() }) {
  if (options.verb === 'hooks') {
    const { applyHooks, formatHooksReport } = await import('./forester-hooks.mjs');
    const rows = applyHooks({ environment, apply: options.apply, remove: options.remove });
    console.log(options.json ? JSON.stringify(rows, null, 2) : formatHooksReport(rows, options));
    return 0;
  }
  if (options.verb === 'serve' || options.verb === 'attach' || options.verb === 'restart') {
    const { runAttach, runRestart, runServe } = await import('./forester-serve.mjs');
    if (options.verb === 'serve') return runServe({ options, environment, cwd });
    if (options.verb === 'restart') return runRestart({ options, environment, cwd });
    return runAttach({ options, environment, cwd });
  }
  if (options.verb === 'status' && options.watch) {
    if (options.json) fail('--watch prints the text form; drop --json.');
    // One screen, redrawn every two seconds: state, what each session is
    // doing, and the reports, without a browser. Ctrl-C ends it.
    for (;;) {
      process.stdout.write('\x1b[2J\x1b[H');
      runStatusVerb(loadForester({ project: options.project, environment, cwd }), options);
      console.log(`  ${new Date().toISOString()} · every 2s · Ctrl-C to stop`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  const loaded = loadForester({ project: options.project, environment, cwd });
  switch (options.verb) {
    case 'plan':
      return runPlanVerb(loaded, options);
    case 'next':
      return runNextVerb(loaded, options);
    case 'assign':
      return runAssignVerb(loaded, options, environment, cwd);
    case 'status':
      return runStatusVerb(loaded, options);
    default:
      fail(`unsupported command ${JSON.stringify(options.verb)}.`);
  }
}

export function foresterHelp(cli = 'de-novo skills') {
  return `analyse the work into a plan, keep this machine's slots full (allocation through Dryad seats)

usage:
  ${cli} forester plan   [--json] [--project ROOT]   every item: done, active, ready, blocked, failed, and why
  ${cli} forester next   [--json] [--project ROOT]   what assign would seat now; changes nothing
  ${cli} forester assign [--apply] [--json] [--project ROOT]
  ${cli} forester status [--json | --watch] [--project ROOT]   slots filled, items waiting, live sessions and what each is doing; --watch redraws every 2s
  ${cli} forester serve  [--project ROOT]            keep the budget filled and hold each seat's real session (foreground)
  ${cli} forester attach ID [--project ROOT]         view and type into one session; Ctrl-] detaches
  ${cli} forester restart ID [--project ROOT]        drop a failed or exited session so serve launches it again
  ${cli} forester hooks  [--apply | --remove --apply] [--json]   one marked entry in each installed tool's hook store

The plan is ${PLAN_RELPATH}: items with a task line, the paths each expects
to own, what it depends on, and how many attempts it gets. The budget is the
plan's own parallel when it sets one, else parallel in ${LOCAL_RELPATH}
(machine-local, never committed); no budget anywhere is an error. assign
walks the ready items in declared order, skips one whose claims intersect an
active item's, stops at the budget, and with --apply seats each chosen item
as the Dryad seat of the same id. Done is the seat's own done report, live or
finished; a seat finished without one spends an attempt. Rerun assign after a
worker reports done to fill the freed slot.

serve does that refill on its own and starts each seated item's tool as a
real interactive session in a pseudo-terminal it holds: the tool named by
the item or by tool in the local file, launched from tools.<name>.command
with {task} replaced by the seat's handoff. Before a launch serve checks
the tool is declared and on PATH, the worktree exists, and the overlay
env is not pending; a failed check is a failed session naming its kind,
a pending env is planned again with backoff, and restart drops a failed
or exited session so the next poll launches it again. Claude Code
sessions get their hooks through --settings; the hooks write the
session's state (running, idle, needs-input) to a file status reads. No
trust is granted unless tools.<name>.pretrust_worktrees is set. A session
is closed when its seat reports done. One serve per project: a second
start stops at the lock. serve needs @lydell/node-pty, an optional
dependency; nothing else does.

hooks installs one marked entry per event in the hook store of every tool
found on this machine (codex, grok, cursor-agent, opencode), each gated on
FORESTER_EVENTS so it does nothing outside a serve session; --remove takes
exactly those entries back. Claude Code needs none: serve hands it a
per-session --settings file.`;
}
