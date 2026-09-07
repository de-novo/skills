// Public CLI fixture for discovery and the second-screen status contract.
// No registry reads: status fixtures are enabled explicitly by the test runner.
const args = process.argv.slice(2);
const projects = JSON.parse(process.env.CANOPY_TEST_PROJECTS ?? '[]');
if (args.join(' ') === 'dryad projects --json') {
  console.log(JSON.stringify({ projects }));
} else if (process.env.CANOPY_TEST_SCREEN === '1') {
  const changes = {
    base: '1234567',
    committed: [{ path: 'shared.txt', status: 'M' }, ...Array.from({ length: 13 }, (_, n) => ({ path: `file-${n}.txt`, status: 'A' }))],
    uncommitted: [{ path: 'open.txt', status: '??' }],
    counts: { committed: 14, uncommitted: 1, ahead: 2 },
  };
  const seats = ['w1', 'w2'].map((id, index) => ({
    id, worktree: `/fixture/${id}`, branch: `task/${id}`, ahead: 2,
    by: 'worker', task: `Task ${id}\nHidden second task line`, status: 'working',
    env: id, env_state: 'tracked', session: `session-${id}`,
    journal: [
      { at: '2026-09-07T00:00:00Z', event: 'plan', actor: 'human', detail: 'Planned' },
      { at: '2026-09-07T00:01:00Z', event: 'report', actor: 'seat', detail: `Report ${id}` },
      { at: `2026-09-07T00:0${index + 2}:00Z`, event: 'cli', actor: 'seat', detail: `overlay attach ${id} api --apply`, exit: 0 },
    ],
    hostnames: [{ host: `api--${id}.example.localhost`, service: 'api', attached: true }, { host: `web--${id}.example.localhost`, service: 'web', attached: false }],
    changes: index ? { ...changes, committed: [{ path: 'shared.txt', status: 'M' }], uncommitted: [], counts: { committed: 1, uncommitted: 0, ahead: 2 } } : changes,
  }));
  const worktrees = [
    ...seats.map(seat => ({ path: seat.worktree, branch: seat.branch, head: 'abcdef0', seat: seat.id, baseline: false })),
    { path: '/fixture/main', branch: 'main', head: '1234567', seat: null, baseline: true },
  ];
  let report;
  if (args[0] === 'overlay' && args[1] === 'status') {
    report = { counts: { environments: 2, attachments: 2, pending: 1, stale: 0, drift: 0 }, pending: [{ env: 'w1', verb: 'attach', liveness: 'in-flight' }] };
  } else if (args[0] === 'dryad' && args[1] === 'status') {
    report = args.includes('--finished') ? { finished: [] } : {
      seats, worktrees, overlaps: [{ path: 'shared.txt', seats: ['w1', 'w2'] }],
      counts: { seats: 2, worktrees_present: 2, worktrees: 3, unseated: 1, envs_tracked: 2, envs_wanted: 2, overlaps: 1 },
      problems: ['w1: attachment pending'],
    };
  } else throw new Error('unexpected fixture command');
  console.log(JSON.stringify(report));
} else throw new Error('unexpected fixture command');
