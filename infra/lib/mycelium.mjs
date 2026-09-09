// de-novo Mycelium — the facts under the forest. One append-only log per
// project holds every assertion a worker proposed, every promotion, and
// every invalidation; the graph is the fold of that log. This module owns
// the envelope, the values-file whitelist, the three transitions, and the
// point-in-time query. It never decides what is true: propose is any
// worker's, commit and invalidate are a person's or the judge's.
//
//   .agents/mycelium.yml               the project's domains, entity types, predicates, and judges (tracked)
//   <state>/mycelium/<slug>.jsonl      the log (machine-local, like Dryad's registry)
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { acquireStateLock, loadDryadProject, readDryadFinished, readDryadState, resolveDryadProject } from './dryad.mjs';

export const VALUES_RELPATH = '.agents/mycelium.yml';
export const LOG_VERSION = 1;
export const STATUSES = Object.freeze(['staging', 'active', 'invalid']);
export const CARDINALITIES = Object.freeze(['one', 'many']);
// The predicate --from-seat writes. Always declared, many: a seat reports
// more than once. A values file may not redeclare it.
export const REPORTED = 'reported';
// A log write waits for the lock rather than giving up: twelve seats
// proposing at once on a loaded machine is the normal case, not a fault.
// One CI run saw a proposer time out at two seconds.
const LOCK_WAIT_MS = 15000;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
// A writer id: seat:<id>, human:<name>, agent:<name>, or any short handle.
const WRITER = /^[a-z0-9][a-z0-9._:@-]{0,78}$/;
const DEFAULT_CONFIDENCE = 0.5;

function fail(message) {
  throw new Error(`mycelium: ${message}`);
}

function now() {
  return new Date().toISOString();
}

