# A concurrent-change experiment on real Git worktrees

This document is a diagnostic record from before the parallel-execution fix. The
fixed behaviour and the re-run without retries are in
[the parallel-execution change evidence](../evidence/2026-09-05-overlay-parallel.md).

2026-09-05. Real worktrees on separate branches were created in a temporary Git
repository, and an independent Node worker process ran in each worktree. No
existing project and no worktree managed by an external worktree tool were used.
The worktrees are real; a developer's judgment was replaced by a process that
runs a fixed task. This is not a productivity experiment with people or with
independent AI agents.

## What changed from the previous experiment's boundary

[The previous synthetic experiment](2026-09-05-synthetic-evaluation.md) verified
several running environments created under the same temporary root. It did not
check editing and building at the same time from separate Git worktrees, so it
was not enough evidence for this requirement.

This time a branch per worktree was created from the same base commit. Each
worker process edits a source file at the same relative path inside its own cwd,
with different content. It assembles an executable file, runs a real
`node --check`, and produces an artifact in that worktree's `.build/`. Different
worker PIDs, branches, sources, and artifacts are checked, and the monotonic
clock of the same machine is used to confirm that the edit and build sections
really overlap.

The profile uses the same project name in both worktrees. The Grove registry and
the process backend are shared, and only the work environment names differ. Each
worker process calls the Grove CLI directly from its own worktree. Whether the
registry records the real worktree path and the worker identifier separately is
also checked.

After the build, a coordinating process registers the two artifacts' hashes and
locations with the synthetic backend. This central registration step is for the
experiment; it is not an upload to an independent container registry. The two
workers then request create and deploy at the same time and cross-check the
executable-file hash and the changed content in their own HTTP responses. Setup
time covers everything from the edit request to both sides' independent HTTP
verification. Creating the repository and the worktrees and starting the
baseline app are separate setup time.

## The effect of one side's work on the other

Once both running environments are ready, one worker keeps querying its own app
and the baseline app. Meanwhile the other worker edits, builds, and redeploys the
next change. It confirms that the previous address no longer responds, removes
its own running environment, ends the worker process, and removes the real Git
worktree as well.

Whether the remaining worker's HTTP response, source hash, artifact hash, and
branch are kept is checked. The baseline checkout's Git status and the baseline
app are checked too. The last work environment and worktree are then cleaned up,
and the leftover experiment-owned processes and HTTP addresses are counted.

## The problem the concurrent work exposed

At first, a call-site retry was attached only to Grove's explicit lock conflict.
But Grove saw another operation that was proceeding normally and answered as
follows, which stopped the comparison.

```text
pending operation create w2 must be recovered first;
rerun the pending create w2 operation with --apply.
```

In the candidate at the time, `runMutation` checks the compatibility of pending
operations before it takes the lock. So a state where another worker is still
running normally and a state that was aborted and needs recovery can look like
the same demand for recovery to the caller. This is not evidence of a worktree
isolation failure; it is **a problem in how a concurrent change guides waiting
and recovery**.

To finish the isolation verification, a limited wait was added at the
experiment's call site. It waits only while the competing operation belongs to
another worktree of the same experiment and the lock-holding process on the same
machine is alive. It also retries its own command when the pending record has
already been resolved. A pending operation with no live lock holder is still
treated as a failure. It does not run the competing operation's command on its
behalf, and it does not delete the lock.

**The completed run that was selected includes this call-site addition. It is
not an automatic wait feature in Grove itself.** The successful re-run does not
erase the original stop. The time spent going through retries and the counts of
lock conflicts and in-progress pending responses are recorded separately in the
results.

## The judgment, and what is still out of scope

Within this scope both approaches kept the other worktree's source, artifacts,
and running environment, and the baseline app. Grove left the worker's location
and run state in the shared registry. At the same time, a concurrent change
needed extra time and a call-site wait compared with direct execution.

To make working directly across several worktrees the core value, the first
thing to look at is **behaviour that distinguishes waiting for an operation in
progress from recovering a real abort**. The existence of a shared recovery
contract alone is not enough to conclude that parallel development is smooth.

Resolving Git merge conflicts, a real developer's judgment and working time,
container build and deploy, shared DB isolation, DNS routing, and long-term
maintenance cost were not measured. Direct execution is also a tool fitted to
this experiment's separated process file layout, so do not generalize it as
evidence that concurrent changes are safe on every backend.

## Execution evidence

Run it from the checkout root. It creates a base commit and worktrees in a
temporary Git repository; it does not commit the catalog and does not push
anywhere outside. Give a new output path to preserve existing results.

```bash
node docs/evaluation/synthetic/worktrees.mjs /tmp/grove-worktree-result.json
npm test
```

- [The selected run results](synthetic/worktree-results.json): candidate SHA,
  tool file hashes, machine conditions, per-section times, the edit and build
  sections that actually overlapped, and the retry, observation, and cleanup
  results.
- [The coordinating runner](synthetic/worktrees.mjs), [the per-worktree worker process](synthetic/worktree-worker.mjs).
- [First attempt](synthetic/worktree-attempt-01.json): a tool error that compared
  a macOS temporary path alias directly against the real path. It was re-run
  after normalizing to the real path.
- [The attempt where the concurrent change stopped](synthetic/worktree-attempt-02.json):
  a call site that retried only on the lock response stopped on the response for
  an in-progress pending operation.
- [The previous run, after the wait was added](synthetic/worktree-attempt-03.json):
  the isolation scenario completed. It is the record from before the real overlap
  of the edit and build sections was additionally confirmed as a number.

The aggregates use the runner's results. Each approach's median and the time
difference within the same pair are kept separate; runs of different protocols
are not merged, and the initial failures are not hidden inside a success rate.
