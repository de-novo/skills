// Overlay lifecycle control plane. Projects still own workload deployment;
// Grove validates and dispatches that command, then keeps a lease registry.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const ENV_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DURATION_PATTERN = /^([1-9][0-9]*)(s|m|h|d|w)$/;
const DURATION_UNITS = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});
const TAGGED_FULL_SHA = /^.+:[0-9a-f]{40}$/;
const DIGESTED_SHA256 = /^.+@sha256:[0-9a-f]{64}$/;
const STATE_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_POLL_INTERVAL_MS = 250;
const POSITIONAL_COUNTS = Object.freeze({
  create: [1, 1],
  attach: [2, 2],
  detach: [2, 2],
  destroy: [1, 1],
  status: [0, 1],
  touch: [1, 1],
  prune: [0, 0],
  verify: [0, 0],
});

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`overlay: ${message}`);
}

export function assertOverlayEnv(value) {
  if (typeof value !== 'string' || !ENV_PATTERN.test(value)) {
    fail(`environment must be a DNS label of at most 63 characters — ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertOverlayImage(value) {
  if (
    typeof value !== 'string' ||
    (!TAGGED_FULL_SHA.test(value) && !DIGESTED_SHA256.test(value))
  ) {
    fail(
      `image must end in a full git SHA tag or sha256 digest — ${JSON.stringify(value)}`
    );
  }
  return value;
}

export function parseDuration(value, field = 'duration') {
  const match = typeof value === 'string' ? DURATION_PATTERN.exec(value) : null;
  if (!match) {
    fail(`${field} must be a positive duration such as 30m, 12h, 7d, or 2w.`);
  }
  const milliseconds = Number(match[1]) * DURATION_UNITS[match[2]];
  if (!Number.isSafeInteger(milliseconds)) {
    fail(`${field} is too large.`);
  }
  return milliseconds;
}

export function splitOverlayCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    fail('runtime.commands.overlay must be a non-empty command string.');
  }
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped || quote) fail('runtime.commands.overlay has an unfinished quote or escape.');
  if (started) words.push(word);
  if (words.length === 0 || words[0].length === 0) {
    fail('runtime.commands.overlay has no executable.');
  }
  return words;
}

function takeOption(args, index, name) {
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) fail(`${name} requires a value.`);
  return value;
}

export function parseOverlayCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') {
    return { help: true };
  }
  if (!(verb in POSITIONAL_COUNTS)) {
    fail(`unknown command ${JSON.stringify(verb)}.`);
  }

  let project = null;
  let image = null;
  let envOption = null;
  let staleAfter = null;
  let apply = false;
  let json = false;
  let afterSeparator = false;
  const remaining = [];
  const explicitPassthrough = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (afterSeparator) {
      explicitPassthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg === '--project') {
      if (project != null) fail('--project may be passed only once.');
      project = takeOption(input, index, '--project');
      index += 1;
      continue;
    }
    if (arg === '--image') {
      if (image != null) fail('--image may be passed only once.');
      image = takeOption(input, index, '--image');
      index += 1;
      continue;
    }
    if (arg === '--env') {
      if (envOption != null) fail('--env may be passed only once.');
      envOption = takeOption(input, index, '--env');
      index += 1;
      continue;
    }
    if (arg === '--stale-after') {
      if (staleAfter != null) fail('--stale-after may be passed only once.');
      staleAfter = takeOption(input, index, '--stale-after');
      parseDuration(staleAfter, '--stale-after');
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      if (apply) fail('--apply may be passed only once.');
      apply = true;
      continue;
    }
    if (arg === '--json') {
      if (json) fail('--json may be passed only once.');
      json = true;
      continue;
    }
    remaining.push(arg);
  }

  const [minimum, maximum] = POSITIONAL_COUNTS[verb];
  const positionals = remaining.slice(0, maximum);
  if (remaining.length > maximum) {
    fail('project-specific arguments must follow --.');
  }
  const passthrough = explicitPassthrough;
  if (positionals.length < minimum) {
    fail(`${verb} requires ${minimum === 1 ? 'an environment' : 'an environment and service'}.`);
  }
  if (passthrough.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) {
    fail('--apply must be a Grove option before --, not a project passthrough flag.');
  }
  if (verb === 'attach' && image == null) fail('attach requires --image.');
  if (!['attach', 'verify'].includes(verb) && image != null) {
    fail(`--image is not valid for ${verb}.`);
  }
  if (envOption != null && verb !== 'verify') fail(`--env is not valid for ${verb}.`);
  if (!['status', 'prune'].includes(verb) && staleAfter != null) {
    fail(`--stale-after is not valid for ${verb}.`);
  }
  if (['status', 'touch', 'verify'].includes(verb) && apply) {
    fail(`--apply is not valid for ${verb}.`);
  }
  if (json && !['status', 'verify'].includes(verb)) {
    fail('--json is valid only for status and verify.');
  }
  if (verb === 'touch' && passthrough.length > 0) {
    fail('touch does not dispatch project-specific arguments.');
  }

  const named = verb === 'verify' ? envOption : positionals[0];
  const env = named == null ? null : assertOverlayEnv(named);
  return {
    help: false,
    verb,
    env,
    service: positionals[1] ?? null,
    project,
    image,
    staleAfter,
    apply,
    json,
    passthrough,
  };
}

export function assertOverlayActive(profile) {
  if (profile.overlay?.mode !== 'on') {
    const reason = profile.overlay?.explicitNone ? 'overlay: none' : 'no overlay declaration';
    fail(`lifecycle is inactive (${reason}).`);
  }
  if (!profile.overlay.command) {
    fail('runtime.commands.overlay is missing; Grove will not invent a workload command.');
  }
}

export function projectRootFromProfile(profilePath) {
  const resolved = realpathSync(profilePath);
  const parent = path.dirname(resolved);
  if (path.basename(resolved) === 'runtime-profile.yml' && path.basename(parent) === '.agents') {
    return path.dirname(parent);
  }
  return parent;
}

export function overlayStateDirectory(environment = process.env) {
  const override = environment.GROVE_STATE_DIR;
  if (override != null) {
    if (override.length === 0) fail('GROVE_STATE_DIR must not be empty.');
    return path.resolve(override);
  }
  return path.join(homedir(), '.dev-infra', 'overlays');
}

export function overlayStatePath(slug, environment = process.env) {
  return path.join(overlayStateDirectory(environment), `${slug}.yml`);
}

function blankState(slug) {
  return { version: STATE_VERSION, project: slug, envs: {}, pending_by_env: {} };
}

function assertTimestamp(value, field, file) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${file}: ${field} must be an ISO timestamp.`);
  }
}

