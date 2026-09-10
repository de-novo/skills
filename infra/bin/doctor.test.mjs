// doctor and capabilities: read-only, one JSON contract, every row one of
// five states, the next step named for each missing or invalid thing, and
// nothing on the machine changed by running them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { DOCTOR_SCHEMA, STATES, capabilitiesReport, doctorReport, publishedSkills, readCatalogPackage } from '../lib/doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const CATALOG = path.resolve(HERE, '../..');

function treeDigest(root) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(`${path.relative(root, file)}:${statSync(file).size}:${readFileSync(file).toString('base64').slice(0, 4096)}\n`);
    }
  };
  walk(root);
  return hash.digest('hex');
}

function states(value, out = []) {
  if (value && typeof value === 'object') {
    if (typeof value.state === 'string') out.push(value.state);
    for (const child of Object.values(value)) states(child, out);
  }
  return out;
}

test('the package names its version and the Node range the suite runs on; the plugin manifest agrees', () => {
  const pkg = readCatalogPackage(CATALOG);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, '>=24');
  const plugin = JSON.parse(readFileSync(path.join(CATALOG, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version, 'plugin manifest version equals package version');
  assert.equal(publishedSkills(CATALOG).length, 7);
});

test('doctor outside a project reports the catalog and says how to get a project; stdout is JSON alone', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'doctor-none-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(dir, 'state') };
  delete environment.DRYAD_PROJECT;
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, DOCTOR_SCHEMA);
  assert.equal(report.read_only, true);
  assert.equal(report.project, null);
  assert.equal(report.catalog.executables.git.state, 'ready');
  assert.equal(report.catalog.node.state, 'ready');
  for (const state of states(report)) assert.ok(STATES.includes(state), state);
  assert.match(report.next[0], /run inside a project, or pass --project ROOT/);
  const text = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: dir, env: environment, encoding: 'utf8' });
  assert.match(text.stdout, /project      none/);
  assert.match(spawnSync(process.execPath, [CLI, 'doctor', '--project', path.join(dir, 'nowhere')], { cwd: dir, env: environment, encoding: 'utf8' }).stderr, /--project not found/);
});

test('doctor reads a project\'s values files, tells missing from invalid, names the gates and the next step, and changes nothing', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'doctor-project-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, '.agents/skills/dryad'), { recursive: true });
  const stateDir = path.join(root, 'state');
  mkdirSync(path.join(stateDir, 'foresters'), { recursive: true });
  writeFileSync(path.join(stateDir, 'foresters/machine.yml'), 'version: 1\nparallel: 3\n');
  const environment = { ...process.env, GROVE_STATE_DIR: stateDir };
  delete environment.DRYAD_PROJECT;
  writeFileSync(path.join(project, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'doctored' }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none' }));
  writeFileSync(path.join(project, '.agents/dryad-profile.yml'), stringify({ version: 1, worktrees: { root: '../seats', branch: 'dryad/{id}' } }));
  writeFileSync(path.join(project, '.agents/forester-plan.yml'), 'version: 1\ntasks:\n  a: { task: x }\n');
  writeFileSync(path.join(project, '.agents/mycelium.yml'), 'version: 1\ndomains: [sample]\ntypes: [item]\npredicates:\n  uses: many\n');
  // A skill copy that is not the catalog's text.
  writeFileSync(path.join(project, '.agents/skills/dryad/SKILL.md'), '---\nname: dryad\n---\nold copy\n');
  const before = treeDigest(root);

  const report = doctorReport({ project, environment, cwd: root });
  assert.equal(report.ok, true);
  assert.equal(report.project.grove.profile.state, 'ready');
  assert.equal(report.project.grove.overlay.mode, 'off');
  assert.equal(report.project.grove.backend.state, 'missing');
  assert.deepEqual(report.project.grove.hostnames.shared.length, 1);
  assert.match(report.project.grove.hostnames.detail, /rendering is not resolving/);
  assert.equal(report.project.dryad.registry.state, 'ready');
  assert.equal(report.project.dryad.registry.seats, 0);
  assert.equal(report.project.forester.plan.state, 'ready');
  assert.equal(report.project.forester.local.state, 'missing');
  assert.equal(report.project.forester.budget.state, 'missing');
  assert.match(report.project.forester.budget.detail, /no budget/);
  assert.equal(report.project.mycelium.values.state, 'ready');
  assert.match(report.project.mycelium.values.detail, /permissive/);
  assert.equal(report.project.herbarium.values.state, 'missing');
  assert.deepEqual(report.project.skills.dryad, [{ path: '.agents/skills/dryad/SKILL.md', same_as_catalog: false }]);
  assert.deepEqual(report.project.skills.grove, []);
  assert.equal(report.catalog.machine_cap.parallel, 3);
  assert.deepEqual(report.gates.map((gate) => gate.gate).filter((gate) => gate !== 'engine backend'), ['shared engines', 'fact commits']);
  assert.ok(report.next.some((step) => /set parallel in/.test(step)));
  assert.ok(report.next.some((step) => /dryad \(\.agents\/skills\/dryad\/SKILL\.md\)/.test(step)));
  assert.equal(treeDigest(root), before, 'doctor wrote nothing under the project or the state directory');

  // An invalid values file is invalid, not missing, and exits 1 with its parser's words.
  writeFileSync(path.join(project, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'doctored' }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none', qa: {} }));
  const invalid = spawnSync(process.execPath, [CLI, 'doctor', '--project', project, '--json'], { cwd: root, env: environment, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  const bad = JSON.parse(invalid.stdout);
  assert.equal(bad.ok, false);
  assert.equal(bad.project.grove.profile.state, 'invalid');
  assert.match(bad.project.grove.profile.detail, /qa/);
  assert.ok(bad.next.some((step) => /fix \.agents\/runtime-profile\.yml/.test(step)));
  assert.match(spawnSync(process.execPath, [CLI, 'doctor', '--project', project], { cwd: root, env: environment, encoding: 'utf8' }).stdout, /grove\.profile invalid/);
});

test('capabilities lists the verbs, the seven skills with their invocation, and what it never does', () => {
  const report = capabilitiesReport({ environment: process.env });
  assert.equal(report.schemaVersion, DOCTOR_SCHEMA);
  assert.ok(report.verbs.includes('doctor') && report.verbs.includes('capabilities') && report.verbs.includes('forester'));
  assert.deepEqual(report.skills.map((skill) => skill.name), ['clearing', 'dryad', 'forester', 'grove', 'herbarium', 'mycelium', 'understory']);
  assert.deepEqual(report.skills.filter((skill) => skill.invocation === 'user').map((skill) => skill.name), ['clearing', 'forester']);
  assert.ok(report.never.includes('seed trust'));
  const result = spawnSync(process.execPath, [CLI, 'capabilities', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).catalog.package, 'de-novo-skills');
  assert.match(spawnSync(process.execPath, [CLI, 'capabilities'], { encoding: 'utf8' }).stdout, /skills       clearing \(user\), dryad \(model\)/);
  assert.match(spawnSync(process.execPath, [CLI, 'doctor', '--bogus'], { encoding: 'utf8' }).stderr, /unknown argument "--bogus"/);
});
