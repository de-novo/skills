// de-novo Herbarium — every document a project keeps has one house, and a
// document points at the others instead of copying them. This module owns
// the values-file whitelist and the one verb, `check`, which counts what
// the pattern forbids: relative links that do not resolve, prose copied
// between files, a public surface written in another script, a human page
// over its word cap, and links from active documents into the archive.
// It never edits a file; it prints numbers a person or a CI reads.
//
//   .agents/herbarium.yml   the project's houses: public globs, pages, archive, language
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const VALUES_RELPATH = '.agents/herbarium.yml';
const LANGUAGES = Object.freeze({ en: /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u });
const COPY_MIN_CHARS = 80;
const DEFAULT_MAX_WORDS = 450;
const DEFAULT_IGNORE = ['node_modules/**', '.git/**'];

function fail(message) {
  throw new Error(`herbarium: ${message}`);
}

// --------------------------------------------------------------- values

export function parseHerbariumValues(yamlText, source = 'herbarium.yml') {
  const doc = parse(yamlText);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`${source}: expected a mapping.`);
  const known = new Set(['version', 'language', 'public', 'pages', 'archive', 'ignore']);
  for (const key of Object.keys(doc)) if (!known.has(key)) fail(`${source}: unknown key "${key}"; allowed: ${[...known].join(', ')}.`);
  if (doc.version !== 1) fail(`${source}: version must be 1.`);
  const globs = (name, value, { required = false } = {}) => {
    if (value == null) {
      if (required) fail(`${source}: ${name} must be a non-empty list of globs.`);
      return [];
    }
    if (!Array.isArray(value) || (required && value.length === 0)) fail(`${source}: ${name} must be a non-empty list of globs.`);
    for (const entry of value) if (typeof entry !== 'string' || entry.length === 0 || entry.startsWith('/')) fail(`${source}: ${name} entry ${JSON.stringify(entry)} must be a relative glob.`);
    return value;
  };
  const language = doc.language ?? 'en';
  if (!(language in LANGUAGES)) fail(`${source}: language must be one of ${Object.keys(LANGUAGES).join(', ')}.`);
  const pages = doc.pages ?? {};
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) fail(`${source}: pages must be a mapping of globs and max_words.`);
  for (const key of Object.keys(pages)) if (!['globs', 'max_words'].includes(key)) fail(`${source}: pages has unknown key "${key}"; allowed: globs, max_words.`);
  const maxWords = pages.max_words ?? DEFAULT_MAX_WORDS;
  if (!Number.isInteger(maxWords) || maxWords < 1) fail(`${source}: pages.max_words must be a positive integer.`);
  return {
    version: 1,
    language,
    public: globs('public', doc.public, { required: true }),
    pages: { globs: globs('pages.globs', pages.globs), max_words: maxWords },
    archive: globs('archive', doc.archive),
    ignore: [...DEFAULT_IGNORE, ...globs('ignore', doc.ignore)],
  };
}

// ---------------------------------------------------------------- globs

// `**` spans directories, `*` stays inside one segment. Enough for the
// houses a project names; not a shell.
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

export function matchesAny(relative, globs) {
  return globs.some((glob) => globToRegExp(glob).test(relative));
}

function walk(root, ignore) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (matchesAny(relative, ignore) || matchesAny(relative + '/', ignore)) continue;
      // A symlink is neither a directory nor a file to readdir, so a
      // mirror is never walked and cannot hold a second copy.
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(relative);
    }
  };
  visit(root);
  return out.sort();
}

// ---------------------------------------------------------------- check