function isoOrFail(value, what) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${what} must be an ISO-8601 date-time, got ${JSON.stringify(value)}.`);
  return new Date(value).toISOString();
}

// --------------------------------------------------------------- values

// The project's whitelist. A domain or a type the file does not name is
// rejected at propose, so the graph cannot grow a vocabulary nobody chose.
// judges, when named, are the only writers commit and invalidate accept;
// absent, any named writer may. Identity is declared, not authenticated.
export function parseMyceliumValues(yamlText, source = 'mycelium.yml') {
  const doc = parse(yamlText);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`${source}: expected a mapping.`);
  const known = new Set(['version', 'domains', 'types', 'predicates', 'judges']);
  for (const key of Object.keys(doc)) if (!known.has(key)) fail(`${source}: unknown key "${key}"; allowed: version, domains, types, predicates, judges.`);
  if (doc.version !== 1) fail(`${source}: version must be 1.`);
  const list = (name, pattern, what) => {
    const value = doc[name];
    if (!Array.isArray(value) || value.length === 0) fail(`${source}: ${name} must be a non-empty list.`);
    for (const entry of value) if (typeof entry !== 'string' || !pattern.test(entry)) fail(`${source}: ${name} entry ${JSON.stringify(entry)} must be ${what}.`);
    if (new Set(value).size !== value.length) fail(`${source}: ${name} has a duplicate.`);
    return value;
  };
  // predicates: a map of name → one|many. one: a subject holds a single
  // object at a time, so a second object is a conflict. many: another edge.
  const predicates = doc.predicates;
  if (!predicates || typeof predicates !== 'object' || Array.isArray(predicates) || Object.keys(predicates).length === 0) {
    fail(`${source}: predicates must be a non-empty map of name: one|many.`);
  }
  for (const [name, value] of Object.entries(predicates)) {
    if (!TOKEN.test(name)) fail(`${source}: predicate ${JSON.stringify(name)} must be a lower-case token.`);
    if (name === REPORTED) fail(`${source}: predicate "${REPORTED}" is built in (many) and may not be redeclared.`);
    if (!CARDINALITIES.includes(value)) fail(`${source}: predicate ${name} must be one or many, got ${JSON.stringify(value)}.`);
  }
  return {
    version: 1,
    domains: list('domains', TOKEN, 'a lower-case token'),
    types: list('types', TOKEN, 'a lower-case token'),
    predicates: { ...predicates, [REPORTED]: 'many' },
    judges: doc.judges == null ? null : list('judges', WRITER, 'a writer id such as human:name or seat:id'),
  };
}

export function assertWriter(value) {
  if (typeof value !== 'string' || !WRITER.test(value)) fail(`writer ${JSON.stringify(value)} must be a short id such as human:name, seat:id, or agent:name.`);
  return value;
}

export function assertJudge(values, who) {
  if (values.judges != null && !values.judges.includes(who)) {
    fail(`${who} is not a judge of this project (judges: ${values.judges.join(', ')}); propose or amend instead, and let a judge commit.`);
  }
  return who;
}

// ------------------------------------------------------------- envelope

// Every fact is one of these. s is always an entity (s_type named); o is
// an entity when o_type is named, otherwise a literal.
export function makeAssertion(input, values) {
  const out = {};
  const text = (name, { required = true } = {}) => {
    const value = input[name];
    if (value == null || value === '') {
      if (required) fail(`${name} is required.`);
      return null;
    }
    if (typeof value !== 'string') fail(`${name} must be a string.`);
    return value;
  };
  out.id = input.id ?? `a-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  out.s = text('s');
  out.p = text('p');
  if (!(out.p in values.predicates)) fail(`predicate ${JSON.stringify(out.p)} is not in ${VALUES_RELPATH} predicates (${Object.keys(values.predicates).join(', ')}).`);
  out.o = text('o');
  out.s_type = text('s_type');
  out.o_type = text('o_type', { required: false });
  for (const [name, type] of [['s_type', out.s_type], ['o_type', out.o_type]]) {
    if (type != null && !values.types.includes(type)) fail(`${name} ${JSON.stringify(type)} is not in ${VALUES_RELPATH} types (${values.types.join(', ')}).`);
  }
  out.domain = text('domain');
  if (!values.domains.includes(out.domain)) fail(`domain ${JSON.stringify(out.domain)} is not in ${VALUES_RELPATH} domains (${values.domains.join(', ')}).`);
  const confidence = input.confidence == null ? DEFAULT_CONFIDENCE : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail(`confidence must be a number from 0 to 1, got ${JSON.stringify(input.confidence)}.`);
  out.confidence = confidence;
  out.tx_at = input.tx_at ?? now();
  out.valid_from = input.valid_from == null ? out.tx_at : isoOrFail(input.valid_from, 'valid_from');
  out.valid_to = null;
  out.source = text('source');
  out.agent_id = assertWriter(text('agent_id'));
  out.model = text('model', { required: false });
  out.amends = text('amends', { required: false });
  out.status = 'staging';
  return out;
}

// A correction is a new assertion that names the one it replaces. Fields
// not overridden are copied, so the log shows exactly what changed. The
// original is closed when the correction is committed, not before.
export function amendment(assertions, id, overrides, values) {
  const target = assertions.get(id);
  if (!target) fail(`${id}: no such assertion.`);
  if (target.status === 'invalid') fail(`${id}: is invalid; propose a new fact instead of amending it.`);
  const changed = Object.entries(overrides).filter(([, value]) => value != null);
  // The writer is always set; it is not a change to the fact.
  if (!changed.some(([name]) => name !== 'agent_id')) fail(`amend ${id}: nothing to change; pass at least one field.`);
  const input = { ...target, ...Object.fromEntries(changed), id: undefined, tx_at: undefined, valid_to: undefined, status: undefined, amends: id };
  if (overrides.valid_from == null) input.valid_from = target.valid_from;
  return makeAssertion(input, values);
}

// ------------------------------------------------------------------ log

