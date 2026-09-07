# Parallel execution per overlay: the change and its verification

A project-wide lock used to block create, apply, and delete across different
overlays. That is fixed. Changes to the same overlay still exclude each other.
A per-overlay lock is held during execution and the readiness check, and the
shared registry is locked only for a short read, merge, and write section. One
overlay's record is never overwritten by a stale snapshot of another.

Unfinished work is recorded per overlay. A recovery needed on one side does not
stop change, status checks, or lease renewal on the other. Cleanup of old
environments also locks per target; a failed target is left in place while
cleanup of the other targets continues. The lease is checked again immediately
before cleanup.

The authority for the operating contract and for the status format is
[overlay-contract.md](../../skills/grove/references/overlay-contract.md). If an
existing adapter updated a shared file on the assumption that a project runs
serially, that file's concurrent update must be protected in the adapter before
the parallel CLI is used. Update the shared registry's CLI users together,
rather than mixing the old CLI with the new registry format.

## What was executed, and the result

No existing consuming project was used. The changed paths ran on a real
worktree in a temporary Git repository and on isolated Node HTTP processes.
Shared engines, DBs, and routing were not touched. Concurrent adapter execution
on a shared backend is `notMeasured`.

- [The regression test](../../infra/bin/overlay-parallel.test.mjs) builds a
  state on a real worktree in which two create, apply, and delete commands are
  all running. It checks that a competing command on the same target is
  rejected, and that each side's record and recovery request are preserved even
  when the completion order is reversed.
- These paths ran: reading an existing single recovery record, preserving it,
  and writing it in the new format; status and lease renewal for an environment
  unrelated to the recovery; preservation of a lease renewed during cleanup;
  cleanup of targets after a failed one.
- [The real-worktree re-run](../evaluation/synthetic/worktree-parallel-results.json)
  removed the waits and retries in the experiment's call site. Each worker calls
  each command once. It checks whether the other side's source, artifacts, and
  response, and the baseline app, are kept while one side redeploys or deletes.
- [The synthetic failure-scenario re-run](../evaluation/synthetic/parallel-results.json)
  holds a leftover previous image, a readiness failure, an aborted run, and a
  failed cleanup in place, and checks whether another overlay can still proceed.

The specific candidate identifiers, the number of runs, and the check results
are recorded in the [verification receipt](2026-09-05-overlay-parallel.json). A
candidate is the uncommitted change on top of the recorded base commit,
distinguished by file hash. No commit or push was performed.

```bash
node --test infra/bin/overlay-parallel.test.mjs
node docs/evaluation/synthetic/worktrees.mjs docs/evaluation/synthetic/worktree-parallel-results.json
node docs/evaluation/synthetic/run.mjs docs/evaluation/synthetic/parallel-results.json
npm test
```

The new checks were confirmed to fail in a run with the production code reverted
to its state before the change, and in runs that removed the overlay lock, the
recovery-record key check, and the lock-reclaim protection, each separately.
Every mutated JavaScript passed a syntax check. The production code was then
restored and the full check suite ran. The mutation runs' results are also
preserved in the verification receipt.
