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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
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
const STATE_VERSION = 1;
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
  let staleAfter = null;
  let apply = false;
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
  if (verb !== 'attach' && image != null) fail(`--image is not valid for ${verb}.`);
  if (!['status', 'prune'].includes(verb) && staleAfter != null) {
    fail(`--stale-after is not valid for ${verb}.`);
  }
  if (['status', 'touch'].includes(verb) && apply) {
    fail(`--apply is not valid for ${verb}.`);
  }
  if (verb === 'touch' && passthrough.length > 0) {
    fail('touch does not dispatch project-specific arguments.');
  }

  const env = positionals[0] == null ? null : assertOverlayEnv(positionals[0]);
  return {
    help: false,
    verb,
    env,
    service: positionals[1] ?? null,
    project,
    image,
    staleAfter,
    apply,
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
  return { version: STATE_VERSION, project: slug, envs: {}, pending: null };
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
  if (!isMap(state) || state.version !== STATE_VERSION || state.project !== slug) {
    fail(`${file}: registry must have version ${STATE_VERSION} and project ${JSON.stringify(slug)}.`);
  }
  if (!isMap(state.envs)) fail(`${file}: envs must be a map.`);
  if (!Object.hasOwn(state, 'pending')) state.pending = null;
  if (state.pending != null) {
    const pending = state.pending;
    if (!isMap(pending) || !['create', 'attach', 'detach', 'destroy'].includes(pending.verb)) {
      fail(`${file}: pending must be null or a lifecycle mutation.`);
    }
    assertOverlayEnv(pending.env);
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
    fail(`${file}: cannot read registry: ${error.message}`);
  }
  return { file, state: validateState(state, slug, file) };
}

function atomicWriteState(file, state) {
  if (Object.keys(state.envs).length === 0 && state.pending == null) {
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

function acquireStateLock(file) {
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
      unlinkSync(lock);
      descriptor = open();
    } else {
      const detail = owner ? `pid ${owner.pid ?? '?'} on ${owner.host ?? '?'}` : 'unknown owner';
      fail(`registry is locked by ${detail}; retry after that lifecycle command finishes.`);
    }
  }

  return () => {
    closeSync(descriptor);
    if (existsSync(lock)) unlinkSync(lock);
  };
}

