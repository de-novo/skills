#!/usr/bin/env node
// Contract fixture for Grove overlay lifecycle tests. It starts no workload.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const [verb, ...args] = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};
const apply = args.includes('--apply');
const planFirst = process.env.GROVE_OVERLAY_STUB_PLAN_FIRST !== 'false';
const effectiveApply = apply || !planFirst;
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--apply' || arg === '--fail' || arg === '--malformed') continue;
  if (arg === '--image') {
    index += 1;
    continue;
  }
  if (!arg.startsWith('--')) positional.push(arg);
}

if (process.env.GROVE_OVERLAY_STUB_LOG) {
  appendFileSync(
    process.env.GROVE_OVERLAY_STUB_LOG,
    `${JSON.stringify({ verb, args, apply, cwd: process.cwd(), callerCwd: process.env.GROVE_CALLER_CWD ?? null })}\n`,
    'utf8'
  );
}

if (args.includes('--malformed')) {
  console.log('not-json');
  process.exit(0);
}

// Refuse before any mutation: the receipt says so and the exit is non-zero.
if (process.env.GROVE_OVERLAY_STUB_REFUSE === 'true' && verb !== 'status') {
  console.log(JSON.stringify({ ok: false, verb, env: positional[0], service: positional[1], image: valueAfter('--image'), mutated: false, error: 'refused by fixture' }));
  process.exit(1);
}

// A conforming adapter refuses a request it will not honor before touching the
// runtime. The switches let a test make this fixture non-conforming.
const refuse = (error) => {
  console.log(JSON.stringify({
    ok: false, verb, env: positional[0], service: positional[1],
    image: valueAfter('--image'), mutated: false, error,
  }));
  process.exit(1);
};
if (verb === 'attach') {
  const image = valueAfter('--image') ?? '';
  const attachable = (process.env.GROVE_OVERLAY_STUB_ATTACHABLE ?? '').split(',').filter(Boolean);
  if (
    attachable.length > 0 &&
    !attachable.includes(positional[1]) &&
    process.env.GROVE_OVERLAY_STUB_ACCEPT_ANY_SERVICE !== 'true'
  ) {
    refuse(`service ${positional[1]} is not overlaid here`);
  }
  if (
    !/:[0-9a-f]{40}$/.test(image) &&
    !/@sha256:[0-9a-f]{64}$/.test(image) &&
    process.env.GROVE_OVERLAY_STUB_ACCEPT_ANY_IMAGE !== 'true'
  ) {
    refuse(`image ${image} is not a full sha or digest`);
  }
}

const result = {
  ok:
    !args.includes('--fail') &&
    (!process.env.GROVE_OVERLAY_STUB_FAIL_ENV ||
      process.env.GROVE_OVERLAY_STUB_FAIL_ENV !== positional[0]),
  verb,
  plan: verb === 'status' ? false : planFirst && !apply,
};
if (positional[0]) result.env = positional[0];
if (positional[1]) result.service = positional[1];
if (verb === 'attach') result.image = valueAfter('--image');

const runtimeFile = process.env.GROVE_OVERLAY_STUB_RUNTIME_STATE;
const readRuntime = () => {
  if (!runtimeFile || !existsSync(runtimeFile)) return { environments: {} };
  return JSON.parse(readFileSync(runtimeFile, 'utf8'));
};
const writeRuntime = (runtime) => {
  if (runtimeFile) writeFileSync(runtimeFile, JSON.stringify(runtime), 'utf8');
};
const observe = (services) => {
  const sorted = [...services].sort((a, b) => a.service.localeCompare(b.service));
  return process.env.GROVE_OVERLAY_STUB_NAME_ONLY === 'true'
    ? sorted.map((item) => item.service)
    : sorted;
};
const runtimeInventory = (runtime) => Object.entries(runtime.environments)
  .flatMap(([env, services]) => {
    const entry = { env, services: observe(services) };
    // A non-idempotent backend: every applied create leaves another environment
    // next to the one that was asked for.
    const copies = process.env.GROVE_OVERLAY_STUB_DUPLICATE_ENVS === 'true'
      ? runtime.creates?.[env] ?? 1
      : 1;
    return Array.from({ length: copies }, (unused, index) => (
      index === 0 ? entry : { env: `${env}-${index + 1}`, services: [] }
    ));
  })
  .sort((left, right) => left.env.localeCompare(right.env));

