import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { checkHerbarium, globToRegExp, matchesAny, parseHerbariumCliArgs, parseHerbariumValues } from '../lib/herbarium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const CATALOG = path.resolve(HERE, '../..');
const VALUES = { version: 1, language: 'en', public: ['README.md', 'docs/**/*.md'], pages: { globs: ['README.md'], max_words: 40 }, archive: ['docs/archive/**'], ignore: ['scratch/**'] };
const PROSE = 'This sentence is long enough to count as prose that one file owns and another file must not repeat verbatim.';

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'herbarium-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  writeFileSync(path.join(root, '.agents/herbarium.yml'), stringify(VALUES));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('the values file is a whitelist with one required list', () => {
  const ok = parseHerbariumValues(stringify(VALUES));
  assert.deepEqual(ok.public, ['README.md', 'docs/**/*.md']);
  assert.equal(ok.pages.max_words, 40);
  assert.ok(ok.ignore.includes('node_modules/**'));
  assert.equal(parseHerbariumValues(stringify({ version: 1, public: ['README.md'] })).pages.max_words, 450);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, owner: 'x' })), /unknown key "owner"/);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, version: 2 })), /version must be 1/);
  assert.throws(() => parseHerbariumValues(stringify({ version: 1 })), /public must be a non-empty list of globs/);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, public: ['/abs.md'] })), /must be a relative glob/);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, language: 'fr' })), /language must be one of en/);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, pages: { globs: [], max_words: 0 } })), /max_words must be a positive integer/);
  assert.throws(() => parseHerbariumValues(stringify({ ...VALUES, pages: { cap: 3 } })), /pages has unknown key "cap"/);
});

test('globs: ** spans directories, * stays in one segment', () => {
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a/b/c.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/c.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/c.md'));
  assert.ok(globToRegExp('skills/*/README.md').test('skills/grove/README.md'));
  assert.ok(!globToRegExp('skills/*/README.md').test('skills/grove/references/README.md'));
  assert.ok(matchesAny('docs/archive/x.md', ['docs/archive/**']));
  assert.ok(!matchesAny('docs/archive.md', ['docs/archive/**']));
});

test('check counts broken links, copies, another script, pages over the cap, and archive links, each once', (t) => {
  const root = fixture(t, {
    'README.md': `# Home\n\nShort page. See [design](docs/design.md) and [gone](docs/missing.md).\n`,
    'docs/design.md': `# Design\n\n${PROSE}\n\nRetired: [old](archive/old.md).\n\n\`\`\`\n${PROSE}\n\`\`\`\n`,
    'docs/notes.md': `# Notes\n\n${PROSE}\n\n한글이 섞인 줄.\n`,
    'docs/archive/old.md': `# Old\n\nPoints at [newer](../design.md) and [older](older.md).\n`,
    'scratch/ignored.md': `# Ignored\n\n[nowhere](x.md)\n`,
  });
  const values = parseHerbariumValues(stringify(VALUES));
  const result = checkHerbarium({ root, values });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.links, [{ file: 'README.md', target: 'docs/missing.md' }, { file: 'docs/archive/old.md', target: 'older.md' }]);
  // The prose sentence lives in two files; the copy inside the code fence is not a third holder.
  assert.deepEqual(result.findings.copies.map((f) => f.files), [['docs/design.md', 'docs/notes.md']]);
  assert.deepEqual(result.findings.language, [{ file: 'docs/notes.md' }]);
  assert.deepEqual(result.findings.pages, []);
  // Only the active document's link into the archive counts; the archive pointing at itself does not.
  assert.deepEqual(result.findings.archive, [{ file: 'docs/design.md', target: 'docs/archive/old.md' }]);
  assert.deepEqual(result.counts, { files: 4, links: 5, links_broken: 2, copies: 1, language: 1, pages: 1, pages_over: 0, archive_links: 1 });
});

test('a page is measured by its prose: a diagram in a fence is looked at, not read', (t) => {
  const many = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const root = fixture(t, {
    'README.md': `# Home\n\nA short page.\n\n\`\`\`\n${many}\n\`\`\`\n`,
    'docs/long.md': `# Long\n`,
  });
  const values = parseHerbariumValues(stringify({ ...VALUES, pages: { globs: ['README.md', 'docs/long.md'], max_words: 40 } }));
  assert.deepEqual(checkHerbarium({ root, values }).findings.pages, []);
  writeFileSync(path.join(root, 'docs/long.md'), `# Long\n\n${many}\n`);
  const over = checkHerbarium({ root, values }).findings.pages;
  assert.deepEqual(over.map((f) => [f.file, f.words > 40, f.max]), [['docs/long.md', true, 40]]);
});

test('the CLI: check prints counts, exits non-zero on a problem, and takes --project and --json', (t) => {
  const root = fixture(t, { 'README.md': `# Home\n\nAll good, see [docs](docs/a.md).\n`, 'docs/a.md': `# A\n` });
  const clean = spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', root], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /links     1\/1 resolve/);
  assert.match(clean.stdout, /copies    0/);
  assert.match(clean.stdout, /pages     1\/1 within 40 words/);
  writeFileSync(path.join(root, 'README.md'), `# Home\n\nSee [gone](docs/b.md).\n`);
  const broken = spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', root, '--json'], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  const json = JSON.parse(broken.stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(json.findings.links, [{ file: 'README.md', target: 'docs/b.md' }]);
  assert.match(spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', root], { encoding: 'utf8' }).stdout, /broken    README.md -> docs\/b.md/);
  const fromInside = spawnSync(process.execPath, [CLI, 'herbarium', 'check'], { cwd: path.join(root, 'docs'), encoding: 'utf8' });
  assert.equal(fromInside.status, 1, 'the values file is found upward from a subdirectory');
  const nowhere = spawnSync(process.execPath, [CLI, 'herbarium', 'check'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(nowhere.status, 1);
  assert.match(nowhere.stderr, /no \.agents\/herbarium\.yml above/);
  assert.throws(() => parseHerbariumCliArgs(['prune']), /unknown command "prune"/);
  assert.throws(() => parseHerbariumCliArgs(['check', '--fix']), /--fix is not valid for check/);
  assert.equal(parseHerbariumCliArgs(['check', '--project', '/x', '--json']).json, true);
});

test('a symlinked mirror of a directory is not walked, so it cannot count as a second holder of the same prose', (t) => {
  const root = fixture(t, { 'docs/a.md': `# A\n\n${PROSE}\n` });
  symlinkSync(path.join(root, 'docs'), path.join(root, 'mirror'));
  const values = parseHerbariumValues(stringify({ ...VALUES, public: ['**/*.md'] }));
  const result = checkHerbarium({ root, values });
  assert.deepEqual(result.findings.copies, []);
  assert.equal(result.counts.files, 1);
});

// The catalog keeps its own houses in .agents/herbarium.yml; the suite is
// where its own documents are held to the pattern.
test('the catalog passes its own check', () => {
  const result = spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', CATALOG], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /copies    0/);
  assert.match(result.stdout, /language  0 files/);
});