const LINK = /\]\(([^)\s#]+)(#[^)]*)?\)/g;

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

// The five counts. Each is a list of findings so the text form can name
// them and the JSON form can carry them; the summary is the lengths.
export function checkHerbarium({ root, values }) {
  const files = walk(root, values.ignore);
  const publicFiles = files.filter((file) => matchesAny(file, values.public));
  const findings = { links: [], copies: [], language: [], pages: [], archive: [] };
  const texts = new Map(publicFiles.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]));
  let linkCount = 0;

  for (const [file, text] of texts) {
    const inArchive = matchesAny(file, values.archive);
    for (const match of stripCode(text).matchAll(LINK)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      linkCount += 1;
      const resolved = path.normalize(path.join(path.dirname(file), target)).split(path.sep).join('/');
      if (!existsSync(path.join(root, resolved))) findings.links.push({ file, target });
      else if (!inArchive && matchesAny(resolved, values.archive)) findings.archive.push({ file, target: resolved });
    }
    if (LANGUAGES[values.language].test(text)) findings.language.push({ file });
    // The cap is on prose: a diagram or a command block in a fence is
    // looked at, not read, and does not count.
    if (matchesAny(file, values.pages.globs)) {
      const words = stripCode(text).split(/\s+/).filter(Boolean).length;
      if (words > values.pages.max_words) findings.pages.push({ file, words, max: values.pages.max_words });
    }
  }

  // A copy is one sentence of prose living in two files. Pointer lines,
  // table rules, headings, and code are not prose and are not counted.
  const owners = new Map();
  for (const [file, text] of texts) {
    const seen = new Set();
    for (const raw of stripCode(text).split('\n')) {
      const line = raw.trim();
      if (line.length < COPY_MIN_CHARS || line.startsWith('#') || line.startsWith('|') || line.includes('](') || seen.has(line)) continue;
      seen.add(line);
      if (!owners.has(line)) owners.set(line, []);
      owners.get(line).push(file);
    }
  }
  for (const [line, holders] of owners) {
    if (holders.length > 1) findings.copies.push({ line: line.slice(0, 100), files: holders });
  }

  const counts = {
    files: publicFiles.length,
    links: linkCount,
    links_broken: findings.links.length,
    copies: findings.copies.length,
    language: findings.language.length,
    pages: publicFiles.filter((file) => matchesAny(file, values.pages.globs)).length,
    pages_over: findings.pages.length,
    archive_links: findings.archive.length,
  };
  const ok = counts.links_broken === 0 && counts.copies === 0 && counts.language === 0 && counts.pages_over === 0;
  return { ok, counts, findings };
}

// -------------------------------------------------------------- project

function findValuesUpward(start) {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, VALUES_RELPATH))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadHerbarium({ project = null, cwd = process.cwd() }) {
  const root = project != null ? path.resolve(cwd, project) : findValuesUpward(cwd);
  if (root == null) fail(`no ${VALUES_RELPATH} above ${cwd}; pass --project <root>.`);
  const file = path.join(root, VALUES_RELPATH);
  if (!existsSync(file)) fail(`values not found: ${file}`);
  if (!statSync(root).isDirectory()) fail(`${root} is not a directory.`);
  return { root, file, values: parseHerbariumValues(readFileSync(file, 'utf8'), file) };
}

// ------------------------------------------------------------------ cli

export function parseHerbariumCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (verb !== 'check') fail(`unknown command ${JSON.stringify(verb)}.`);
  const options = { help: false, verb, project: null, json: false };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--project') {
      const value = input[index + 1];
      if (value == null || value.startsWith('--')) fail('--project requires a value.');
      options.project = value;
      index += 1;
    } else {
      fail(`${arg} is not valid for check.`);
    }
  }
  return options;
}

export function formatCheck(result, root) {
  const c = result.counts;
  const lines = [
    `■ ${path.basename(root)} — herbarium check`,
    `  files     ${c.files} public`,
    `  links     ${c.links - c.links_broken}/${c.links} resolve`,
    `  copies    ${c.copies}`,
    `  language  ${c.language} file${c.language === 1 ? '' : 's'} in another script`,
    `  pages     ${c.pages - c.pages_over}/${c.pages} within ${result.max_words} words`,
    `  archive   ${c.archive_links} link${c.archive_links === 1 ? '' : 's'} from active documents (shown, not judged)`,
  ];
  for (const f of result.findings.links) lines.push(`  broken    ${f.file} -> ${f.target}`);
  for (const f of result.findings.copies) lines.push(`  copy      ${f.files.join(' · ')}: "${f.line}"`);
  for (const f of result.findings.language) lines.push(`  script    ${f.file}`);
  for (const f of result.findings.pages) lines.push(`  long      ${f.file} ${f.words} words (cap ${f.max})`);
  for (const f of result.findings.archive) lines.push(`  archive   ${f.file} -> ${f.target}`);
  return lines.join('\n');
}

export function runHerbarium({ options, cwd = process.cwd() }) {
  const { root, values } = loadHerbarium({ project: options.project, cwd });
  const result = checkHerbarium({ root, values });
  if (options.json) console.log(JSON.stringify({ root, ok: result.ok, counts: result.counts, findings: result.findings }, null, 2));
  else console.log(formatCheck({ ...result, max_words: values.pages.max_words }, root));
  return result.ok ? 0 : 1;
}

export function herbariumHelp(cli = 'de-novo skills') {
  return `every document has one house; the rest point at it

usage:
  ${cli} herbarium check [--project ROOT] [--json]
      counts, over the project's public surfaces: relative links that resolve,
      prose copied between files, files in another script, human pages over
      the word cap, links from active documents into the archive.
      Non-zero when a link is broken, a copy exists, a script is wrong, or a
      page is over the cap.

The houses come from ${VALUES_RELPATH}. Pattern: skills/herbarium/SKILL.md.`;
}
