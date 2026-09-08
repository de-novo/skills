// de-novo Understory — the story under the canopy: the graph Forester holds,
// drawn and read for people. This module owns the deterministic part: the
// diagram and the reading lines, both computed from `forester plan --json`
// and nothing else, so two people drawing the same plan get the same
// picture. The prose around them is written by an agent reading the skill.
import { readFileSync } from 'node:fs';

import { foresterJson, loadForester } from './forester.mjs';

const STATE_ORDER = ['done', 'active', 'ready', 'blocked', 'failed'];
// One fill per state. Chosen so done recedes and the two states that need a
// person (active, failed) stand out; blocked and ready read as waiting.
const STATE_STYLE = Object.freeze({
  done: 'fill:#d9e8d9,stroke:#4c7a4c,color:#1f3d1f',
  active: 'fill:#fff2c2,stroke:#b58900,color:#3d2f00',
  ready: 'fill:#e3ecf7,stroke:#3b6ea5,color:#102a43',
  blocked: 'fill:#f2f2f2,stroke:#8a8a8a,color:#3a3a3a,stroke-dasharray:4 3',
  failed: 'fill:#f8d7da,stroke:#a33a3a,color:#4a1010',
});

function fail(message) {
  throw new Error(`understory: ${message}`);
}

function nodeId(id) {
  return 'n_' + id.replace(/[^a-z0-9]/gi, '_');
}

function label(item) {
  const parts = [item.id];
  if (item.owns.length > 0) parts.push(item.owns.join(' '));
  const tail = [];
  if (item.tool) tail.push(item.tool);
  if (item.session?.state) tail.push(item.session.state);
  if (tail.length > 0) parts.push(tail.join(' · '));
  return parts.map((part) => part.replaceAll('"', '#quot;')).join('<br/>');
}