export function myceliumLogPath(slug, environment = process.env) {
  const override = environment.GROVE_STATE_DIR;
  const base = override != null ? path.resolve(override) : path.join(homedir(), '.dev-infra');
  if (override != null && override.length === 0) fail('GROVE_STATE_DIR must not be empty.');
  return path.join(base, 'mycelium', `${slug}.jsonl`);
}

export function readLog(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      fail(`${file}:${index + 1}: ${error.message}`);
    }
    if (event.v !== LOG_VERSION || typeof event.op !== 'string') fail(`${file}:${index + 1}: expected a version ${LOG_VERSION} event.`);
    return event;
  });
}

function appendEvent(file, event) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ v: LOG_VERSION, ...event }) + '\n');
}

// The graph is this fold and nothing else. Replaying the same log gives the
// same map, so a reader and a writer never disagree about what is active.
export function foldLog(events) {
  const assertions = new Map();
  for (const event of events) {
    switch (event.op) {
      case 'propose':
        // changed_at is the transaction time of the last line that touched
        // the row; --since reads it, so a change to an old fact is news.
        assertions.set(event.assertion.id, { ...event.assertion, changed_at: event.assertion.tx_at ?? event.at });
        break;
      case 'commit': {
        const target = assertions.get(event.id);
        if (target) {
          target.status = 'active';
          target.supersedes = event.supersedes ?? [];
          target.changed_at = event.at;
        }
        // A superseded fact stopped holding when its replacement began to
        // hold; an amended fact never held, so its interval is empty.
        for (const id of event.supersedes ?? []) {
          const old = assertions.get(id);
          if (!old) continue;
          const closeAt = target && target.valid_from >= old.valid_from ? target.valid_from : event.at;
          Object.assign(old, { status: 'invalid', valid_to: closeAt, invalid_reason: `superseded by ${event.id}`, changed_at: event.at });
        }
        if (event.amends != null) {
          const old = assertions.get(event.amends);
          if (old) Object.assign(old, { status: 'invalid', valid_to: old.valid_from, invalid_reason: `amended by ${event.id}`, changed_at: event.at });
        }
        break;
      }
      case 'invalidate': {
        const target = assertions.get(event.id);
        if (target) Object.assign(target, { status: 'invalid', valid_to: event.at, invalid_reason: event.reason, changed_at: event.at });
        break;
      }
      default:
        fail(`unknown log op ${JSON.stringify(event.op)}.`);
    }
  }
  return assertions;
}

// ---------------------------------------------------------- transitions

// Every write re-reads the log under the same file lock Dryad uses, so the
// check and the append are one step; two committers cannot both pass the
// conflict check on the same stale fold.
function withLog(file, fn) {
  const release = acquireStateLock(file, LOCK_WAIT_MS);
  try {
    const assertions = foldLog(readLog(file));
    return fn(assertions);
  } finally {
    release();
  }
}

export function propose({ file, assertion, by }) {
  withLog(file, () => appendEvent(file, { at: now(), op: 'propose', by, assertion }));
  return assertion;
}

// amend reads its target inside the lock so the copy is of the fact as it
// is at that instant, not as it was when the caller last looked.
export function proposeAmendment({ file, id, overrides, values, by }) {
  return withLog(file, (assertions) => {
    const assertion = amendment(assertions, id, overrides, values);
    appendEvent(file, { at: now(), op: 'propose', by, assertion });
    return assertion;
  });
}

// An active fact with the same domain, subject, and predicate but another
// object is a conflict when the predicate is declared one. It is refused
// unless the caller supersedes, which invalidates the older fact in the
// same event so no moment has both. For a many predicate a second object
// is another edge. The same object is a duplicate for both.
export function commitPlan({ assertions, id, values }) {
  const target = assertions.get(id);
  if (!target) fail(`${id}: no such assertion.`);
  if (target.status !== 'staging') fail(`${id}: is ${target.status}, only staging can be committed.`);
  const cardinality = values.predicates[target.p];
  if (cardinality == null) fail(`${id}: predicate ${JSON.stringify(target.p)} is no longer in ${VALUES_RELPATH} predicates; amend it or declare the predicate.`);
  const conflicts = [];
  const amends = target.amends != null && assertions.get(target.amends)?.status !== 'invalid' ? target.amends : null;
  for (const other of assertions.values()) {
    if (other.id === id || other.id === amends || other.status !== 'active') continue;
    if (other.domain !== target.domain || other.s !== target.s || other.p !== target.p) continue;
    if (other.o === target.o) fail(`${id}: ${other.id} already states ${target.s} ${target.p} ${target.o} in ${target.domain}.`);
    if (cardinality === 'one') conflicts.push(other.id);
  }
  return { target, conflicts, amends, cardinality };
}

