// A scripted worker that behaves like a seated agent. It starts from a seat's
// `--shell` line (so cwd and DRYAD_* come from the seat), reads its seat and
// the skill through the seat, reports working, changes one file on its own
// branch, commits, and reports done with a session reference. It never pushes,
// never touches the baseline, never calls finish. Tests use it to measure the
// worker side of the seat contract without any real agent tool.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const id = process.env.DRYAD_ID;
const project = process.env.DRYAD_PROJECT;
const skill = process.env.DRYAD_SKILL;
const cli = process.env.DRYAD_TEST_CLI;
if (!id || !project || !skill || !cli) throw new Error('worker needs DRYAD_ID, DRYAD_PROJECT, DRYAD_SKILL, DRYAD_TEST_CLI');

const dryad = (...args) => {
  const result = spawnSync(process.execPath, [cli, 'dryad', ...args, '--project', project], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`dryad ${args.join(' ')} failed: ${result.stderr}`);
  return result;
};
const git = (...args) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Seat Worker', '-c', 'user.email=worker@example.invalid', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const seat = JSON.parse(dryad('seat', id, '--json').stdout);
if (path.resolve(seat.worktree) !== path.resolve(process.cwd())) throw new Error(`worker cwd ${process.cwd()} is not the seat worktree ${seat.worktree}`);
if (!existsSync(skill) || !readFileSync(skill, 'utf8').includes('# Dryad')) throw new Error(`skill not readable at ${skill}`);
const task = dryad('seat', id, '--task').stdout.trim();

dryad('report', id, '--status', 'working', '--note', `read skill and seat; task: ${task.slice(0, 40)}`);
appendFileSync('WORK.md', `seat ${id} on ${seat.branch}: ${task}\n`);
git('add', 'WORK.md');
git('commit', '-q', '-m', `${id}: ${task.slice(0, 40)}`);
const head = git('rev-parse', 'HEAD');
dryad('report', id, '--status', 'done', '--note', `committed ${head.slice(0, 12)}`, '--session', `worker-${process.pid}`);
process.stdout.write(`${JSON.stringify({ id, head, branch: seat.branch })}\n`);
