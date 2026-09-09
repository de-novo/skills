// The catalog's own shape: every published skill is named after its
// directory, loads through .agents/skills, sits in the plugin manifest, and
// is user- or model-invoked in both harnesses at once. These are the rules
// the catalog skill states; this file is where they bite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS = path.join(CATALOG, 'skills');

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file}: no frontmatter`);
  return parse(match[1]);
}

const published = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(SKILLS, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();

test('every published skill is named after its directory and has a description', () => {
  assert.ok(published.length >= 5, `expected the five skills, found ${published.length}`);
  for (const name of published) {
    const fm = frontmatter(path.join(SKILLS, name, 'SKILL.md'));
    assert.equal(fm.name, name, `${name}: frontmatter name is ${JSON.stringify(fm.name)}`);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 40, `${name}: description missing or too short`);
  }
});

test('every published skill loads through a relative symlink under .agents/skills', () => {
  for (const name of published) {
    const link = path.join(CATALOG, '.agents/skills', name);
    assert.ok(existsSync(link), `${name}: no .agents/skills entry`);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name}: .agents/skills entry is not a symlink`);
    assert.equal(readlinkSync(link), `../../skills/${name}`, `${name}: symlink target`);
  }
});

test('the plugin manifest lists every published skill and nothing else', () => {
  const manifest = JSON.parse(readFileSync(path.join(CATALOG, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'de-novo-skills');
  assert.deepEqual([...manifest.skills].sort(), published.map((name) => `./skills/${name}`));
  const marketplace = JSON.parse(readFileSync(path.join(CATALOG, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), [manifest.name]);
});

test('a skill is user-invoked in both harnesses or in neither', () => {
  const userInvoked = [];
  for (const name of published) {
    const fm = frontmatter(path.join(SKILLS, name, 'SKILL.md'));
    const openai = parse(readFileSync(path.join(SKILLS, name, 'agents/openai.yaml'), 'utf8'));
    assert.ok(openai?.interface?.display_name && openai?.interface?.short_description, `${name}: agents/openai.yaml needs interface.display_name and short_description`);
    const claude = fm['disable-model-invocation'] === true;
    const codex = openai.policy?.allow_implicit_invocation === false;
    assert.equal(claude, codex, `${name}: disable-model-invocation (${claude}) and policy.allow_implicit_invocation: false (${codex}) must be set together`);
    if (claude) {
      userInvoked.push(name);
      assert.doesNotMatch(fm.description, /Use when|when the user runs/, `${name}: a user-invoked description is human-facing and carries no trigger list`);
    }
  }
  // Forester and Clearing are the skills a person triggers; the rest a seat reaches for.
  assert.deepEqual(userInvoked, ['clearing', 'forester']);
});