export function commit({ file, values, id, by, supersede = false }) {
  return withLog(file, (assertions) => {
    const { target, conflicts, amends } = commitPlan({ assertions, id, values });
    if (conflicts.length > 0 && !supersede) {
      fail(`${id}: conflicts with active ${conflicts.join(', ')} on ${target.s} ${target.p} in ${target.domain}; pass --supersede to invalidate them, or invalidate ${id}.`);
    }
    appendEvent(file, { at: now(), op: 'commit', by, id, supersedes: conflicts, amends });
    return { target, superseded: conflicts, amended: amends };
  });
}

export function invalidate({ file, id, by, reason }) {
  return withLog(file, (assertions) => {
    const target = assertions.get(id);
    if (!target) fail(`${id}: no such assertion.`);
    if (target.status === 'invalid') fail(`${id}: is already invalid.`);
    if (typeof reason !== 'string' || reason.length === 0) fail('invalidate requires --reason.');
    appendEvent(file, { at: now(), op: 'invalidate', by, id, reason });
    return target;
  });
}

// ---------------------------------------------------------------- query

// Filters are exact matches. --at asks what was held true at that moment:
// valid_from <= at < valid_to, over facts that were committed, whether or
// not they have since been invalidated. Staging never answers --at.
export function query(assertions, filter = {}) {
  const at = filter.at == null ? null : isoOrFail(filter.at, '--at');
  const since = filter.since == null ? null : isoOrFail(filter.since, '--since');
  const rows = [];
  for (const row of assertions.values()) {
    if (at != null) {
      if (row.status === 'staging') continue;
      if (row.valid_from > at) continue;
      if (row.valid_to != null && row.valid_to <= at) continue;
    } else if (filter.status != null && row.status !== filter.status) {
      continue;
    }
    // --since is transaction time: what was written or changed after a
    // moment, whatever its validity, so a returning worker reads only the new.
    if (since != null && !((row.changed_at ?? row.tx_at) >= since)) continue;
    if (filter.s != null && row.s !== filter.s) continue;
    if (filter.p != null && row.p !== filter.p) continue;
    if (filter.o != null && row.o !== filter.o) continue;
    if (filter.domain != null && row.domain !== filter.domain) continue;
    if (filter.type != null && row.s_type !== filter.type && row.o_type !== filter.type) continue;
    if (filter.below != null && !(row.confidence < filter.below)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => (a.tx_at < b.tx_at ? -1 : a.tx_at > b.tx_at ? 1 : 0));
  return rows;
}

// The chain a fact belongs to: back through what it amends or supersedes,
// forward through what amended or superseded it. Ordered oldest first.
export function trace(assertions, id) {
  if (!assertions.has(id)) fail(`${id}: no such assertion.`);
  const seen = new Set();
  const back = (current) => {
    if (seen.has(current)) return;
    seen.add(current);
    const row = assertions.get(current);
    if (!row) return;
    for (const prior of [row.amends, ...(row.supersedes ?? [])].filter(Boolean)) back(prior);
  };
  const forward = (current) => {
    for (const row of assertions.values()) {
      if (seen.has(row.id)) continue;
      if (row.amends === current || (row.supersedes ?? []).includes(current)) {
        seen.add(row.id);
        forward(row.id);
      }
    }
  };
  back(id);
  for (const start of [...seen]) forward(start);
  const rows = [...seen].map((key) => assertions.get(key)).filter(Boolean);
  // Chain order, not clock order: a correction follows what it corrects
  // even when both were written in the same millisecond.
  const depth = new Map();
  const depthOf = (row) => {
    if (depth.has(row.id)) return depth.get(row.id);
    depth.set(row.id, 0);
    const priors = [row.amends, ...(row.supersedes ?? [])].filter(Boolean).map((key) => assertions.get(key)).filter(Boolean);
    const value = priors.length === 0 ? 0 : 1 + Math.max(...priors.map(depthOf));
    depth.set(row.id, value);
    return value;
  };
  rows.sort((a, b) => depthOf(a) - depthOf(b) || (a.tx_at < b.tx_at ? -1 : a.tx_at > b.tx_at ? 1 : 0));
  return rows.map((row) => ({
    ...row,
    link: row.amends ? `amends ${row.amends}` : row.supersedes?.length ? `supersedes ${row.supersedes.join(', ')}` : row.invalid_reason ? row.invalid_reason : 'origin',
  }));
}

// One line per fact in the shape a Dryad seat brief takes: paste the block
// and the worker starts from ids, not from a chat.
export function brief(rows) {
  return rows.map((row) => `- ${row.id}  ${row.s} ${row.p} ${row.o}  (${row.domain}, ${row.confidence.toFixed(2)}, ${row.source})`).join('\n');
}

export function counts(assertions) {
  const out = { total: assertions.size, staging: 0, active: 0, invalid: 0, staging_below_half: 0 };
  for (const row of assertions.values()) {
    out[row.status] += 1;
    if (row.status === 'staging' && row.confidence < 0.5) out.staging_below_half += 1;
  }
  return out;
}

// -------------------------------------------------------------- project

export function loadMycelium({ project = null, environment = process.env, cwd = process.cwd() }) {
  const location = resolveDryadProject({ project, environment, cwd });
  const dryad = loadDryadProject(location);
  const valuesFile = path.join(dryad.root, VALUES_RELPATH);
  if (!existsSync(valuesFile)) fail(`values not found: ${valuesFile}`);
  const values = parseMyceliumValues(readFileSync(valuesFile, 'utf8'), valuesFile);
  const file = myceliumLogPath(dryad.slug, environment);
  const assertions = foldLog(readLog(file));
  return { project: dryad, valuesFile, values, file, assertions };
}

export const SEAT_REPORTS = Object.freeze(['done', 'blocked']);

// The Forester seam: a seat that reported done or blocked becomes a
// staging fact whose source is that report, live or in the finished
// archive. Nothing is committed here; the report is a claim until someone
// promotes it.
export function seatReport(slug, seatId, status = 'done', environment = process.env) {
  if (!SEAT_REPORTS.includes(status)) fail(`--report must be one of ${SEAT_REPORTS.join(', ')}.`);
  const { state } = readDryadState(slug, environment);
  const live = state.seats[seatId];
  const finished = readDryadFinished(slug, environment).seats.filter((seat) => seat.id === seatId);
  // The live seat is the newest record; archived records follow, newest
  // first. A report from a retried item's earlier seat must not outrank
  // the seat that is working now.
  const candidates = [live, ...finished.slice().reverse()].filter(Boolean);
  if (candidates.length === 0) fail(`seat ${seatId}: not in the registry or the finished archive of ${slug}.`);
  for (const seat of candidates) {
    const report = [...(seat.journal ?? [])].reverse().find((line) => line.event === 'report' && typeof line.detail === 'string' && (line.detail === status || line.detail.startsWith(`${status}:`)));
    if (report) return { at: report.at, detail: report.detail, by: seat.by ?? null };
  }
  fail(`seat ${seatId}: has no ${status} report; it cannot be proposed as a fact.`);
}

export const seatDoneReport = (slug, seatId, environment) => seatReport(slug, seatId, 'done', environment);

// -------------------------------------------------------------------- cli

const VERBS = Object.freeze({
  propose: {
    positionals: [0, 0],
    options: ['project', 'by', 's', 'p', 'o', 's-type', 'o-type', 'domain', 'confidence', 'source', 'model', 'valid-from', 'from-seat', 'report'],
    flags: ['json'],
  },
  amend: {
    positionals: [1, 1],
    options: ['project', 'by', 's', 'p', 'o', 's-type', 'o-type', 'domain', 'confidence', 'source', 'model', 'valid-from'],
    flags: ['json'],
  },
  commit: { positionals: [1, 1], options: ['project', 'by'], flags: ['supersede', 'json'] },
  invalidate: { positionals: [1, 1], options: ['project', 'by', 'reason'], flags: ['json'] },
  query: { positionals: [0, 0], options: ['project', 's', 'p', 'o', 'domain', 'status', 'type', 'at', 'below', 'since'], flags: ['json', 'ids', 'all', 'brief'] },
  trace: { positionals: [1, 1], options: ['project'], flags: ['json'] },
  status: { positionals: [0, 0], options: ['project'], flags: ['json'] },
});

export function parseMyceliumCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!(verb in VERBS)) fail(`unknown command ${JSON.stringify(verb)}.`);
  const spec = VERBS[verb];
  const options = { help: false, verb, project: null, json: false, supersede: false, positionals: [] };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (!arg.startsWith('--')) {
      options.positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.flags.includes(name)) {
      options[name] = true;
      continue;
    }
    if (spec.options.includes(name)) {
      const value = input[index + 1];
      if (value == null || (value.startsWith('--') && !/^--?\d/.test(value))) fail(`--${name} requires a value.`);
      options[name.replaceAll('-', '_')] = value;
      index += 1;
      continue;
    }
    fail(`--${name} is not valid for ${verb}.`);
  }
  const [min, max] = spec.positionals;
  if (options.positionals.length < min || options.positionals.length > max) {
    fail(min === max ? `${verb} takes ${min === 0 ? 'no positional arguments' : `exactly ${min} positional argument${min === 1 ? '' : 's'}`}.` : `${verb} takes ${min} to ${max} positional arguments.`);
  }
  if (verb === 'propose') {
    if (options.from_seat != null) {
      for (const name of ['s', 'p', 'o', 'source', 'valid_from']) if (options[name] != null) fail(`--from-seat sets --${name.replaceAll('_', '-')} from the seat's report; do not pass both.`);
      if (options.report != null && !SEAT_REPORTS.includes(options.report)) fail(`--report must be one of ${SEAT_REPORTS.join(', ')}.`);
    } else {
      if (options.report != null) fail('--report goes with --from-seat.');
      for (const name of ['s', 'p', 'o', 'source']) if (options[name] == null) fail(`propose requires --${name}.`);
    }
    if (options.s_type == null) fail('propose requires --s-type.');
    if (options.domain == null) fail('propose requires --domain.');
  }
  if (verb === 'invalidate' && options.reason == null) fail('invalidate requires --reason.');
  if (verb === 'query' && options.status != null && !STATUSES.includes(options.status)) fail(`--status must be one of ${STATUSES.join(', ')}.`);
  if (verb === 'query' && options.at != null && options.status != null) fail('pass --at or --status, not both.');
  if (verb === 'query' && options.all && (options.status != null || options.at != null)) fail('--all takes every status; do not pass --status or --at with it.');
  if (verb === 'query' && [options.json, options.ids, options.brief].filter(Boolean).length > 1) fail('pass one of --json, --ids, --brief.');
  return options;
}