function validateState(state, slug, file) {
  if (!isMap(state) || ![1, STATE_VERSION].includes(state.version) || state.project !== slug) {
    fail(`${file}: registry must have version ${STATE_VERSION} and project ${JSON.stringify(slug)}.`);
  }
  if (!isMap(state.envs)) fail(`${file}: envs must be a map.`);
  if (state.version === 1) {
    if (Object.hasOwn(state, 'pending_by_env')) fail(`${file}: legacy registry cannot contain pending_by_env.`);
    state.pending_by_env = state.pending == null ? {} : { [state.pending.env]: state.pending };
    delete state.pending;
    state.version = STATE_VERSION;
  } else if (Object.hasOwn(state, 'pending')) {
    fail(`${file}: version ${STATE_VERSION} uses pending_by_env, not pending.`);
  }
  if (!isMap(state.pending_by_env)) fail(`${file}: pending_by_env must be a map.`);
  for (const [env, pending] of Object.entries(state.pending_by_env)) {
    assertOverlayEnv(env);
    if (!isMap(pending) || !['create', 'attach', 'detach', 'destroy'].includes(pending.verb)) {
      fail(`${file}: pending must be null or a lifecycle mutation.`);
    }
    assertOverlayEnv(pending.env);
    if (pending.env !== env) fail(`${file}: pending environment must match its map key.`);
    if (['attach', 'detach'].includes(pending.verb)) {
      if (typeof pending.service !== 'string' || pending.service.length === 0) {
        fail(`${file}: pending ${pending.verb} must name a service.`);
      }
    } else if (pending.service != null) {
      fail(`${file}: pending ${pending.verb} must not name a service.`);
    }
    if (pending.verb === 'attach') assertOverlayImage(pending.image);
    else if (pending.image != null) fail(`${file}: pending ${pending.verb} must not name an image.`);
    assertTimestamp(pending.started_at, 'pending.started_at', file);
    for (const field of ['worktree', 'agent']) {
      if (typeof pending[field] !== 'string' || pending[field].length === 0) {
        fail(`${file}: pending.${field} must be a non-empty string.`);
      }
    }
    if (pending.source != null && !['mutation', 'prune'].includes(pending.source)) {
      fail(`${file}: pending.source must be mutation or prune when present.`);
    }
    if (!/^[0-9a-f]{64}$/.test(pending.passthrough_sha256)) {
      fail(`${file}: pending.passthrough_sha256 must be a sha256 digest.`);
    }
  }
  for (const [env, record] of Object.entries(state.envs)) {
    assertOverlayEnv(env);
    if (!isMap(record) || !isMap(record.services)) {
      fail(`${file}: envs.${env} and its services must be maps.`);
    }
    assertTimestamp(record.created_at, `envs.${env}.created_at`, file);
    assertTimestamp(record.last_used_at, `envs.${env}.last_used_at`, file);
    for (const [service, attached] of Object.entries(record.services)) {
      if (!isMap(attached)) fail(`${file}: envs.${env}.services.${service} must be a map.`);
      assertOverlayImage(attached.image);
      assertTimestamp(attached.attached_at, `envs.${env}.services.${service}.attached_at`, file);
    }
  }
  return state;
}

export function readOverlayState(slug, environment = process.env) {
  const file = overlayStatePath(slug, environment);
  if (!existsSync(file)) return { file, state: blankState(slug) };
  let state;
  try {
    state = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { file, state: blankState(slug) };
    fail(`${file}: cannot read registry: ${error.message}`);
  }
  return { file, state: validateState(state, slug, file) };
}

function atomicWriteState(file, state) {
  if (Object.keys(state.envs).length === 0 && Object.keys(state.pending_by_env).length === 0) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, stringify(state), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireStateLock(file, waitMs = 0) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const open = () => {
    const descriptor = openSync(lock, 'wx', 0o600);
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          acquired_at: new Date().toISOString(),
        })
      );
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      if (existsSync(lock)) unlinkSync(lock);
      throw error;
    }
  };

  let descriptor;
  const deadline = Date.now() + waitMs;
  while (descriptor == null) {
    try {
      descriptor = open();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lock, 'utf8'));
      } catch {
        // An unreadable lock is not safe to steal.
      }
      if (
        owner?.host === hostname() &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        !processIsAlive(owner.pid)
      ) {
        // Serialize dead-owner recovery too: two reclaimers must not unlink a
        // replacement lock acquired by a live process after their first read.
        const recovery = `${lock}.recovery`;
        try { mkdirSync(recovery); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (Date.now() < deadline) { sleepSync(10); continue; }
          fail(`registry lock recovery is busy or interrupted: ${recovery}.`);
        }
        try {
          let current;
          try { current = JSON.parse(readFileSync(lock, 'utf8')); } catch {}
          if (current?.host === hostname() && Number.isInteger(current.pid) && current.pid > 0 && !processIsAlive(current.pid)) {
            unlinkSync(lock);
          }
        } finally { rmdirSync(recovery); }
        continue;
      } else {
        if (Date.now() < deadline) {
          sleepSync(Math.min(10, deadline - Date.now()));
          continue;
        }
        const detail = owner ? `pid ${owner.pid ?? '?'} on ${owner.host ?? '?'}` : 'unknown owner';
        fail(`registry is locked by ${detail}; retry after that lifecycle command finishes.`);
      }
    }
  }

  return () => {
    closeSync(descriptor);
    if (existsSync(lock)) unlinkSync(lock);
  };
}

function withStateLock(file, operation) {
  // Only registry read/merge/write work belongs inside this short critical section.
  const release = acquireStateLock(file, 2000);
  try {
    return operation();
  } finally {
    release();
  }
}

function withEnvironmentLock(file, env, operation) {
  const release = acquireStateLock(path.join(`${file}.env-locks`, assertOverlayEnv(env)));
  try { return operation(); } finally { release(); }
}

function updateRegistry(profile, environment, operation) {
  const file = overlayStatePath(profile.project.slug, environment);
  return withStateLock(file, () => {
    const { state } = readOverlayState(profile.project.slug, environment);
    const result = operation(state);
    atomicWriteState(file, state);
    return result;
  });
}

function pendingFor(state, env) {
  return Object.hasOwn(state.pending_by_env, env) ? state.pending_by_env[env] : null;
}

function timeoutFromEnvironment(environment) {
  const raw = environment.GROVE_OVERLAY_TIMEOUT_MS ?? environment.DEVINFRA_OVERLAY_TIMEOUT_MS;
  if (raw == null) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail('GROVE_OVERLAY_TIMEOUT_MS must be a positive integer in milliseconds.');
  }
  return Number(raw);
}

function verifyTimeoutFromEnvironment(environment) {
  const raw = environment.GROVE_OVERLAY_VERIFY_TIMEOUT_MS;
  if (raw == null) return DEFAULT_VERIFY_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail('GROVE_OVERLAY_VERIFY_TIMEOUT_MS must be a positive integer in milliseconds.');
  }
  return Number(raw);
}

// A project command that rejects a request before touching the runtime says
// so with its last stdout line: ok false, mutated false. Anything else on a
// non-zero exit is treated as a possible half-done mutation.
function refusalReceipt(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let receipt;
  try {
    receipt = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
  return isMap(receipt) && receipt.ok === false && receipt.mutated === false ? receipt : null;
}

function parseReceipt(stdout) {
  const last = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) fail('project command produced no JSON receipt.');
  let receipt;
  try {
    receipt = JSON.parse(last);
  } catch {
    fail('project command must end with one JSON object.');
  }
  if (!isMap(receipt)) fail('project command JSON receipt must be an object.');
  return receipt;
}

