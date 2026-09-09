import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { doingFromEvents, readTranscript, transcriptFromEvents } from '../lib/seat-events.mjs';

test('the transcript a session names comes from the last hook payload that carries one', () => {
  assert.equal(transcriptFromEvents(''), null);
  assert.equal(transcriptFromEvents('{"hook_event_name":"Stop"}\n'), null);
  const text = [
    '{"hook_event_name":"UserPromptSubmit","session_id":"s1","transcript_path":"/t/one.jsonl"}',
    '{"hook_event_name":"PreToolUse","tool_name":"Edit"}',
    '{"hookEventName":"stop","sessionId":"s2","transcriptPath":"/t/two.jsonl"}',
    'not json',
  ].join('\n');
  assert.deepEqual(transcriptFromEvents(text), { transcript: '/t/two.jsonl', session_id: 's2' });
});

test('a doing line names a file from the worktree, whatever length the whole path has', () => {
  const base = '/very/long/' + 'x'.repeat(120) + '/seats/w1';
  const text = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `${base}/app/api/server.mjs` } }) + '\n';
  assert.equal(doingFromEvents(text, { base }), 'Edit app/api/server.mjs');
  assert.equal(doingFromEvents(text).length, 'Edit '.length + 80, 'without a base the whole path is shortened');
  assert.equal(doingFromEvents(text, { base: '/elsewhere' }), `Edit ${`${base}/app/api/server.mjs`.slice(0, 80)}`);
});

test('a transcript reads as turns: the person, the agent, and each tool call folded with its result', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seat-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const at = '2026-09-09T10:00:00.000Z';
  writeFileSync(file, [
    JSON.stringify({ type: 'file-history-snapshot', ignored: true }),
    JSON.stringify({ type: 'system', timestamp: at, message: { content: [{ type: 'text', text: 'system note, not a turn' }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: 'Fix the typo' } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'a', name: 'Grep', input: { pattern: 'teh' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'README.md:3' }] }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm   test\n--silent' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'zzz', content: 'orphan result' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'Fixed.' }] } }),
    '{not json',
  ].join('\n') + '\n');
  const turns = readTranscript(file);
  assert.deepEqual(turns.map((x) => [x.role, x.name ?? x.text]), [
    ['user', 'Fix the typo'],
    ['assistant', 'Looking.'],
    ['tool', 'Grep'],
    ['tool', 'Bash'],
    ['tool', 'result'],
    ['assistant', 'Fixed.'],
  ]);
  assert.equal(turns[2].target, 'teh');
  const relative = readTranscript(file, { base: '/w' });
  assert.equal(relative[2].target, 'teh');
  writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'c', name: 'Edit', input: { file_path: '/w/app/x.ts' } }] } }) + '\n');
  assert.equal(readTranscript(file, { base: '/w' })[0].target, 'app/x.ts', 'a file inside the worktree is named from it');
  writeFileSync(file, [
    JSON.stringify({ type: 'file-history-snapshot', ignored: true }),
    JSON.stringify({ type: 'system', timestamp: at, message: { content: [{ type: 'text', text: 'system note, not a turn' }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: 'Fix the typo' } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'a', name: 'Grep', input: { pattern: 'teh' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'README.md:3' }] }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm   test\n--silent' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'zzz', content: 'orphan result' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'Fixed.' }] } }),
    '{not json',
  ].join('\n') + '\n');
  assert.equal(turns[2].result, 'README.md:3', 'a result is folded into the call it answers');
  assert.equal(turns[3].target, 'npm test --silent', 'a command is one line on the summary');
  assert.equal(turns[3].result, null, 'a call with no result yet stays open');
  assert.equal(turns[4].result, 'orphan result', 'a result with no call is shown on its own');
  assert.equal(readTranscript(path.join(dir, 'missing.jsonl')), null);
  // The tail is what a reader wants: the newest turns, not the first ones.
  const many = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'user', timestamp: at, message: { content: `turn ${i}` } })).join('\n');
  writeFileSync(file, many + '\n');
  const tail = readTranscript(file, { limit: 10 });
  assert.equal(tail.length, 10);
  assert.equal(tail[0].text, 'turn 40');
});