// The seat whose worktree holds cwd, read from the Dryad registry. A seat
// working in its own worktree is identified by where it stands, which is a
// registry fact, and needs neither --by nor DRYAD_ID. That also holds in a
// playground sandbox, whose guard strips DRYAD_* but leaves the worktree.
export function seatAt(slug, cwd, environment = process.env) {
  let here;
  try {
    here = realpathSync(cwd);
  } catch {
    return null;
  }
  const { state } = readDryadState(slug, environment);
  for (const [id, seat] of Object.entries(state.seats)) {
    let root;
    try {
      root = realpathSync(seat.worktree);
    } catch {
      continue;
    }
    if (here === root || here.startsWith(root + path.sep)) return id;
  }
  return null;
}

// Who writes is never guessed from nothing: --by, then the seat DRYAD_ID
// names, then the seat whose worktree cwd is inside. No fourth default.
function actor(options, environment, { slug, cwd }) {
  if (options.by != null) return assertWriter(options.by);
  if (environment.DRYAD_ID) return assertWriter(`seat:${environment.DRYAD_ID}`);
  const seat = seatAt(slug, cwd, environment);
  if (seat != null) return assertWriter(`seat:${seat}`);
  fail('pass --by <who> (a seat sets DRYAD_ID, or runs from its worktree, and needs none).');
}