function validateReceipt(receipt, expected) {
  if (receipt.ok !== true) {
    fail('project command receipt must contain ok: true.');
  }
  if (receipt.verb !== expected.verb) {
    fail(`project receipt verb mismatch: expected ${expected.verb}, got ${JSON.stringify(receipt.verb)}.`);
  }
  if (expected.env != null && expected.verb !== 'status' && receipt.env !== expected.env) {
    fail(`project receipt environment mismatch: expected ${expected.env}.`);
  }
  if (expected.service != null && receipt.service !== expected.service) {
    fail(`project receipt service mismatch: expected ${expected.service}.`);
  }
  if (expected.image != null && receipt.image !== expected.image) {
    fail('project receipt image does not match the requested immutable image.');
  }
  if (expected.plan === true && receipt.plan !== true) {
    fail('plan-first project command did not return plan: true; registry remains unchanged.');
  }
  if (expected.requireApplied && receipt.plan === true) {
    fail('project command returned a plan during --apply; registry remains unchanged.');
  }
  if (
    expected.requireUpstream &&
    (typeof receipt.upstream !== 'string' || receipt.upstream.length === 0)
  ) {
    fail('addressing.proxy: machine attach requires an upstream in the project receipt.');
  }
  if (
    receipt.upstream != null &&
    (typeof receipt.upstream !== 'string' || receipt.upstream.length === 0)
  ) {
    fail('project receipt upstream must be a non-empty string when present.');
  }
  return receipt;
}

function relayProjectOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function dispatchProjectCommand({
  profile,
  projectRoot,
  verb,
  args,
  apply,
  expected,
  environment,
  relay = true,
  timeoutMs = null,
}) {
  const [command, ...prefix] = splitOverlayCommand(profile.overlay.command);
  if (
    profile.overlay.planFirst &&
    prefix.some((arg) => arg === '--apply' || arg.startsWith('--apply='))
  ) {
    fail('a plan-first runtime.commands.overlay must not contain a permanent --apply flag.');
  }
  const projectArgs = [...prefix, verb, ...args];
  if (apply && profile.overlay.planFirst) projectArgs.push('--apply');
  const timeout = timeoutMs ?? timeoutFromEnvironment(environment);
  const result = spawnSync(command, projectArgs, {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    timeout,
  });
  if (relay) relayProjectOutput(result);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      fail(`project command timed out after ${timeout}ms.`);
    }
    fail(`cannot run project command: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const refusal = refusalReceipt(result.stdout);
    if (refusal) {
      const error = new Error(`overlay: project refused ${verb}: ${refusal.error ?? 'no reason given'}`);
      error.refused = true;
      throw error;
    }
    fail(`project command failed with exit ${result.status}.`);
  }
  const receipt = parseReceipt(result.stdout);
  return validateReceipt(receipt, {
    verb,
    plan: !apply && profile.overlay.planFirst && verb !== 'status',
    requireApplied: apply,
    requireUpstream:
      apply && verb === 'attach' && profile.addressing?.proxy === 'machine',
    ...expected,
  });
}

function mutationArgs(options) {
  switch (options.verb) {
    case 'create':
    case 'destroy':
      return [options.env, ...options.passthrough];
    case 'attach':
      return [
        options.env,
        options.service,
        '--image',
        options.image,
        ...options.passthrough,
      ];
    case 'detach':
      return [options.env, options.service, ...options.passthrough];
    default:
      throw new Error(`not a mutation: ${options.verb}`);
  }
}

function assertMutationInputs(options, profile, state) {
  if (options.verb === 'attach') {
    if (!profile.overlay.attachable.includes(options.service)) {
      fail(`service ${JSON.stringify(options.service)} is not attachable.`);
    }
    assertOverlayImage(options.image);
  }
  if (['attach', 'detach'].includes(options.verb) && !state.envs[options.env]) {
    if (options.verb === 'attach' && profile.overlay.createOn === 'attach') return;
    fail(`environment ${JSON.stringify(options.env)} is not tracked; create it first.`);
  }
}

function applyMutation(state, options, receipt, now, owner) {
  switch (options.verb) {
    case 'create': {
      const previous = state.envs[options.env];
      state.envs[options.env] = previous ?? {
        created_at: now,
        worktree: owner.worktree,
        agent: owner.agent,
        services: {},
      };
      state.envs[options.env].last_used_at = now;
      break;
    }
    case 'attach': {
      const record = state.envs[options.env];
      record.services[options.service] = {
        image: options.image,
        ...(receipt.upstream == null ? {} : { upstream: receipt.upstream }),
        attached_at: now,
      };
      record.last_used_at = now;
      break;
    }
    case 'detach':
      delete state.envs[options.env].services[options.service];
      state.envs[options.env].last_used_at = now;
      break;
    case 'destroy':
      delete state.envs[options.env];
      break;
    default:
      throw new Error(`not a mutation: ${options.verb}`);
  }
}

function operationTarget(operation) {
  return `${operation.verb} ${operation.env}${operation.service ? `/${operation.service}` : ''}`;
}

function pendingMatchesOptions(pending, options) {
  return pending.verb === options.verb &&
    pending.env === options.env &&
    (pending.service ?? null) === (options.service ?? null) &&
    (pending.image ?? null) === (options.image ?? null) &&
    pending.passthrough_sha256 === passthroughDigest(options.passthrough);
}

function assertPendingCompatible(state, options, apply) {
  const pending = pendingFor(state, options.env);
  if (pending == null) return;
  const instruction = `rerun the pending ${operationTarget(pending)} operation with --apply`;
  if (!apply || !pendingMatchesOptions(pending, options)) {
    fail(`pending operation ${operationTarget(pending)} must be recovered first; ${instruction}.`);
  }
}

function newPendingOperation(options, owner, source) {
  return {
    verb: options.verb,
    env: options.env,
    ...(options.service == null ? {} : { service: options.service }),
    ...(options.image == null ? {} : { image: options.image }),
    started_at: new Date().toISOString(),
    worktree: owner.worktree,
    agent: owner.agent,
    source,
    passthrough_sha256: passthroughDigest(options.passthrough),
  };
}

function passthroughDigest(passthrough) {
  return createHash('sha256').update(JSON.stringify(passthrough)).digest('hex');
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function postconditionSatisfied(operation, inventory) {
  const services = inventory.get(operation.env);
  switch (operation.verb) {
    case 'create':
      return services != null;
    case 'attach':
      return services?.get(operation.service)?.image === operation.image &&
        services.get(operation.service).ready === true;
    case 'detach':
      return services != null && !services.has(operation.service);
    case 'destroy':
      return services == null;
    default:
      throw new Error(`not a mutation: ${operation.verb}`);
  }
}

function verifyMutationPostcondition({
  pending,
  profile,
  projectRoot,
  environment,
  timeout,
  commandTimeout,
  passthrough,
}) {
  const deadline = Date.now() + timeout;
  let attempts = 0;
  let lastObservation = 'runtime state did not match';
  do {
    attempts += 1;
    try {
      const receipt = dispatchProjectCommand({
        profile,
        projectRoot,
        verb: 'status',
        args: [pending.env, ...passthrough],
        apply: false,
        expected: {},
        environment,
        relay: false,
        timeoutMs: Math.max(
          1,
          Math.min(commandTimeout, deadline - Date.now())
        ),
      });
      const inventory = inventoryFromReceipt(receipt);
      if (inventory == null) {
        lastObservation = 'status receipt omitted environments';
      } else if (postconditionSatisfied(pending, inventory)) {
        console.log(
          `postcondition 1/1: ${operationTarget(pending)} observed (attempts ${attempts})`
        );
        return;
      } else {
        lastObservation = 'runtime state did not match';
      }
    } catch (error) {
      lastObservation = error.message;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(VERIFY_POLL_INTERVAL_MS, remaining);
    sleepSync(delay);
    if (delay === remaining) break;
  } while (Date.now() <= deadline);

  fail(
    `postcondition for ${operationTarget(pending)} was not observed after ${attempts} attempts within ${timeout}ms; pending operation retained (${lastObservation}).`
  );
}

function executeAppliedMutation({
  options,
  profile,
  projectRoot,
  environment,
  owner,
  source,
}) {
  const commandTimeout = timeoutFromEnvironment(environment);
  const verifyTimeout = verifyTimeoutFromEnvironment(environment);
  let previousPending = null;
  const pending = updateRegistry(profile, environment, state => {
    assertPendingCompatible(state, options, true);
    assertMutationInputs(options, profile, state);
    const previous = pendingFor(state, options.env);
    previousPending = previous;
    if (previous) console.log(`recovered pending ${operationTarget(previous)}: redispatching idempotently`);
    const operation = previous ?? newPendingOperation(options, owner, source);
    state.pending_by_env[options.env] = operation;
    return operation;
  });

  try {
    const receipt = dispatchProjectCommand({
      profile,
      projectRoot,
      verb: options.verb,
      args: mutationArgs(options),
      apply: true,
      expected: {
        env: options.env,
        service: options.service,
        image: options.image,
      },
      environment,
      timeoutMs: commandTimeout,
    });
    verifyMutationPostcondition({
      pending,
      profile,
      projectRoot,
      environment,
      timeout: verifyTimeout,
      commandTimeout,
      passthrough: options.passthrough,
    });
    updateRegistry(profile, environment, state => {
      assertPendingCompatible(state, options, true);
      applyMutation(state, options, receipt, new Date().toISOString(), owner);
      delete state.pending_by_env[options.env];
    });
    return receipt;
  } catch (error) {
    if (error.refused && previousPending == null) {
      // Nothing ran: the journal this dispatch wrote is withdrawn. A refused
      // retry of an older pending keeps that journal; its first attempt may
      // have mutated the runtime.
      updateRegistry(profile, environment, state => {
        if (pendingMatchesOptions(pendingFor(state, options.env) ?? {}, options)) delete state.pending_by_env[options.env];
      });
      throw new Error(`${error.message} Nothing pending.`);
    }
    if (/pending operation retained/i.test(error.message)) throw error;
    throw new Error(
      `${error.message} Pending operation retained; rerun the same --apply command to recover.`
    );
  }
}

function safeRealpath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function runMutation({ options, profile, projectRoot, environment, cwd }) {
  if (!options.apply && !profile.overlay.planFirst) {
    fail(`${options.verb} requires --apply because overlay.plan_first is false.`);
  }

  const firstRead = readOverlayState(profile.project.slug, environment);
  if (!options.apply) {
    assertPendingCompatible(firstRead.state, options, false);
    assertMutationInputs(options, profile, firstRead.state);
    dispatchProjectCommand({
      profile,
      projectRoot,
      verb: options.verb,
      args: mutationArgs(options),
      apply: false,
      expected: {
        env: options.env,
        service: options.service,
        image: options.image,
      },
      environment,
    });
    console.log(`overlay ${options.verb} plan 0/1: registry unchanged`);
    return 0;
  }

  return withEnvironmentLock(firstRead.file, options.env, () => {
    const owner = {
      worktree: safeRealpath(cwd),
      agent: environment.DEVINFRA_AGENT ?? environment.USER ?? 'unknown',
    };
    // create_on: attach — the environment is created by the first applied
    // attach, from the caller's directory, as its own journaled mutation.
    if (
      options.verb === 'attach' &&
      profile.overlay.createOn === 'attach' &&
      !readOverlayState(profile.project.slug, environment).state.envs[options.env]
    ) {
      executeAppliedMutation({
        options: { ...options, verb: 'create', service: null, image: null },
        profile,
        projectRoot,
        environment,
        source: 'mutation',
        owner,
      });
      console.log(`overlay create 1/1: ${options.env} (create_on: attach)`);
    }
    executeAppliedMutation({
      options,
      profile,
      projectRoot,
      environment,
      source: 'mutation',
      owner,
    });
    console.log(`overlay ${options.verb} 1/1: ${options.env}${options.service ? `/${options.service}` : ''}`);
    return 0;
  });
}

export function staleOverlayEnvironments(state, thresholdMs, now = Date.now()) {
  return Object.entries(state.envs)
    .filter(([, record]) => now - Date.parse(record.last_used_at) >= thresholdMs)
    .map(([env, record]) => ({ env, record }))
    .sort((left, right) => left.env.localeCompare(right.env));
}

function formatAge(timestamp, now) {
  const milliseconds = Math.max(0, now - Date.parse(timestamp));
  if (milliseconds < DURATION_UNITS.m) return `${Math.floor(milliseconds / 1_000)}s`;
  if (milliseconds < DURATION_UNITS.h) return `${Math.floor(milliseconds / DURATION_UNITS.m)}m`;
  if (milliseconds < DURATION_UNITS.d) return `${Math.floor(milliseconds / DURATION_UNITS.h)}h`;
  return `${Math.floor(milliseconds / DURATION_UNITS.d)}d`;
}

function inventoryFromReceipt(receipt) {
  if (!Object.hasOwn(receipt, 'environments')) return null;
  if (!Array.isArray(receipt.environments)) {
    fail('status receipt environments must be a list when present.');
  }
  const inventory = new Map();
  for (const item of receipt.environments) {
    if (!isMap(item)) fail('status receipt environment entries must be objects.');
    const env = assertOverlayEnv(item.env);
    if (inventory.has(env)) fail(`status receipt repeats environment ${JSON.stringify(env)}.`);
    let services;
    if (item.services == null && isMap(item.overrides)) services = Object.keys(item.overrides);
    else if (item.services == null) services = [];
    else if (Array.isArray(item.services)) {
      services = item.services;
    } else {
      fail(`status receipt services for ${env} must be a list of service observations.`);
    }
    const observed = new Map();
    for (const service of services) {
      // Name-only inventories remain inspectable, but cannot prove an attach.
      const name = typeof service === 'string' ? service : service?.service;
      assertOverlayEnv(name);
      if (observed.has(name)) fail(`status receipt repeats service ${env}/${name}.`);
      if (typeof service === 'string') {
        observed.set(name, null);
      } else {
        if (!isMap(service)) fail(`status receipt ${env}/${name} must be a service observation.`);
        assertOverlayImage(service.image);
        if (typeof service.ready !== 'boolean') {
          fail(`status receipt ${env}/${name}.ready must be a boolean.`);
        }
        observed.set(name, { image: service.image, ready: service.ready });
      }
    }
    inventory.set(env, observed);
  }
  return inventory;
}

function registryInventory(state) {
  return new Map(
    Object.entries(state.envs).map(([env, record]) => [env, new Map(Object.entries(record.services))])
  );
}

function compareInventory(state, runtime, onlyEnv = null) {
  if (runtime == null) return null;
  const registry = registryInventory(state);
  const names = new Set([...registry.keys(), ...runtime.keys()]);
  const drift = [];
  for (const env of [...names].sort()) {
    if (onlyEnv != null && env !== onlyEnv) continue;
    const local = registry.get(env);
    const remote = runtime.get(env);
    if (!local) {
      drift.push({ env, service: null, message: 'runtime environment is untracked' });
      continue;
    }
    if (!remote) {
      drift.push({ env, service: null, message: 'registry entry is missing at runtime' });
      continue;
    }
    const localNames = [...local.keys()].sort();
    const remoteNames = [...remote.keys()].sort();
    if (JSON.stringify(localNames) !== JSON.stringify(remoteNames)) {
      drift.push({
        env,
        service: null,
        message: `services differ (registry ${localNames.join(',') || '-'}; runtime ${remoteNames.join(',') || '-'})`,
      });
    }
    for (const name of localNames) {
      if (!remote.has(name)) continue;
      const observed = remote.get(name);
      if (observed == null) {
        drift.push({ env, service: name, message: 'runtime image and readiness notMeasured' });
      } else if (observed.image !== local.get(name).image || !observed.ready) {
        drift.push({ env, service: name, message: 'runtime image differs or service is not ready' });
      }
    }
  }
  return drift;
}

function formatDrift(item) {
  return `${item.env}${item.service ? `/${item.service}` : ''}: ${item.message}`;
}

function resolveStalePolicy(options, profile, required) {
  const value = options.staleAfter ?? profile.overlay.staleAfter;
  if (value == null) {
    if (required) {
      fail('prune needs overlay.stale_after in the profile or --stale-after on the command.');
    }
    return null;
  }
  return { value, milliseconds: parseDuration(value, 'stale policy') };
}

// A pending journal whose environment lock is held by a live process on this
// machine is work in flight; one with no live owner is stalled and needs the
// same --apply command rerun. The label changes nothing about the exit code.
function pendingLiveness(file, env) {
  const lock = `${path.join(`${file}.env-locks`, env)}.lock`;
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return { liveness: 'stalled', pid: null };
  }
  if (owner?.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { liveness: 'unknown', pid: null };
  }
  return processIsAlive(owner.pid)
    ? { liveness: 'in-flight', pid: owner.pid }
    : { liveness: 'stalled', pid: null };
}

function formatLiveness({ liveness, pid }) {
  return pid == null ? liveness : `${liveness} pid ${pid}`;
}

function runStatus({ options, profile, projectRoot, environment }) {
  const { file, state } = readOverlayState(profile.project.slug, environment);
  const statusArgs = [...(options.env == null ? [] : [options.env]), ...options.passthrough];
  let receipt = null;
  let runtimeError = null;
  try {
    receipt = dispatchProjectCommand({
      profile,
      projectRoot,
      verb: 'status',
      args: statusArgs,
      apply: false,
      expected: {},
      environment,
      // JSON mode owns stdout; the project receipt is folded into the report.
      relay: !options.json,
    });
  } catch (error) {
    runtimeError = error;
    console.error(`overlay status: ${error.message}`);
  }
  const now = Date.now();
  const policy = resolveStalePolicy(options, profile, false);
  const selectedEntries = Object.entries(state.envs).filter(
    ([env]) => options.env == null || options.env === env
  );
  const selectedState = { ...state, envs: Object.fromEntries(selectedEntries) };
  const stale = policy
    ? staleOverlayEnvironments(selectedState, policy.milliseconds, now)
    : [];
  const attachments = selectedEntries.reduce(
    (count, [, record]) => count + Object.keys(record.services).length,
    0
  );
  let runtimeInventory = null;
  if (receipt != null) {
    try {
      runtimeInventory = inventoryFromReceipt(receipt);
    } catch (error) {
      runtimeError = error;
      console.error(`overlay status: ${error.message}`);
    }
  }
  const drift = compareInventory(state, runtimeInventory, options.env);
  const pending = Object.values(state.pending_by_env).filter(item => options.env == null || item.env === options.env);

  const exitCode =
    pending.length === 0 && runtimeError == null && stale.length === 0 && drift != null && drift.length === 0 ? 0 : 1;
  const staleEnvs = new Set(stale.map((entry) => entry.env));
  const sortedEntries = selectedEntries.sort(([left], [right]) => left.localeCompare(right));
  const pendingReport = pending.map((item) => ({ item, ...pendingLiveness(file, item.env) }));

  if (options.json) {
    const report = {
      ok: exitCode === 0,
      project: profile.project.slug,
      scope: options.env ?? null,
      stale_after: policy ? policy.value : null,
      project_status: { ok: runtimeError == null, error: runtimeError == null ? null : runtimeError.message },
      counts: {
        environments: sortedEntries.length,
        attachments,
        pending: pending.length,
        stale: stale.length,
        drift: drift == null ? null : drift.length,
      },
      environments: sortedEntries.map(([env, record]) => ({
        env,
        stale: staleEnvs.has(env),
        created_at: record.created_at ?? null,
        last_used_at: record.last_used_at,
        idle_ms: Math.max(0, now - Date.parse(record.last_used_at)),
        owner: record.agent ?? null,
        worktree: record.worktree ?? null,
        services: Object.entries(record.services).map(([service, spec]) => ({
          service,
          image: spec.image,
          upstream: spec.upstream ?? null,
          attached_at: spec.attached_at ?? null,
        })),
      })),
      pending: pendingReport.map(({ item, liveness, pid }) => ({
        verb: item.verb,
        env: item.env,
        service: item.service ?? null,
        image: item.image ?? null,
        started_at: item.started_at,
        worktree: item.worktree ?? null,
        agent: item.agent ?? null,
        liveness,
        pid,
      })),
      drift,
    };
    console.log(JSON.stringify(report, null, 2));
    return exitCode;
  }

  const lines = [
    `■ ${profile.project.slug} — overlay lifecycle`,
    `  environments  ${selectedEntries.length}`,
    `  attachments   ${attachments}`,
    `  pending       ${pending.length}`,
    policy
      ? `  stale         ${stale.length} (after ${policy.value})`
      : '  stale         notConfigured',
    runtimeError == null ? '  project-status  1/1' : '  project-status  0/1',
    drift == null ? '  drift         notMeasured' : `  drift         ${drift.length}`,
  ];
  for (const [env, record] of sortedEntries) {
    const staleLabel = staleEnvs.has(env) ? 'stale' : 'active';
    lines.push(
      `  ${env}  ${staleLabel}  idle ${formatAge(record.last_used_at, now)}  services ${Object.keys(record.services).length}  owner ${record.agent ?? 'unknown'}`
    );
  }
  for (const entry of pendingReport) lines.push(`  pending-item  ${operationTarget(entry.item)}  ${formatLiveness(entry)}`);
  for (const item of drift ?? []) lines.push(`  drift-item  ${formatDrift(item)}`);
  console.log(lines.join('\n'));
  return exitCode;
}

function runTouch({ options, profile, environment }) {
  const file = overlayStatePath(profile.project.slug, environment);
  return withEnvironmentLock(file, options.env, () => {
    updateRegistry(profile, environment, state => {
      const pending = pendingFor(state, options.env);
      if (pending) fail(`pending operation ${operationTarget(pending)} must be recovered before touch.`);
      const record = state.envs[options.env];
      if (!record) fail(`environment ${JSON.stringify(options.env)} is not tracked.`);
      record.last_used_at = new Date().toISOString();
    });
    console.log(`overlay touch 1/1: ${options.env} lease renewed`);
    return 0;
  });
}

function runPrune({ options, profile, projectRoot, environment, cwd }) {
  const policy = resolveStalePolicy(options, profile, true);
  const firstRead = readOverlayState(profile.project.slug, environment);
  const plan = staleOverlayEnvironments(firstRead.state, policy.milliseconds);
  const total = Object.keys(firstRead.state.envs).length;
  if (!options.apply) {
    console.log(`overlay prune plan: stale ${plan.length}/${total}, destroyed 0/${plan.length} (after ${policy.value})`);
    for (const { env } of plan) console.log(`  destroy ${env}`);
    return 0;
  }

  const recovering = Object.values(firstRead.state.pending_by_env)
    .filter(item => item.source === 'prune').map(item => item.env);
  const targets = [...new Set([...recovering, ...plan.map(({ env }) => env)])];
  let destroyed = 0;
  let attempted = 0;
  for (const env of targets) {
    let counted = false;
    try {
      withEnvironmentLock(firstRead.file, env, () => {
        // Touch or another prune may have won the environment lock since planning.
        const { state } = readOverlayState(profile.project.slug, environment);
        const pending = pendingFor(state, env);
        if (pending == null && !staleOverlayEnvironments(state, policy.milliseconds).some(item => item.env === env)) return;
        attempted++; counted = true;
        if (pending && pending.source !== 'prune') {
          fail(`pending operation ${operationTarget(pending)} must be recovered with the same --apply command before prune.`);
        }
        executeAppliedMutation({
          options: { ...options, verb: 'destroy', env, service: null, image: null },
          profile, projectRoot, environment, source: 'prune',
          owner: { worktree: safeRealpath(cwd), agent: environment.DEVINFRA_AGENT ?? environment.USER ?? 'unknown' },
        });
        destroyed++;
      });
    } catch (error) {
      if (!counted) attempted++;
      console.error(`overlay prune: retained ${env}: ${error.message}`);
    }
  }
  console.log(`overlay prune ${destroyed}/${attempted}: stale environments destroyed (after ${policy.value})`);
  return destroyed === attempted ? 0 : 1;
}

// ------------------------------------------------------------------ verify
// `overlay verify` drives the project's own adapter through the contract in a
// throwaway environment and counts what it observed. Grove's front door runs
// as a subprocess so the report owns stdout; observations dispatch the
// adapter's own status directly, because a case is only true when the runtime
// says so. Writing an adapter: skills/grove/references/adapter.md.
const VERIFY_CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const VERIFY_MUTABLE_TAG = 'overlay-verify-mutable-tag';

function verifyEnvironmentName(options) {
  if (options.env != null) return assertOverlayEnv(options.env);
  return `verify-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// A tag that cannot be immutable, pointing at the repository the caller named.
// Never an invented reference: it is derived from --image and is only ever
// used to see the request refused.
function mutableTagFrom(image) {
  return `${image.replace(/(?:@sha256:[0-9a-f]{64}|:[0-9a-f]{40})$/, '')}:${VERIFY_MUTABLE_TAG}`;
}

function lastLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function verifyFrontDoor(context, args) {
  const result = spawnSync(
    process.execPath,
    [
      VERIFY_CLI,
      'overlay',
      ...args,
      '--project',
      context.projectRoot,
      ...(context.passthrough.length === 0 ? [] : ['--', ...context.passthrough]),
    ],
    {
      cwd: context.cwd,
      encoding: 'utf8',
      // A verify run is a conformance probe, not seat work: it must not land
      // in a seat journal.
      env: { ...context.environment, DRYAD_ID: '' },
    }
  );
  if (result.error) fail(`cannot run the Grove front door: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// env null asks for the complete inventory, which is where an environment the
// project invented next to ours becomes visible.
function verifyObserve(context, env = null) {
  const receipt = dispatchProjectCommand({
    profile: context.profile,
    projectRoot: context.projectRoot,
    verb: 'status',
    args: [...(env == null ? [] : [env]), ...context.passthrough],
    apply: false,
    expected: {},
    environment: context.environment,
    relay: false,
  });
  const inventory = inventoryFromReceipt(receipt);
  if (inventory == null) fail('project status omitted environments; the runtime cannot be observed.');
  return { receipt, inventory };
}

function verifyRegistry(context) {
  return readOverlayState(context.profile.project.slug, context.environment).state;
}

// A probe the adapter must reject before touching the runtime. It is
// dispatched without --apply so a permissive adapter cannot mutate anything.
function verifyRefusalProbe(context, { service, image }) {
  try {
    const receipt = dispatchProjectCommand({
      profile: context.profile,
      projectRoot: context.projectRoot,
      verb: 'attach',
      args: [context.env, service, '--image', image, ...context.passthrough],
      apply: false,
      expected: {},
      environment: context.environment,
      relay: false,
    });
    return { refused: false, detail: `accepted the request (receipt ${JSON.stringify(receipt.verb)})` };
  } catch (error) {
    if (error.refused) return { refused: true, detail: error.message };
    return { refused: false, detail: `did not answer with a refusal receipt — ${error.message}` };
  }
}

const verifyPass = (evidence) => ({ status: 'pass', evidence });
const verifySkip = (evidence) => ({ status: 'skip', evidence });
const verifyFail = (evidence) => ({ status: 'fail', evidence });

function verifyCases(context) {
  const { env, image } = context;
  const attachable = context.profile.overlay.attachable[0];
  const declared = Object.keys(context.profile.services ?? {});
  const notAttachable =
    context.profile.overlay.sharedOnly[0] ??
    declared.find((name) => !context.profile.overlay.attachable.includes(name)) ??
    null;
  const progress = { created: false, attached: null, refusalReceipt: null };

  return [
    {
      name: 'plan-mutates-nothing',
      run() {
        if (!context.profile.overlay.planFirst) {
          const refused = verifyFrontDoor(context, ['create', env]);
          if (refused.status === 0) {
            return verifyFail('overlay.plan_first is false but a create without --apply was accepted');
          }
          return verifyPass('plan_first: false — a mutation without --apply is refused without dispatch');
        }
        const plan = verifyFrontDoor(context, ['create', env]);
        if (plan.status !== 0) {
          return verifyFail(`create plan exited ${plan.status}: ${lastLine(plan.stderr)}`);
        }
        const state = verifyRegistry(context);
        if (state.envs[env] || pendingFor(state, env)) {
          return verifyFail('the plan wrote lifecycle state for the environment');
        }
        const { inventory } = verifyObserve(context, env);
        if (inventory.has(env)) return verifyFail('the plan created the environment at runtime');
        return verifyPass('receipt plan: true; registry and runtime unchanged');
      },
    },
    {
      name: 'create-observed',
      run() {
        const applied = verifyFrontDoor(context, ['create', env, '--apply']);
        if (applied.status !== 0) {
          return verifyFail(`create --apply exited ${applied.status}: ${lastLine(applied.stderr)}`);
        }
        const { inventory } = verifyObserve(context, env);
        if (!inventory.has(env)) return verifyFail('status does not observe the environment after create');
        const state = verifyRegistry(context);
        if (!state.envs[env]) return verifyFail('create finished without a tracked lease');
        if (pendingFor(state, env)) return verifyFail('create finished with a pending journal');
        progress.created = true;
        return verifyPass(`status observed ${env}; lease tracked, nothing pending`);
      },
    },
    {
      name: 'create-idempotent',
      run() {
        if (!progress.created) return verifySkip('the environment was never created');
        const again = verifyFrontDoor(context, ['create', env, '--apply']);
        if (again.status !== 0) {
          return verifyFail(`the second create --apply exited ${again.status}: ${lastLine(again.stderr)}`);
        }
        const related = [...verifyObserve(context).inventory.keys()]
          .filter((name) => name === env || name.startsWith(`${env}-`))
          .sort();
        if (related.length !== 1 || related[0] !== env) {
          return verifyFail(`the second applied create left environments ${related.join(',') || 'none'}`);
        }
        return verifyPass(`two applied creates left 1 environment named ${env}`);
      },
    },
    {
      name: 'attach-refuses-unknown-service',
      run() {
        if (image == null) return verifySkip('--image is required for the attach cases');
        if (notAttachable == null) {
          return verifySkip('the profile declares no service outside overlay.attachable');
        }
        const front = verifyFrontDoor(context, ['attach', env, notAttachable, '--image', image, '--apply']);
        if (front.status === 0) {
          return verifyFail(`the front door attached ${notAttachable}, which is not in overlay.attachable`);
        }
        const probe = verifyRefusalProbe(context, { service: notAttachable, image });
        if (!probe.refused) return verifyFail(`the adapter ${probe.detail}`);
        progress.refusalReceipt ??= `attach ${notAttachable}`;
        return verifyPass(`front door and adapter both refuse ${notAttachable}`);
      },
    },
    {
      name: 'attach-refuses-mutable-tag',
      run() {
        if (image == null) return verifySkip('--image is required for the attach cases');
        const mutable = mutableTagFrom(image);
        const front = verifyFrontDoor(context, ['attach', env, attachable, '--image', mutable, '--apply']);
        if (front.status === 0) return verifyFail(`the front door accepted ${mutable}`);
        const probe = verifyRefusalProbe(context, { service: attachable, image: mutable });
        if (!probe.refused) return verifyFail(`the adapter ${probe.detail}`);
        progress.refusalReceipt ??= `attach ${attachable} with a mutable tag`;
        return verifyPass('front door and adapter both refuse a tag that is not a full sha or digest');
      },
    },
    {
      name: 'attach-observed',
      run() {
        if (image == null) return verifySkip('--image is required for the attach cases');
        if (!progress.created) return verifySkip('the environment was never created');
        const attached = verifyFrontDoor(context, ['attach', env, attachable, '--image', image, '--apply']);
        // Even a failed attach may have reached the runtime; the inventory case
        // wants whatever status now reports for that service.
        const services = verifyObserve(context, env).inventory.get(env);
        if (services?.has(attachable)) progress.attached = attachable;
        if (attached.status !== 0) {
          return verifyFail(`attach --apply exited ${attached.status}: ${lastLine(attached.stderr)}`);
        }
        const observed = services?.get(attachable);
        if (observed == null) {
          return verifyFail(`status does not observe ${attachable} as a service observation after attach`);
        }
        if (observed.image !== image || observed.ready !== true) {
          return verifyFail(`status observes image ${observed.image} ready ${observed.ready}`);
        }
        return verifyPass(`status observes ${attachable} running the requested image, ready`);
      },
    },
    {
      name: 'status-inventory-shape',
      run() {
        if (progress.attached == null) {
          return verifySkip('no service is attached, so per-service observations cannot be measured');
        }
        const { receipt } = verifyObserve(context, env);
        const entry = receipt.environments.find((item) => item?.env === env);
        if (!Array.isArray(entry?.services)) {
          return verifyFail(`the environment entry has no services list (${JSON.stringify(entry?.services)})`);
        }
        const names = entry.services.filter((service) => typeof service === 'string');
        if (names.length > 0) {
          return verifyFail(`services are reported name-only (${names.join(',')}); attach cannot finalize`);
        }
        for (const service of entry.services) {
          if (!isMap(service) || typeof service.service !== 'string') {
            return verifyFail('a service entry is not an observation object');
          }
          if (typeof service.image !== 'string' || typeof service.ready !== 'boolean') {
            return verifyFail(`${service.service} lacks an observed image or a boolean ready`);
          }
        }
        return verifyPass(`${entry.services.length} service observation(s) carry service, image and ready`);
      },
    },
    {
      name: 'receipt-identity',
      run() {
        const receipt = dispatchProjectCommand({
          profile: context.profile,
          projectRoot: context.projectRoot,
          verb: 'create',
          args: [env, ...context.passthrough],
          apply: false,
          expected: { env },
          environment: context.environment,
          relay: false,
        });
        const other = `${env}-x`.slice(0, 63);
        try {
          validateReceipt(receipt, { verb: 'create', env: other });
        } catch {
          return verifyPass(`the receipt echoes env ${env}; one naming ${other} is rejected`);
        }
        return verifyFail('a receipt whose environment disagrees with the request was accepted');
      },
    },
    {
      name: 'refusal-leaves-no-journal',
      run() {
        if (!progress.created) return verifySkip('the environment was never created');
        const blocked = pendingFor(verifyRegistry(context), env);
        if (blocked != null) {
          return verifySkip(`a pending ${operationTarget(blocked)} from an earlier case blocks this probe`);
        }
        // The image is rejected before any dispatch, so nothing can reach the
        // runtime; what is measured is that the refusal locks nothing.
        const refused = verifyFrontDoor(context, ['attach', env, attachable, '--image', VERIFY_MUTABLE_TAG, '--apply']);
        if (refused.status === 0) return verifyFail('a refused attach reported success');
        const state = verifyRegistry(context);
        if (pendingFor(state, env)) {
          return verifyFail(`the refusal left a pending ${operationTarget(pendingFor(state, env))} journal`);
        }
        const touched = verifyFrontDoor(context, ['touch', env]);
        if (touched.status !== 0) {
          return verifyFail(`the environment is locked after a refusal: ${lastLine(touched.stderr)}`);
        }
        const seen = progress.refusalReceipt == null
          ? 'no adapter refusal receipt was probed'
          : `adapter refusal receipt observed on ${progress.refusalReceipt}`;
        return verifyPass(`nothing pending, lease still renewable; ${seen}`);
      },
    },
    {
      name: 'destroy-observed',
      run() {
        if (!progress.created) return verifySkip('the environment was never created');
        const blocked = pendingFor(verifyRegistry(context), env);
        if (blocked != null) {
          return verifySkip(`a pending ${operationTarget(blocked)} from an earlier case blocks destroy`);
        }
        const destroyed = verifyFrontDoor(context, ['destroy', env, '--apply']);
        if (destroyed.status !== 0) {
          return verifyFail(`destroy --apply exited ${destroyed.status}: ${lastLine(destroyed.stderr)}`);
        }
        const { inventory } = verifyObserve(context, env);
        if (inventory.has(env)) return verifyFail('status still observes the environment after destroy');
        if (verifyRegistry(context).envs[env]) return verifyFail('destroy left the lease tracked');
        return verifyPass(`status observes ${env} absent; lease released`);
      },
    },
  ];
}

// Verify refused to start on a name that already existed, so this environment
// and its journal belong to verify alone: it clears both, whatever failed.
function verifyCleanup(context) {
  const { env } = context;
  try {
    const state = verifyRegistry(context);
    const tracked = Boolean(state.envs[env]) || pendingFor(state, env) != null;
    if (!tracked && !verifyObserve(context, env).inventory.has(env)) {
      return { ok: true, detail: `${env} is absent` };
    }
    if (pendingFor(state, env) != null) {
      updateRegistry(context.profile, context.environment, (current) => {
        delete current.pending_by_env[env];
      });
    }
    const destroyed = verifyFrontDoor(context, ['destroy', env, '--apply']);
    if (destroyed.status !== 0) {
      return { ok: false, detail: `destroy ${env} failed: ${lastLine(destroyed.stderr)}` };
    }
    return { ok: true, detail: `destroyed ${env}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function formatVerifyReport(report) {
  const lines = [
    `■ ${report.project} — overlay verify (env ${report.env})`,
    `  cases         ${report.counts.passed}/${report.counts.cases - report.counts.skipped}`,
    `  skipped       ${report.counts.skipped}`,
    `  cleanup       ${report.cleanup.ok ? '1/1' : '0/1'}  ${report.cleanup.detail}`,
  ];
  for (const item of report.cases) {
    lines.push(`  ${item.status.padEnd(4)}  ${item.name.padEnd(30)}  ${item.evidence}`);
  }
  return lines.join('\n');
}

function runOverlayVerify({ options, profile, projectRoot, environment, cwd }) {
  if (options.image != null) assertOverlayImage(options.image);
  const env = verifyEnvironmentName(options);
  const context = {
    profile,
    projectRoot,
    environment,
    cwd,
    env,
    image: options.image ?? null,
    passthrough: options.passthrough,
  };

  const state = verifyRegistry(context);
  if (state.envs[env] || pendingFor(state, env)) {
    fail(`environment ${JSON.stringify(env)} is already tracked; verify needs a name it can throw away.`);
  }
  if (verifyObserve(context, env).inventory.has(env)) {
    fail(`environment ${JSON.stringify(env)} already exists at runtime; verify needs a name it can throw away.`);
  }

  const results = [];
  for (const item of verifyCases(context)) {
    let outcome;
    try {
      outcome = item.run();
    } catch (error) {
      outcome = verifyFail(error.message);
    }
    results.push({ name: item.name, ...outcome });
  }
  const cleanup = verifyCleanup(context);

  const counts = {
    cases: results.length,
    passed: results.filter((item) => item.status === 'pass').length,
    failed: results.filter((item) => item.status === 'fail').length,
    skipped: results.filter((item) => item.status === 'skip').length,
  };
  const report = {
    ok: counts.failed === 0 && cleanup.ok,
    project: profile.project.slug,
    env,
    image: context.image,
    counts,
    cleanup,
    cases: results,
  };
  console.log(options.json ? JSON.stringify(report, null, 2) : formatVerifyReport(report));
  return report.ok ? 0 : 1;
}

export function runOverlayLifecycle({
  options,
  profile,
  profilePath,
  environment = process.env,
  cwd = process.cwd(),
}) {
  assertOverlayActive(profile);
  const projectRoot = projectRootFromProfile(profilePath);
  // The project command runs with cwd = project root; the caller's own
  // directory (a seat worktree, usually) reaches it as GROVE_CALLER_CWD so an
  // adapter can default its worktree argument without a passthrough flag.
  environment = { ...environment, GROVE_CALLER_CWD: safeRealpath(cwd) };
  switch (options.verb) {
    case 'status':
      return runStatus({ options, profile, projectRoot, environment });
    case 'verify':
      return runOverlayVerify({ options, profile, projectRoot, environment, cwd });
    case 'touch':
      return runTouch({ options, profile, environment });
    case 'prune':
      return runPrune({ options, profile, projectRoot, environment, cwd });
    case 'create':
    case 'attach':
    case 'detach':
    case 'destroy':
      return runMutation({ options, profile, projectRoot, environment, cwd });
    default:
      fail(`unsupported lifecycle command ${JSON.stringify(options.verb)}.`);
  }
}

export function overlayHelp(cli = 'de-novo skills') {
  return `project overlay lifecycle (project workload command + Grove lease registry)

usage:
  ${cli} overlay status [ENV] [--project ROOT] [--stale-after 12h] [--json]
  ${cli} overlay create ENV [--project ROOT] [--apply]
  ${cli} overlay attach ENV SERVICE --image FULL_SHA [--project ROOT] [--apply]
  ${cli} overlay detach ENV SERVICE [--project ROOT] [--apply]
  ${cli} overlay destroy ENV [--project ROOT] [--apply]
  ${cli} overlay touch ENV [--project ROOT]
  ${cli} overlay prune [--project ROOT] [--stale-after 12h] [--apply]
  ${cli} overlay verify [--project ROOT] [--env NAME] [--image FULL_SHA] [--json]

Workload mutations are plans unless --apply is present; touch only renews the
lease. Applied mutations finalize only after status observes their runtime
postcondition; rerun the same --apply command to recover a pending operation.
prune never destroys without --apply. verify drives the project's own adapter
through the contract in a throwaway environment and counts the result; pass
--image to include the attach cases. Project-specific arguments may follow --.
There is no infra down.`;
}
