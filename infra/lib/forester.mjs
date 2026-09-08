// de-novo Forester — analyse the work into a plan, keep this machine's slots
// full. The plan is a tracked file; the budget is the plan's own `parallel`
// or, when the plan sets none, the untracked local file's. Allocation is a
// pure function of the plan, the Dryad seats, and the budget: no model call,
// no daemon, the same inputs give the same assignment.
//
// Values live in the consuming project:
//   .agents/forester-plan.yml    the items (tracked)
//   .agents/forester.local.yml   this machine's budget (gitignored)
// Pattern lives in skills/forester/SKILL.md. Fields in skills/forester/README.md.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

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

export const PLAN_RELPATH = '.agents/forester-plan.yml';
export const LOCAL_RELPATH = '.agents/forester.local.yml';
const PLAN_VERSION = 1;
const PLAN_KEYS = Object.freeze(['version', 'parallel', 'tasks']);
const TASK_KEYS = Object.freeze(['task', 'owns', 'depends_on', 'tool', 'retry']);
const RETRY_KEYS = Object.freeze(['max_attempts']);
const LOCAL_KEYS = Object.freeze(['version', 'parallel', 'tool', 'tools']);
const TOOL_KEYS = Object.freeze(['command']);
export const ITEM_STATES = Object.freeze(['done', 'active', 'failed', 'blocked', 'ready']);

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
    const item = {
      id,
      task: nonEmptyString(raw.task, `tasks.${id}.task`, source),
      owns: stringList(raw.owns, `tasks.${id}.owns`, source),
      dependsOn: stringList(raw.depends_on, `tasks.${id}.depends_on`, source),
      tool: raw.tool == null ? null : nonEmptyString(raw.tool, `tasks.${id}.tool`, source),
      retry: { maxAttempts: 1 },
    };
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
      tools[name] = { command };
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

// A claim is a path or a glob. Its literal part is the path segments before
// the first wildcard; two claims intersect when one literal part is a prefix
// of the other, segment by segment. Conservative on purpose: a claim that
// wildcards a directory early intersects everything beneath it.
export function claimSegments(pattern) {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const wildcard = clean.search(/[*?[{]/);
  const literal = wildcard === -1 ? clean : clean.slice(0, clean.lastIndexOf('/', wildcard) + 1);
  return literal.split('/').filter((segment) => segment.length > 0);
}

export function claimsIntersect(a, b) {
  const left = claimSegments(a);
  const right = claimSegments(b);
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

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

// One row per item. `state` is the live Dryad registry, `finished` the
// archive. An item is done when its seat reported done, live or archived;
// active while it has a live seat; failed when every allowed attempt was
// finished without done; blocked while a dependency is not done; else ready.
export function itemStates({ plan, state, finished }) {
  const rows = new Map();
  for (const item of plan.tasks) {
    const seat = state.seats[item.id] ?? null;
    const archived = finished.seats.filter((record) => record.id === item.id);
    const attempts = archived.filter((record) => record.status !== 'done').length;
    let row;
    if (seat != null && seat.status === 'done') {
      row = { state: 'done', why: 'seat reported done' };
    } else if (seat != null) {
      row = { state: 'active', why: `seat ${seat.status}` };
    } else if (archived.some((record) => record.status === 'done')) {
      row = { state: 'done', why: 'finished' };
    } else if (attempts >= item.retry.maxAttempts) {
      row = { state: 'failed', why: `${attempts}/${item.retry.maxAttempts} attempt${attempts === 1 ? '' : 's'} finished without done` };
    } else {
      row = null;
    }
    rows.set(item.id, { ...item, attempts, seat: seat == null ? null : { id: item.id, status: seat.status, worktree: seat.worktree, env: seat.env }, ...(row ?? {}) });
  }
  for (const item of plan.tasks) {
    const row = rows.get(item.id);
    if (row.state != null) continue;
    const waiting = item.dependsOn.filter((dep) => rows.get(dep).state !== 'done');
    if (waiting.length > 0) {
      row.state = 'blocked';
      row.why = `waits for ${waiting.join(', ')}`;
    } else {
      row.state = 'ready';
      row.why = item.dependsOn.length === 0 ? 'no dependencies' : `${item.dependsOn.join(', ')} done`;
    }
  }
  return [...rows.values()];
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

// ---------------------------------------------------------------- project

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
  const items = itemStates({ plan, state, finished });
  const allocation = allocate({ items, budget });
  // Seats the plan does not name are somebody else's work on the same
  // project. They take no slot, because the budget counts items, but they
  // are shown so the count of what is moving is honest.
  const planned = new Set(plan.tasks.map((item) => item.id));
  const outside = Object.keys(state.seats).filter((id) => !planned.has(id));
  return { project: dryad, planFile, localFile, plan, local, budget, items, allocation, outside, sessions };
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
      owns: item.owns,
      depends_on: item.dependsOn,
      tool: item.tool,
      attempts: item.attempts,
      max_attempts: item.retry.maxAttempts,
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
  status: { flags: ['json'], options: ['project'] },
  serve: { flags: [], options: ['project'] },
  attach: { flags: [], options: ['project'], positional: 'seat id' },
  hooks: { flags: ['apply', 'remove', 'json'], options: [] },
});

export function parseForesterCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!(verb in VERBS)) fail(`unknown command ${JSON.stringify(verb)}.`);
  const spec = VERBS[verb];
  const options = { help: false, verb, project: null, json: false, apply: false, remove: false, id: null };
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
  return `items ${items.length} · done ${c.done} · active ${c.active} · ready ${c.ready} · blocked ${c.blocked} · failed ${c.failed}`;
}

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
    const args = ['plan', item.id, '--task', item.task, '--by', 'forester', '--project', project.root, '--apply'];
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

function sessionLines(loaded) {
  const sessions = loaded.sessions;
  if (sessions == null) return ['  serve    none'];
  if (!sessions.alive) return [`  serve    stale snapshot from pid ${sessions.pid}; no daemon`];
  const rows = Object.entries(sessions.seats);
  const lines = [`  serve    pid ${sessions.pid} · sessions ${rows.length}`];
  for (const [id, session] of rows) {
    lines.push(`    ${id}  ${session.tool}  ${session.state}${session.exit != null ? ' ' + session.exit : ''}`);
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
        `  waiting  ${c.ready} ready · ${c.blocked} blocked`,
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
  if (options.verb === 'serve' || options.verb === 'attach') {
    const { runAttach, runServe } = await import('./forester-serve.mjs');
    return options.verb === 'serve' ? runServe({ options, environment, cwd }) : runAttach({ options, environment, cwd });
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
  ${cli} forester status [--json] [--project ROOT]   slots filled, items waiting, live sessions
  ${cli} forester serve  [--project ROOT]            keep the budget filled and hold each seat's real session (foreground)
  ${cli} forester attach ID [--project ROOT]         view and type into one session; Ctrl-] detaches
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
with {task} replaced. Claude Code sessions get their hooks through
--settings and their worktree pre-trusted; the hooks write the session's
state (running, idle, needs-input) to a file status reads. A session is
closed when its seat reports done. serve needs @lydell/node-pty, an
optional dependency; nothing else does.

hooks installs one marked entry per event in the hook store of every tool
found on this machine (codex, grok, cursor-agent, opencode), each gated on
FORESTER_EVENTS so it does nothing outside a serve session; --remove takes
exactly those entries back. Claude Code needs none: serve hands it a
per-session --settings file.`;
}