function withStateLock(file, operation) {
  const release = acquireStateLock(file);
  try {
    return operation();
  } finally {
    release();
  }
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
  if (state.pending == null) return;
  const instruction = `rerun the pending ${operationTarget(state.pending)} operation with --apply`;
  if (!apply || !pendingMatchesOptions(state.pending, options)) {
    fail(`pending operation ${operationTarget(state.pending)} must be recovered first; ${instruction}.`);
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
      return services?.has(operation.service) === true;
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
  state,
  file,
  options,
  profile,
  projectRoot,
  environment,
  owner,
  source,
}) {
  const commandTimeout = timeoutFromEnvironment(environment);
  const verifyTimeout = verifyTimeoutFromEnvironment(environment);
  let pending = state.pending;
  if (pending == null) {
    pending = newPendingOperation(options, owner, source);
    state.pending = pending;
    atomicWriteState(file, state);
  } else {
    assertPendingCompatible(state, options, true);
    console.log(`recovered pending ${operationTarget(pending)}: redispatching idempotently`);
  }

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
    applyMutation(state, options, receipt, new Date().toISOString(), owner);
    state.pending = null;
    atomicWriteState(file, state);
    return receipt;
  } catch (error) {
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
  assertPendingCompatible(firstRead.state, options, options.apply);
  assertMutationInputs(options, profile, firstRead.state);
  if (!options.apply) {
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

  return withStateLock(firstRead.file, () => {
    const { file, state } = readOverlayState(profile.project.slug, environment);
    assertPendingCompatible(state, options, true);
    assertMutationInputs(options, profile, state);
    executeAppliedMutation({
      state,
      file,
      options,
      profile,
      projectRoot,
      environment,
      source: 'mutation',
      owner: {
        worktree: safeRealpath(cwd),
        agent: environment.DEVINFRA_AGENT ?? environment.USER ?? 'unknown',
      },
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
    else if (Array.isArray(item.services) && item.services.every((value) => typeof value === 'string')) {
      services = item.services;
    } else {
      fail(`status receipt services for ${env} must be a list of names.`);
    }
    inventory.set(env, new Set(services));
  }
  return inventory;
}

function registryInventory(state) {
  return new Map(
    Object.entries(state.envs).map(([env, record]) => [env, new Set(Object.keys(record.services))])
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
      drift.push(`${env}: runtime environment is untracked`);
      continue;
    }
    if (!remote) {
      drift.push(`${env}: registry entry is missing at runtime`);
      continue;
    }
    const localNames = [...local].sort();
    const remoteNames = [...remote].sort();
    if (JSON.stringify(localNames) !== JSON.stringify(remoteNames)) {
      drift.push(
        `${env}: services differ (registry ${localNames.join(',') || '-'}; runtime ${remoteNames.join(',') || '-'})`
      );
    }
  }
  return drift;
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

function runStatus({ options, profile, projectRoot, environment }) {
  const { state } = readOverlayState(profile.project.slug, environment);
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

  const lines = [
    `■ ${profile.project.slug} — overlay lifecycle`,
    `  environments  ${selectedEntries.length}`,
    `  attachments   ${attachments}`,
    `  pending       ${state.pending == null ? 0 : 1}`,
    policy
      ? `  stale         ${stale.length} (after ${policy.value})`
      : '  stale         notConfigured',
    runtimeError == null ? '  project-status  1/1' : '  project-status  0/1',
    drift == null ? '  drift         notMeasured' : `  drift         ${drift.length}`,
  ];
  for (const [env, record] of selectedEntries.sort(([left], [right]) => left.localeCompare(right))) {
    const staleLabel = stale.some((entry) => entry.env === env) ? 'stale' : 'active';
    lines.push(
      `  ${env}  ${staleLabel}  idle ${formatAge(record.last_used_at, now)}  services ${Object.keys(record.services).length}  owner ${record.agent ?? 'unknown'}`
    );
  }
  if (state.pending != null) lines.push(`  pending-item  ${operationTarget(state.pending)}`);
  for (const item of drift ?? []) lines.push(`  drift-item  ${item}`);
  console.log(lines.join('\n'));
  return state.pending == null &&
    runtimeError == null &&
    stale.length === 0 &&
    (drift == null || drift.length === 0)
    ? 0
    : 1;
}

function runTouch({ options, profile, environment }) {
  const firstRead = readOverlayState(profile.project.slug, environment);
  return withStateLock(firstRead.file, () => {
    const { file, state } = readOverlayState(profile.project.slug, environment);
    if (state.pending != null) {
      fail(`pending operation ${operationTarget(state.pending)} must be recovered before touch.`);
    }
    const record = state.envs[options.env];
    if (!record) fail(`environment ${JSON.stringify(options.env)} is not tracked.`);
    record.last_used_at = new Date().toISOString();
    atomicWriteState(file, state);
    console.log(`overlay touch 1/1: ${options.env} lease renewed`);
    return 0;
  });
}

function runPrune({ options, profile, projectRoot, environment, cwd }) {
  const policy = resolveStalePolicy(options, profile, true);
  const firstRead = readOverlayState(profile.project.slug, environment);
  if (firstRead.state.pending != null && !options.apply) {
    fail(
      `pending operation ${operationTarget(firstRead.state.pending)} must be recovered before a prune plan.`
    );
  }
  const plan = staleOverlayEnvironments(firstRead.state, policy.milliseconds);
  const total = Object.keys(firstRead.state.envs).length;
  if (!options.apply) {
    console.log(
      `overlay prune plan: stale ${plan.length}/${total}, destroyed 0/${plan.length} (after ${policy.value})`
    );
    for (const { env } of plan) console.log(`  destroy ${env}`);
    return 0;
  }

  return withStateLock(firstRead.file, () => {
    const { file, state } = readOverlayState(profile.project.slug, environment);
    if (state.pending != null && state.pending.source !== 'prune') {
      fail(
        `pending operation ${operationTarget(state.pending)} must be recovered with the same --apply command before prune.`
      );
    }
    const stale = staleOverlayEnvironments(state, policy.milliseconds);
    const targets = state.pending == null
      ? stale.map(({ env }) => env)
      : [
          state.pending.env,
          ...stale.map(({ env }) => env).filter((env) => env !== state.pending.env),
        ];
    let destroyed = 0;
    for (const env of targets) {
      const mutation = {
        ...options,
        verb: 'destroy',
        env,
        service: null,
        image: null,
      };
      try {
        executeAppliedMutation({
          state,
          file,
          options: mutation,
          profile,
          projectRoot,
          environment,
          source: 'prune',
          owner: {
            worktree: safeRealpath(cwd),
            agent: environment.DEVINFRA_AGENT ?? environment.USER ?? 'unknown',
          },
        });
        destroyed += 1;
      } catch (error) {
        console.error(`overlay prune: retained ${env}: ${error.message}`);
        break;
      }
    }
    console.log(
      `overlay prune ${destroyed}/${targets.length}: stale environments destroyed (after ${policy.value})`
    );
    return destroyed === targets.length ? 0 : 1;
  });
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
  switch (options.verb) {
    case 'status':
      return runStatus({ options, profile, projectRoot, environment });
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
  ${cli} overlay status [ENV] [--project ROOT] [--stale-after 12h]
  ${cli} overlay create ENV [--project ROOT] [--apply]
  ${cli} overlay attach ENV SERVICE --image FULL_SHA [--project ROOT] [--apply]
  ${cli} overlay detach ENV SERVICE [--project ROOT] [--apply]
  ${cli} overlay destroy ENV [--project ROOT] [--apply]
  ${cli} overlay touch ENV [--project ROOT]
  ${cli} overlay prune [--project ROOT] [--stale-after 12h] [--apply]

Workload mutations are plans unless --apply is present; touch only renews the
lease. Applied mutations finalize only after status observes their runtime
postcondition; rerun the same --apply command to recover a pending operation.
prune never destroys without --apply. Project-specific arguments may follow
--. There is no infra down.`;
}