// The plan as a Mermaid flowchart: one node per item coloured by state, a
// solid edge per depends_on, a dotted edge for every claim hold that keeps a
// ready item waiting, and a note on items the budget alone is holding.
export function understoryGraph(json) {
  if (!json || !Array.isArray(json.items)) fail('expected forester plan --json.');
  const lines = ['flowchart LR'];
  for (const state of STATE_ORDER) lines.push(`  classDef ${state} ${STATE_STYLE[state]}`);
  for (const item of json.items) {
    lines.push(`  ${nodeId(item.id)}["${label(item)}"]:::${item.state}`);
  }
  for (const item of json.items) {
    for (const dep of item.depends_on) lines.push(`  ${nodeId(dep)} --> ${nodeId(item.id)}`);
  }
  for (const hold of json.held ?? []) {
    const claim = hold.reason.match(/^claim (\S+) intersects (\S+) of (\S+) \(/);
    if (claim) {
      lines.push(`  ${nodeId(hold.id)} -. "claim ${claim[1]}" .-> ${nodeId(claim[3])}`);
    } else {
      lines.push(`  ${nodeId(hold.id)} ---|"${hold.reason.replaceAll('"', '#quot;')}"| ${nodeId(hold.id)}`);
    }
  }
  const legend = STATE_ORDER.filter((state) => json.items.some((item) => item.state === state));
  if (legend.length > 0) {
    lines.push('  subgraph legend [" "]');
    lines.push('    direction LR');
    for (const state of legend) lines.push(`    l_${state}["${state}"]:::${state}`);
    lines.push('  end');
  }
  return lines.join('\n') + '\n';
}

// One line per item, in plan order, saying what a reader should take from
// it. This is the text a person is measured against: read it and know.
export function understoryReading(json) {
  if (!json || !Array.isArray(json.items)) fail('expected forester plan --json.');
  const rows = [];
  for (const item of json.items) {
    let line;
    switch (item.state) {
      case 'done':
        line = `finished (${item.why})`;
        break;
      case 'active':
        line = item.session?.state === 'needs-input'
          ? `someone is working on it and the session is waiting for a person`
          : `someone is working on it${item.session?.state ? ` (session ${item.session.state})` : ''}`;
        break;
      case 'ready': {
        const hold = (json.held ?? []).find((entry) => entry.id === item.id);
        line = json.next?.includes(item.id)
          ? 'would be assigned now'
          : hold
            ? `could start, but ${hold.reason}`
            : 'could start';
        break;
      }
      case 'blocked':
        line = `cannot start yet: ${item.why}`;
        break;
      case 'failed':
        line = `gave up: ${item.why}`;
        break;
      default:
        line = item.why;
    }
    rows.push({ id: item.id, state: item.state, line });
  }
  return rows;
}

export function understorySummary(json) {
  const c = json.counts ?? {};
  const total = json.items.length;
  const slots = json.slots ?? {};
  return [
    `${total} item${total === 1 ? '' : 's'}: ${c.done ?? 0} done, ${c.active ?? 0} active, ${c.ready ?? 0} ready, ${c.blocked ?? 0} blocked, ${c.failed ?? 0} failed.`,
    slots.parallel != null ? `Slots ${slots.active}/${slots.parallel} (budget from ${json.budget?.source ?? 'unknown'}).` : null,
    json.next?.length ? `Next: ${json.next.join(', ')}.` : null,
  ].filter(Boolean).join(' ');
}

// -------------------------------------------------------------------- cli

const VERBS = Object.freeze({
  graph: { flags: [], options: ['project', 'from'] },
  reading: { flags: ['json'], options: ['project', 'from'] },
});

export function parseUnderstoryCliArgs(args) {
  const [verb, ...input] = args;
  if (verb == null || verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!(verb in VERBS)) fail(`unknown command ${JSON.stringify(verb)}.`);
  const spec = VERBS[verb];
  const options = { help: false, verb, project: null, from: null, json: false };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (!arg.startsWith('--')) fail(`${verb} takes no positional arguments.`);
    const name = arg.slice(2);
    if (spec.flags.includes(name)) {
      options[name] = true;
      continue;
    }
    if (spec.options.includes(name)) {
      const value = input[index + 1];
      if (value == null || value.startsWith('--')) fail(`--${name} requires a value.`);
      options[name] = value;
      index += 1;
      continue;
    }
    fail(`--${name} is not valid for ${verb}.`);
  }
  if (options.from != null && options.project != null) fail('pass --from or --project, not both.');
  return options;
}

function loadJson(options, environment, cwd) {
  if (options.from != null) {
    try {
      return JSON.parse(readFileSync(options.from, 'utf8'));
    } catch (error) {
      fail(`${options.from}: ${error.message}`);
    }
  }
  return foresterJson(loadForester({ project: options.project, environment, cwd }));
}

export function runUnderstory({ options, environment = process.env, cwd = process.cwd() }) {
  const json = loadJson(options, environment, cwd);
  if (options.verb === 'graph') {
    process.stdout.write(understoryGraph(json));
    return 0;
  }
  const rows = understoryReading(json);
  if (options.json) {
    console.log(JSON.stringify({ summary: understorySummary(json), reading: rows }, null, 2));
    return 0;
  }
  const width = Math.max(...rows.map((row) => row.id.length));
  console.log([understorySummary(json), ...rows.map((row) => `  ${row.id.padEnd(width)}  ${row.state.padEnd(7)}  ${row.line}`)].join('\n'));
  return 0;
}

export function understoryHelp(cli = 'de-novo skills') {
  return `the story under the canopy: Forester's graph, drawn and read for people

usage:
  ${cli} understory graph   [--project ROOT | --from plan.json]   the plan as a Mermaid flowchart
  ${cli} understory reading [--project ROOT | --from plan.json] [--json]
                                                                one line per item a reader can act on

Both are computed from forester plan --json and nothing else; --from takes
a saved copy of that output. The document around them is written by an
agent reading skills/understory/SKILL.md.`;
}