function assertPendingIntent() {
  if (process.env.GROVE_OVERLAY_STUB_REQUIRE_PENDING !== 'true') return;
  const stateFile = join(process.env.GROVE_STATE_DIR, 'lifecycle-test.yml');
  if (!existsSync(stateFile)) throw new Error('pending intent is missing before dispatch');
  const pending = parse(readFileSync(stateFile, 'utf8')).pending_by_env?.[positional[0]];
  if (
    !pending ||
    pending.verb !== verb ||
    pending.env !== positional[0] ||
    (positional[1] ?? null) !== (pending.service ?? null) ||
    (valueAfter('--image') ?? null) !== (pending.image ?? null)
  ) {
    throw new Error('pending intent does not match the dispatched mutation');
  }
}

function mutateRuntime() {
  const runtime = readRuntime();
  const environment = positional[0];
  const service = positional[1];
  if (verb === 'create') {
    runtime.environments[environment] ??= [];
    runtime.creates ??= {};
    runtime.creates[environment] = (runtime.creates[environment] ?? 0) + 1;
  }
  else if (verb === 'attach') {
    runtime.environments[environment] ??= [];
    runtime.environments[environment] = runtime.environments[environment]
      .filter((item) => item.service !== service);
    runtime.environments[environment].push({ service, image: valueAfter('--image'), ready: true });
  } else if (verb === 'detach') {
    runtime.environments[environment] = (runtime.environments[environment] ?? [])
      .filter((item) => item.service !== service);
  } else if (verb === 'destroy') {
    const lag = Number(process.env.GROVE_OVERLAY_STUB_DESTROY_STATUS_LAG ?? 0);
    if (lag > 0 && runtimeFile) {
      writeFileSync(
        `${runtimeFile}.destroy-lag`,
        JSON.stringify({ env: environment, remaining: lag }),
        'utf8'
      );
    } else {
      delete runtime.environments[environment];
    }
  }
  writeRuntime(runtime);
}

try {
  if (verb !== 'status' && effectiveApply) assertPendingIntent();
  const skipMutation = process.env.GROVE_OVERLAY_STUB_SKIP_RUNTIME_MUTATION;
  if (
    result.ok &&
    verb !== 'status' &&
    effectiveApply &&
    skipMutation !== 'true' &&
    skipMutation !== verb
  ) {
    mutateRuntime();
  }
  if (result.ok && effectiveApply && process.env.GROVE_OVERLAY_STUB_FAIL_AFTER_MUTATION === 'true') {
    console.error('stub interrupted after runtime mutation');
    process.exit(9);
  }
} catch (error) {
  console.error(error.message);
  process.exit(8);
}

if (verb === 'status') {
  const destroyLagFile = runtimeFile ? `${runtimeFile}.destroy-lag` : null;
  if (destroyLagFile && existsSync(destroyLagFile)) {
    const delayed = JSON.parse(readFileSync(destroyLagFile, 'utf8'));
    if (delayed.remaining > 0) {
      delayed.remaining -= 1;
      writeFileSync(destroyLagFile, JSON.stringify(delayed), 'utf8');
    } else {
      const runtime = readRuntime();
      delete runtime.environments[delayed.env];
      writeRuntime(runtime);
      unlinkSync(destroyLagFile);
    }
  }
  let inventory;
  if (process.env.GROVE_OVERLAY_STUB_OMIT_INVENTORY === 'true') {
    inventory = null;
  } else if (process.env.GROVE_OVERLAY_STUB_INVENTORY) {
    inventory = JSON.parse(process.env.GROVE_OVERLAY_STUB_INVENTORY);
  } else {
    const lag = Number(process.env.GROVE_OVERLAY_STUB_STATUS_LAG ?? 0);
    const lagFile = runtimeFile ? `${runtimeFile}.status-lag` : null;
    let remaining = lagFile && existsSync(lagFile)
      ? Number(readFileSync(lagFile, 'utf8'))
      : lag;
    if (lagFile && !existsSync(lagFile)) writeFileSync(lagFile, String(remaining), 'utf8');
    if (remaining > 0) {
      remaining -= 1;
      if (lagFile) writeFileSync(lagFile, String(remaining), 'utf8');
      inventory = [];
    } else {
      inventory = runtimeInventory(readRuntime());
    }
  }
  if (positional[0] && Array.isArray(inventory)) {
    inventory = inventory.filter((item) => item.env === positional[0]);
  }
  if (inventory != null) result.environments = inventory;
}

console.log(JSON.stringify(result));
