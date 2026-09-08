// A stand-in for an interactive coding tool, for Forester's serve tests. It
// behaves like one at the seams Forester reads: it takes the task as its
// argument, runs inside a pseudo-terminal, appends hook-shaped events to
// FORESTER_EVENTS, waits for a person to type `y` and Enter before acting,
// then reports done through Dryad the way a seated worker does, and exits.
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
const task = process.argv[2] ?? '';
const events = process.env.FORESTER_EVENTS;
const event = (name, extra = {}) => { if (events) appendFileSync(events, JSON.stringify({ hook_event_name: name, ...extra }) + '\n'); };

process.stdout.write(`fixture tool · seat ${process.env.DRYAD_ID} · task: ${task}\r\n`);
event('UserPromptSubmit');
event('Notification', { notification_type: 'permission_prompt' });
process.stdout.write('allow? (y/N) ');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let typed = '';
process.stdin.on('data', (chunk) => {
  typed += chunk.toString('utf8');
  if (!typed.includes('\r') && !typed.includes('\n')) return;
  process.stdin.pause();
  if (!/y/i.test(typed)) {
    process.stdout.write('\r\nrefused\r\n');
    event('Stop');
    process.exit(2);
  }
  event('PostToolUse');
  writeFileSync(path.join(process.cwd(), 'done.txt'), `${task}\n`);
  const report = spawnSync(process.execPath, [CLI, 'dryad', 'report', process.env.DRYAD_ID, '--status', 'done', '--note', 'fixture finished'], { encoding: 'utf8', env: process.env });
  process.stdout.write(`\r\nreport exit ${report.status}\r\n`);
  event('Stop');
  // Stay alive like a TUI would after its turn; serve closes us.
  setInterval(() => {}, 1000);
});