function fields(options) {
  return {
    s: options.s, p: options.p, o: options.o, s_type: options.s_type, o_type: options.o_type, domain: options.domain,
    confidence: options.confidence, source: options.source, model: options.model, valid_from: options.valid_from,
  };
}

function line(row) {
  const conf = row.confidence.toFixed(2);
  return `  ${row.id}  ${row.status.padEnd(7)}  ${conf}  ${row.domain.padEnd(10)}  ${row.s} ${row.p} ${row.o}`;
}

export function runMycelium({ options, environment = process.env, cwd = process.cwd() }) {
  const loaded = loadMycelium({ project: options.project, environment, cwd });
  const { file, values, assertions, project } = loaded;
  const who = () => actor(options, environment, { slug: project.slug, cwd });
  switch (options.verb) {
    case 'propose': {
      const by = who();
      let input = { ...fields(options), agent_id: by };
      if (options.from_seat != null) {
        const report = seatReport(project.slug, options.from_seat, options.report ?? 'done', environment);
        input = { ...input, s: options.from_seat, p: REPORTED, o: report.detail, source: `dryad seat ${options.from_seat} report at ${report.at}`, valid_from: report.at };
      }
      const assertion = propose({ file, assertion: makeAssertion(input, values), by });
      if (options.json) console.log(JSON.stringify(assertion, null, 2));
      else console.log(`■ ${project.slug} — proposed ${assertion.id} (staging)\n${line(assertion)}`);
      return 0;
    }
    case 'amend': {
      const by = who();
      const assertion = proposeAmendment({ file, id: options.positionals[0], overrides: { ...fields(options), agent_id: by }, values, by });
      if (options.json) console.log(JSON.stringify(assertion, null, 2));
      else console.log(`■ ${project.slug} — proposed ${assertion.id} (staging), amends ${assertion.amends}\n${line(assertion)}`);
      return 0;
    }
    case 'commit': {
      const by = assertJudge(values, who());
      const { target, superseded, amended } = commit({ file, values, id: options.positionals[0], by, supersede: options.supersede });
      if (options.json) console.log(JSON.stringify({ id: target.id, status: 'active', superseded, amended }, null, 2));
      else console.log(`■ ${project.slug} — committed ${target.id} (active)${superseded.length ? `, superseded ${superseded.join(', ')}` : ''}${amended ? `, amended ${amended}` : ''}`);
      return 0;
    }
    case 'invalidate': {
      const by = assertJudge(values, who());
      const target = invalidate({ file, id: options.positionals[0], by, reason: options.reason });
      if (options.json) console.log(JSON.stringify({ id: target.id, status: 'invalid', reason: options.reason }, null, 2));
      else console.log(`■ ${project.slug} — invalidated ${target.id}: ${options.reason}`);
      return 0;
    }
    case 'query': {
      const filter = { s: options.s, p: options.p, o: options.o, domain: options.domain, type: options.type, at: options.at, since: options.since };
      if (options.below != null) {
        filter.below = Number(options.below);
        if (!Number.isFinite(filter.below)) fail(`--below must be a number, got ${JSON.stringify(options.below)}.`);
      }
      if (options.at == null && !options.all) filter.status = options.status ?? 'active';
      const rows = query(assertions, filter);
      if (options.json) console.log(JSON.stringify(rows, null, 2));
      else if (options.ids) {
        for (const row of rows) console.log(row.id);
      } else if (options.brief) {
        if (rows.length > 0) console.log(brief(rows));
      } else {
        const scope = options.at ? ` held at ${isoOrFail(options.at, '--at')}` : options.all ? ' (every status)' : ` (${filter.status})`;
        console.log([`■ ${project.slug} — ${rows.length} assertion${rows.length === 1 ? '' : 's'}${scope}${options.since ? ` since ${isoOrFail(options.since, '--since')}` : ''}`, ...rows.map(line)].join('\n'));
      }
      return 0;
    }
    case 'trace': {
      const rows = trace(assertions, options.positionals[0]);
      if (options.json) console.log(JSON.stringify(rows, null, 2));
      else console.log([`■ ${project.slug} — ${rows.length} in the chain of ${options.positionals[0]}`, ...rows.map((row) => `${line(row)}\n      ${row.link}`)].join('\n'));
      return 0;
    }
    case 'status': {
      const c = counts(assertions);
      if (options.json) console.log(JSON.stringify({ project: project.slug, file, values, counts: c }, null, 2));
      else {
        console.log([
          `■ ${project.slug} — mycelium`,
          `  log       ${file}`,
          `  domains   ${values.domains.join(', ')}`,
          `  types     ${values.types.join(', ')}`,
          `  predicates ${Object.entries(values.predicates).map(([name, card]) => `${name}(${card})`).join(', ')}`,
          `  judges    ${values.judges == null ? 'anyone named (no judges declared)' : values.judges.join(', ')}`,
          `  assertions ${c.total} · active ${c.active} · staging ${c.staging} · invalid ${c.invalid}`,
          `  staging below 0.5: ${c.staging_below_half}`,
        ].join('\n'));
      }
      return 0;
    }
    default:
      fail(`unknown command ${JSON.stringify(options.verb)}.`);
  }
  return 1;
}

