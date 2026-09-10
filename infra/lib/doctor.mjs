// de-novo doctor — what this machine and this project have, read once and
// reported once, before anything is run. Read-only by contract: it never
// installs, links, starts an engine, seeds trust, writes a hook, or writes
// a database. Every row says one of ready, missing, invalid, unsupported,
// or unknown, and `next` says what a person does about it.
//
//   de-novo skills doctor [--project ROOT] [--json]
//   de-novo skills capabilities [--json]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { GROVE_ADDRESSING_FILE, GROVE_ADDRESSING_LOCAL_FILE, loadGroveAddressing, renderProjectUrls, resolveAddressing } from './addressing.mjs';
import { DRYAD_PROFILE_RELPATH, parseDryadProfile, readDryadState } from './dryad.mjs';
import { LOCAL_RELPATH as FORESTER_LOCAL, PLAN_RELPATH as FORESTER_PLAN, parseForesterLocal, parseForesterPlan, readMachine, resolveBudget } from './forester.mjs';
import { resolveExecutable } from './forester-serve.mjs';
import { VALUES_RELPATH as HERBARIUM_VALUES, parseHerbariumValues } from './herbarium.mjs';
import { VALUES_RELPATH as MYCELIUM_VALUES, describeMode, parseMyceliumValues } from './mycelium.mjs';
import { parseProfile } from './profile.mjs';

export const DOCTOR_SCHEMA = 1;
export const CATALOG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_PROFILE = '.agents/runtime-profile.yml';
// The Node range the suite has been run on: 24 in CI, 26 on a laptop.
export const NODE_SUPPORTED = 24;
export const STATES = Object.freeze(['ready', 'missing', 'invalid', 'unsupported', 'unknown']);
// The executables a launch or a backend may need. Their absence is a fact,
// never an error: a project that names none of them needs none.
const EXECUTABLES = Object.freeze(['git', 'docker', 'k3d', 'claude', 'codex']);

function fail(message) {
  throw new Error(`doctor: ${message}`);
}

