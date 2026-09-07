// The Grove profile is this project's only house for its names. The sample
// has no dependencies, so this reads the small YAML subset the profile next
// door actually uses: two-space indented maps, `key: value` scalars, and
// inline flow values kept as raw text. Anything else raises rather than
// guessing.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './sandbox.mjs';

const LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
const DNS_LABEL_GROUP = '([a-z0-9]+(?:-[a-z0-9]+)*)';

function stripComment(value) {
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    if (end < 0) throw new Error(`unterminated quote in ${JSON.stringify(value)}`);
    return value.slice(1, end);
  }
  const comment = value.indexOf(' #');
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}

export function parseYamlSubset(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) throw new Error(`this reader does not understand ${JSON.stringify(line)}`);
    const [, indent, key, rest] = match;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent.length) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rest == null || rest.trim() === '') {
      const node = {};
      parent[key] = node;
      stack.push({ indent: indent.length, node });
      continue;
    }
    parent[key] = stripComment(rest.trim());
  }
  return root;
}

export function readProfile(root = PROJECT_ROOT) {
  const file = path.join(root, '.agents', 'runtime-profile.yml');
  const doc = parseYamlSubset(readFileSync(file, 'utf8'));
  const slug = doc.project?.slug;
  const tld = doc.addressing?.tld;
  const shared = doc.addressing?.scheme?.shared;
  const overlay = doc.addressing?.scheme?.overlay;
  for (const [name, value] of Object.entries({ 'project.slug': slug, 'addressing.tld': tld, 'addressing.scheme.shared': shared, 'addressing.scheme.overlay': overlay })) {
    if (typeof value !== 'string' || value === '') throw new Error(`${file}: ${name} is missing`);
  }
  return {
    file,
    slug,
    host: slug.replaceAll('_', '-'),
    tld,
    scheme: { shared, overlay },
    services: Object.keys(doc.services ?? {}),
  };
}

// {service}.{project}.{tld} with the values this project owns.
export function renderHost(scheme, profile, tokens) {
  return scheme.replaceAll(/\{([a-z]+)\}/g, (_, token) => {
    const value = { project: profile.host, tld: profile.tld, namespace: profile.host, ...tokens }[token];
    if (value == null) throw new Error(`scheme token {${token}} has no value`);
    return value;
  });
}

function schemeToPattern(scheme, profile) {
  const source = scheme.replaceAll(/\{([a-z]+)\}|[^{]+/g, (chunk, token) => {
    if (token === 'service' || token === 'env') return DNS_LABEL_GROUP;
    if (token != null) return renderHost(`{${token}}`, profile, {}).replaceAll('.', '\\.');
    return chunk.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const order = [...scheme.matchAll(/\{([a-z]+)\}/g)]
    .map((match) => match[1])
    .filter((token) => token === 'service' || token === 'env');
  return { pattern: new RegExp(`^${source}$`), order };
}

// Overlay names are checked first: the shared scheme cannot match a name that
// carries an environment, but reading it that way keeps the intent obvious.
export function parseHost(host, profile) {
  const name = String(host ?? '').toLowerCase().split(':')[0].replace(/\.$/, '');
  for (const [role, scheme] of [['overlay', profile.scheme.overlay], ['shared', profile.scheme.shared]]) {
    const { pattern, order } = schemeToPattern(scheme, profile);
    const match = pattern.exec(name);
    if (!match) continue;
    const parts = Object.fromEntries(order.map((token, index) => [token, match[index + 1]]));
    return { role, service: parts.service, env: parts.env ?? null };
  }
  return null;
}
