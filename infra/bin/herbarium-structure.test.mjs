// Herbarium tells structure from similarity: a duplicate heading anchor,
// a reference-style link, and a link with a title are resolved as the
// rendered page resolves them; a generated snapshot with its source and
// revision is not a copy, and one without them is a finding; the script
// check reads prose, not code or quotations; and the check says how many
// bytes an agent loads, as an estimate that names itself one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { checkHerbarium, headingSlugs, parseHerbariumValues, snapshotsOf } from '../lib/herbarium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const VALUES = { version: 1, language: 'en', public: ['README.md', 'docs/**/*.md'], pages: { globs: ['README.md'], max_words: 400 } };
const PROSE = 'This sentence is long enough to count as prose that one file owns and another file must not repeat verbatim.';

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'herbarium-structure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  writeFileSync(path.join(root, '.agents/herbarium.yml'), stringify(VALUES));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('repeated headings get -1, -2 anchors; reference-style links and titled links resolve like inline ones', (t) => {
  assert.deepEqual([...headingSlugs('# Notes\n\n## Step\n\n## Step\n\n## Step\n')], ['notes', 'step', 'step-1', 'step-2']);
  const root = fixture(t, {
    'README.md': [
      '# Home',
      '',
      'See [second step](docs/a.md#step-1), [third](docs/a.md#step-2), [fourth](docs/a.md#step-3).',
      'Titled: [design](docs/a.md "the design"), [gone](docs/missing.md "nowhere").',
      'By reference: [the reference][ref] and [broken one][bad].',
      '',
      '[ref]: docs/a.md#step',
      '[bad]: docs/nothing.md',
      '',
    ].join('\n'),
    'docs/a.md': '# A\n\n## Step\n\n## Step\n\n## Step\n',
  });
  const result = checkHerbarium({ root, values: parseHerbariumValues(stringify(VALUES)) });
  assert.deepEqual(result.findings.anchors.map((f) => f.target), ['docs/a.md#step-3']);
  assert.deepEqual(result.findings.links.map((f) => f.target), ['docs/missing.md', 'docs/nothing.md']);
  assert.equal(result.counts.links, 7);
  assert.equal(result.counts.anchors, 4);
  assert.deepEqual(result.errors, { links: 2, anchors: 1, language: 0, pages: 0, snapshots: 0 });
  assert.equal(result.ok, false);
});

test('a snapshot with a source and a revision is generated, not copied; one without them is a finding', (t) => {
  const graph = 'flowchart LR\n  a --> b\n';
  const root = fixture(t, {
    'README.md': `# Home\n\n<!-- snapshot: de-novo skills understory reading @ 3ccdbda 2026-09-10 -->\n${PROSE}\n<!-- /snapshot -->\n\nOwn words here, short.\n`,
    'docs/source.md': `# Source\n\n${PROSE}\n`,
    'docs/bare.md': `# Bare\n\n<!-- snapshot: pasted from somewhere -->\n${graph}\n<!-- /snapshot -->\n\n<!-- snapshot: @ 3ccdbda -->\nx\n<!-- /snapshot -->\n`,
  });
  assert.deepEqual(snapshotsOf('<!-- snapshot: a b @ rev1 -->\nbody\n<!-- /snapshot -->').map((s) => [s.source, s.revision, s.sourced]), [['a b', 'rev1', true]]);
  const result = checkHerbarium({ root, values: parseHerbariumValues(stringify(VALUES)) });
  assert.deepEqual(result.findings.copies, [], 'the prose inside a sourced snapshot is not a second holder');
  assert.deepEqual(result.findings.near_copies, []);
  assert.deepEqual(result.findings.snapshots.map((f) => [f.file, f.header]), [['docs/bare.md', 'pasted from somewhere'], ['docs/bare.md', '@ 3ccdbda']]);
  assert.deepEqual({ snapshots: result.measures.snapshots, unsourced: result.measures.snapshots_unsourced }, { snapshots: 3, unsourced: 2 });
  assert.equal(result.ok, false, 'an unsourced snapshot fails the check');
  writeFileSync(path.join(root, 'docs/bare.md'), '# Bare\n\nnothing generated\n');
  const clean = checkHerbarium({ root, values: parseHerbariumValues(stringify(VALUES)) });
  assert.equal(clean.ok, true);
  assert.equal(clean.errors.snapshots, 0);
});

test('the script check reads prose: another script in code, a quotation, or a snapshot is not a finding; in prose it is', (t) => {
  const root = fixture(t, {
    'README.md': '# Home\n\nA command: `echo 안녕`.\n\n```\n한글 in a fence\n```\n\n> 인용: quoted from a source, [source](docs/a.md)\n\n<!-- snapshot: tool @ rev -->\n生成された\n<!-- /snapshot -->\n',
    'docs/a.md': '# A\n\nPlain prose with 한글 in it.\n',
  });
  const result = checkHerbarium({ root, values: parseHerbariumValues(stringify(VALUES)) });
  assert.deepEqual(result.findings.language, [{ file: 'docs/a.md' }]);
});

test('the check reports what an agent loads: bytes and a token estimate that names its method; the CLI prints and groups them', (t) => {
  const root = fixture(t, { 'README.md': '# Home\n\nfour bytes\n', 'docs/a.md': '# A\n' });
  const result = checkHerbarium({ root, values: parseHerbariumValues(stringify(VALUES)) });
  assert.equal(result.measures.bytes, Buffer.byteLength('# Home\n\nfour bytes\n') + Buffer.byteLength('# A\n'));
  assert.equal(result.measures.tokens_estimate, Math.ceil(result.measures.bytes / 4));
  assert.match(result.measures.method, /estimate/);
  assert.deepEqual(result.candidates, { copies: 0, near_copies: 0, similar: 0 });
  const cli = spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /snapshots 0\/0 name a source and a revision/);
  assert.match(cli.stdout, new RegExp(`loaded    ${result.measures.bytes} bytes ≈ ${result.measures.tokens_estimate} tokens \\(bytes/4 estimate\\)`));
  const json = JSON.parse(spawnSync(process.execPath, [CLI, 'herbarium', 'check', '--project', root, '--json'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(Object.keys(json.errors), ['links', 'anchors', 'language', 'pages', 'snapshots']);
  assert.deepEqual(Object.keys(json.candidates), ['copies', 'near_copies', 'similar']);
});