export function myceliumHelp(cli = 'de-novo skills') {
  return `the facts under the forest: one append-only log of assertions per project

usage:
  ${cli} mycelium propose --s S --p P --o O --s-type T [--o-type T] --domain D --source SRC
                          [--confidence 0..1] [--model M] [--valid-from ISO] [--by WHO] [--json]
  ${cli} mycelium propose --from-seat ID --s-type T --domain D [--report done|blocked] [--by WHO]
                                                  a seat's done (or blocked) report as a staging fact
  ${cli} mycelium amend <id> [--o O] [--confidence C] [--source SRC] [...any envelope field] [--by WHO]
                                                  a corrected copy, staging; committing it closes the original
  ${cli} mycelium commit <id> [--supersede] [--by WHO]   staging → active; refuses a conflict unless --supersede
  ${cli} mycelium invalidate <id> --reason TEXT [--by WHO]   active → invalid, valid_to = now
  ${cli} mycelium query [--s S] [--p P] [--o O] [--domain D] [--type T] [--below 0.5] [--since ISO]
                        [--status staging|active|invalid | --at ISO | --all] [--json | --ids | --brief]
  ${cli} mycelium trace <id> [--json]             the chain: what it amends or supersedes, and what did that to it
  ${cli} mycelium status [--json]                 counts, the log path, the project's vocabulary

Every verb takes --project ROOT; without it the Dryad profile above the
current directory names the project. The writer is --by, else the seat
DRYAD_ID names, else the seat whose worktree holds the current directory.
Domains, entity types, predicates (one|many), and the judges who may
commit and invalidate come from ${VALUES_RELPATH}.
Pattern: skills/mycelium/SKILL.md.`;
}