function row(state, detail = null, extra = {}) {
  return { state, detail, ...extra };
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// A values file: absent, unreadable, refused by its parser, or parsed.
function valuesFile(file, parser) {
  if (!existsSync(file)) return row('missing', null, { file });
  try {
    return row('ready', null, { file, values: parser(readFileSync(file, 'utf8'), file) });
  } catch (error) {
    return row('invalid', error.message, { file });
  }
}

// --------------------------------------------------------------- catalog

export function readCatalogPackage(root = CATALOG_ROOT) {
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  return { file, name: pkg.name, version: pkg.version ?? null, engines: pkg.engines ?? null };
}

export function publishedSkills(root = CATALOG_ROOT) {
  const dir = path.join(root, 'skills');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => {
      const text = readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
      const userInvoked = /^disable-model-invocation:\s*true/m.test(text);
      return { name: entry.name, invocation: userInvoked ? 'user' : 'model', digest: digest(text) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function catalogSection(environment) {
  const pkg = readCatalogPackage();
  const major = Number(process.versions.node.split('.')[0]);
  const pty = existsSync(path.join(CATALOG_ROOT, 'node_modules', '@lydell', 'node-pty'));
  return {
    root: CATALOG_ROOT,
    package: pkg.name,
    version: pkg.version,
    node: row(major >= NODE_SUPPORTED ? 'ready' : 'unsupported', `${process.version}; the suite runs on ${NODE_SUPPORTED} and above`, { version: process.version, supported: `>=${NODE_SUPPORTED}` }),
    dependencies: row(existsSync(path.join(CATALOG_ROOT, 'node_modules', 'yaml')) ? 'ready' : 'missing', existsSync(path.join(CATALOG_ROOT, 'node_modules', 'yaml')) ? null : 'run npm install in the catalog checkout'),
    pty: row(pty ? 'ready' : 'missing', pty ? 'forester serve can hold sessions' : 'optional: forester serve needs @lydell/node-pty; every other verb works without it'),
    addressing: row(existsSync(GROVE_ADDRESSING_FILE) ? 'ready' : 'missing', null, { file: GROVE_ADDRESSING_FILE, local: existsSync(GROVE_ADDRESSING_LOCAL_FILE) ? GROVE_ADDRESSING_LOCAL_FILE : null }),
    executables: Object.fromEntries(EXECUTABLES.map((name) => {
      const found = resolveExecutable(name, environment);
      return [name, row(found ? 'ready' : 'missing', found)];
    })),
    machine_cap: (() => {
      try {
        const machine = readMachine(environment);
        return row('ready', machine.parallel == null ? 'no cap' : `cap ${machine.parallel}`, { parallel: machine.parallel });
      } catch (error) {
        return row('invalid', error.message);
      }
    })(),
  };
}

// --------------------------------------------------------------- project

function findUpward(start, relatives) {
  let current = path.resolve(start);
  for (;;) {
    for (const relative of relatives) if (existsSync(path.join(current, relative))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveDoctorProject({ project = null, environment = process.env, cwd = process.cwd() }) {
  if (project != null) return path.resolve(cwd, project);
  if (environment.DRYAD_PROJECT) return path.resolve(cwd, environment.DRYAD_PROJECT);
  return findUpward(cwd, [RUNTIME_PROFILE, DRYAD_PROFILE_RELPATH]);
}

// Which of the catalog's skills a project carries as copies, and whether
// each copy is the catalog's text. A project that loads skills through
// the plugin or a checkout link carries none and needs none.
function skillCopies(root, catalogSkills) {
  const homes = ['.agents/skills', '.claude/skills', '.codex/skills', '.cursor/skills'];
  const out = {};
  for (const skill of catalogSkills) {
    const found = [];
    for (const home of homes) {
      const file = path.join(root, home, skill.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      let text = null;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        text = null;
      }
      found.push({ path: path.join(home, skill.name, 'SKILL.md'), same_as_catalog: text == null ? null : digest(text) === skill.digest });
    }
    out[skill.name] = found;
  }
  return out;
}

function projectSection(root, environment) {
  const grove = valuesFile(path.join(root, RUNTIME_PROFILE), parseProfile);
  const dryad = valuesFile(path.join(root, DRYAD_PROFILE_RELPATH), parseDryadProfile);
  const plan = valuesFile(path.join(root, FORESTER_PLAN), parseForesterPlan);
  const local = valuesFile(path.join(root, FORESTER_LOCAL), parseForesterLocal);
  const mycelium = valuesFile(path.join(root, MYCELIUM_VALUES), parseMyceliumValues);
  const herbarium = valuesFile(path.join(root, HERBARIUM_VALUES), parseHerbariumValues);
  const section = { root, grove: null, dryad: null, forester: null, mycelium: null, herbarium: null, skills: skillCopies(root, publishedSkills()) };

  // Grove: the profile, the overlay mode, the backend it names, the hostnames it renders.
  if (grove.state === 'ready') {
    const profile = grove.values;
    const overlayMode = profile.overlay?.mode === 'on' ? 'on' : 'off';
    let hostnames = row('unknown');
    try {
      const addressing = resolveAddressing(profile, { profilePath: grove.file });
      const urls = renderProjectUrls(profile, addressing, {});
      hostnames = row('ready', `${urls.shared.length} rendered; rendering is not resolving`, { tld: addressing.tld, shared: urls.shared.map((entry) => entry.host) });
    } catch (error) {
      hostnames = row('invalid', error.message);
    }
    const command = profile.overlay?.command ?? profile.runtime?.commands?.overlay ?? null;
    const backend = command != null ? row('ready', 'the project names its own overlay command') : row('missing', overlayMode === 'on' ? 'overlay is on but runtime.commands.overlay names no command' : 'no overlay command; none needed while overlay is off');
    section.grove = { profile: row('ready', null, { file: grove.file, slug: profile.project.slug }), overlay: row('ready', overlayMode, { mode: overlayMode, create_on: profile.overlay?.createOn ?? null }), backend, hostnames };
  } else {
    section.grove = { profile: grove };
  }

  // Dryad: the profile and the registry, read only.
  if (dryad.state === 'ready') {
    let registry = row('unknown');
    const slug = dryad.values.project?.slug ?? grove.values?.project?.slug ?? null;
    if (slug == null) registry = row('invalid', `no slug: ${RUNTIME_PROFILE} is absent and the Dryad profile declares none`);
    else {
      try {
        const { state, file } = readDryadState(slug, environment);
        const seats = Object.keys(state.seats).length;
        registry = row('ready', `${seats} live seat${seats === 1 ? '' : 's'}`, { file, seats, repository: state.repository ?? null });
      } catch (error) {
        registry = row('invalid', error.message);
      }
    }
    section.dryad = { profile: row('ready', dryad.values.worktrees == null ? 'seats adopt worktrees (no worktrees section)' : `worktrees under ${dryad.values.worktrees.root}`, { file: dryad.file }), registry };
  } else {
    section.dryad = { profile: dryad };
  }

  // Forester: the plan, the local file, the budget.
  if (plan.state === 'ready') {
    let budget = row('unknown');
    if (local.state === 'invalid') budget = row('invalid', local.detail);
    else {
      try {
        const resolved = resolveBudget({ plan: plan.values, local: local.state === 'ready' ? local.values : null, planFile: plan.file, localFile: local.file });
        budget = row('ready', `parallel ${resolved.parallel} from ${resolved.source}`, resolved);
      } catch (error) {
        budget = row('missing', error.message.replace(/^forester: /, ''));
      }
    }
    const tools = local.state === 'ready' ? Object.keys(local.values.tools) : [];
    section.forester = { plan: row('ready', `${plan.values.tasks.length} item${plan.values.tasks.length === 1 ? '' : 's'}`, { file: plan.file }), local: local.state === 'ready' ? row('ready', tools.length === 0 ? 'no tool templates; serve cannot launch' : `tools ${tools.join(', ')}`, { file: local.file, tools }) : local, budget };
  } else {
    section.forester = { plan, local: local.state === 'invalid' ? local : undefined };
    if (section.forester.local === undefined) delete section.forester.local;
  }

  section.mycelium = mycelium.state === 'ready'
    ? { values: row('ready', describeMode(mycelium.values), { file: mycelium.file, judges: mycelium.values.judges ?? null, mode: mycelium.values.mode }) }
    : { values: mycelium };
  section.herbarium = herbarium.state === 'ready'
    ? { values: row('ready', `${herbarium.values.public.length} public glob${herbarium.values.public.length === 1 ? '' : 's'}`, { file: herbarium.file }) }
    : { values: herbarium };
  return section;
}

// The approvals a person still owns, named so an agent asks for the right
// one and not for a blanket. Only those the project's shape makes relevant.
function gates(project, catalog) {
  const out = [];
  if (project?.grove?.profile?.state === 'ready') {
    out.push({ gate: 'shared engines', why: 'setup and infra up start machine-shared engines several projects live on', how: 'a person runs de-novo skills setup or infra up' });
  }
  if (project?.forester?.local?.state === 'ready' && (project.forester.local.tools ?? []).length > 0) {
    out.push({ gate: 'trust dialogs', why: 'serve grants no trust; a tool parked on its trust dialog shows as needs-input', how: 'forester attach <id> to answer it, or tools.<name>.pretrust_worktrees: true in the local file' });
  }
  if (project?.mycelium?.values?.state === 'ready' && project.mycelium.values.mode === 'permissive') {
    out.push({ gate: 'fact commits', why: 'no judges are declared, so any named writer may commit a fact', how: 'declare judges in .agents/mycelium.yml for unattended runs' });
  }
  if (catalog.executables.docker.state === 'missing') {
    out.push({ gate: 'engine backend', why: 'docker is not on PATH; compose engines and k3d links cannot start here', how: 'install docker, or choose a backend the profile names' });
  }
  return out;
}

function nextSteps(project, catalog, root) {
  const out = [];
  if (catalog.node.state === 'unsupported') out.push(`use Node ${NODE_SUPPORTED} or newer (${process.version} found)`);
  if (catalog.dependencies.state === 'missing') out.push(`npm install in ${CATALOG_ROOT}`);
  if (root == null) {
    out.push('run inside a project, or pass --project ROOT; de-novo skills init plants a Grove profile');
    return out;
  }
  if (project.grove.profile.state === 'missing') out.push(`no ${RUNTIME_PROFILE}: de-novo skills init ${root} plants one`);
  if (project.grove.profile.state === 'invalid') out.push(`fix ${RUNTIME_PROFILE}: ${project.grove.profile.detail}`);
  if (project.dryad.profile.state === 'missing') out.push(`no ${DRYAD_PROFILE_RELPATH}: add one to seat workers (see the Dryad reference)`);
  if (project.dryad.profile.state === 'invalid') out.push(`fix ${DRYAD_PROFILE_RELPATH}: ${project.dryad.profile.detail}`);
  if (project.forester.plan.state === 'invalid') out.push(`fix ${FORESTER_PLAN}: ${project.forester.plan.detail}`);
  if (project.forester.budget?.state === 'missing') out.push(`set parallel in ${FORESTER_PLAN} or ${FORESTER_LOCAL}`);
  if (project.forester.local?.state === 'invalid') out.push(`fix ${FORESTER_LOCAL}: ${project.forester.local.detail}`);
  if (project.mycelium.values.state === 'invalid') out.push(`fix ${MYCELIUM_VALUES}: ${project.mycelium.values.detail}`);
  if (project.herbarium.values.state === 'invalid') out.push(`fix ${HERBARIUM_VALUES}: ${project.herbarium.values.detail}`);
  const stale = Object.entries(project.skills).flatMap(([name, copies]) => copies.filter((copy) => copy.same_as_catalog === false).map((copy) => `${name} (${copy.path})`));
  if (stale.length > 0) out.push(`skill copies differ from this catalog's text: ${stale.join(', ')}; npx skills update refreshes them`);
  return out;
}

export function doctorReport({ project = null, environment = process.env, cwd = process.cwd() } = {}) {
  const catalog = catalogSection(environment);
  const root = resolveDoctorProject({ project, environment, cwd });
  if (project != null && !existsSync(root)) fail(`--project not found: ${root}`);
  const projectSectionValue = root == null ? null : projectSection(root, environment);
  const report = {
    schemaVersion: DOCTOR_SCHEMA,
    at: new Date().toISOString(),
    read_only: true,
    catalog,
    project: projectSectionValue,
    gates: gates(projectSectionValue, catalog),
    next: nextSteps(projectSectionValue, catalog, root),
  };
  report.ok = !JSON.stringify(report).includes('"state":"invalid"') && catalog.node.state !== 'unsupported';
  return report;
}

// What this checkout can do here, as a machine reads it.
export function capabilitiesReport({ environment = process.env } = {}) {
  const pkg = readCatalogPackage();
  const catalog = catalogSection(environment);
  return {
    schemaVersion: DOCTOR_SCHEMA,
    catalog: { root: CATALOG_ROOT, package: pkg.name, version: pkg.version, node: catalog.node.version, node_supported: catalog.node.supported },
    verbs: ['doctor', 'capabilities', 'init', 'validate', 'urls', 'setup', 'infra', 'overlay', 'dryad', 'forester', 'understory', 'mycelium', 'herbarium', 'canopy', 'playground'],
    skills: publishedSkills().map(({ name, invocation }) => ({ name, invocation })),
    optional: { pty: catalog.pty.state === 'ready' },
    executables: Object.fromEntries(Object.entries(catalog.executables).map(([name, value]) => [name, value.state === 'ready'])),
    machine_cap: catalog.machine_cap.parallel ?? null,
    never: ['install', 'link', 'start an engine', 'seed trust', 'write a hook', 'write a database'],
  };
}

// ------------------------------------------------------------------- cli

export function parseDoctorArgs(args, verb) {
  const options = { json: false, project: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--project' && verb === 'doctor') {
      const value = args[index + 1];
      if (value == null || value.startsWith('--')) fail('--project requires a value.');
      options.project = value;
      index += 1;
    } else {
      fail(`${verb}: unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return options;
}

function line(name, value) {
  return `  ${name.padEnd(12)} ${value.state.padEnd(11)} ${value.detail ?? ''}`.trimEnd();
}

export function formatDoctor(report) {
  const lines = [`■ de-novo skills doctor (read-only) · ${report.ok ? 'ok' : 'not ok'}`, `  catalog      ${report.catalog.package} ${report.catalog.version ?? '(no version)'} at ${report.catalog.root}`];
  lines.push(line('node', report.catalog.node), line('deps', report.catalog.dependencies), line('pty', report.catalog.pty), line('addressing', report.catalog.addressing), line('machine cap', report.catalog.machine_cap));
  for (const [name, value] of Object.entries(report.catalog.executables)) lines.push(line(name, value));
  if (report.project == null) {
    lines.push('  project      none (not inside a project; pass --project ROOT)');
  } else {
    lines.push(`  project      ${report.project.root}`);
    for (const [house, section] of Object.entries(report.project)) {
      if (house === 'root' || house === 'skills') continue;
      for (const [name, value] of Object.entries(section)) lines.push(line(`${house}.${name}`, value));
    }
    const copies = Object.entries(report.project.skills).filter(([, found]) => found.length > 0);
    lines.push(`  skills       ${copies.length}/${Object.keys(report.project.skills).length} carried as copies${copies.some(([, found]) => found.some((copy) => copy.same_as_catalog === false)) ? ' (some differ from the catalog)' : ''}`);
  }
  lines.push(`  gates        ${report.gates.length}`);
  for (const gate of report.gates) lines.push(`    ${gate.gate}: ${gate.why}; ${gate.how}`);
  lines.push(`  next         ${report.next.length === 0 ? 'nothing' : ''}`);
  for (const step of report.next) lines.push(`    ${step}`);
  return lines.join('\n');
}

export function formatCapabilities(report) {
  return [
    `■ de-novo skills capabilities · ${report.catalog.package} ${report.catalog.version ?? '(no version)'} · node ${report.catalog.node} (supported ${report.catalog.node_supported})`,
    `  verbs        ${report.verbs.join(' ')}`,
    `  skills       ${report.skills.map((skill) => `${skill.name} (${skill.invocation})`).join(', ')}`,
    `  pty          ${report.optional.pty ? 'ready' : 'missing (optional)'}`,
    `  executables  ${Object.entries(report.executables).map(([name, present]) => `${name} ${present ? 'ready' : 'missing'}`).join(' · ')}`,
    `  machine cap  ${report.machine_cap ?? 'none'}`,
    `  never        ${report.never.join(', ')}`,
  ].join('\n');
}

export function runDoctor({ verb, args, environment = process.env, cwd = process.cwd() }) {
  const options = parseDoctorArgs(args, verb);
  if (verb === 'capabilities') {
    const report = capabilitiesReport({ environment });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatCapabilities(report));
    return 0;
  }
  const report = doctorReport({ project: options.project, environment, cwd });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

export function doctorHelp(cli = 'de-novo skills') {
  return `what this machine and this project have, before anything runs (read-only)

usage:
  ${cli} doctor [--project ROOT] [--json]   catalog version, Node, optional deps, executables, the project's values files
                                            (grove, dryad, forester, mycelium, herbarium), skill copies, the gates a
                                            person owns, and the next step for each thing missing or invalid
  ${cli} capabilities [--json]               the verbs, the skills with their invocation, optional deps, executables

doctor installs nothing, links nothing, starts no engine, seeds no trust,
writes no hook, and writes no database. Every row is ready, missing,
invalid, unsupported, or unknown. Exit 1 when a values file is invalid or
Node is unsupported; missing is a fact, not a failure.`;
}

export { parse as parseYaml };
