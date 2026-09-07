# Grove's cost and recovery experience, measured by developing a synthetic app

This document is a measurement record from before the parallel-execution fix.
For the change that followed and the results of the re-run, see
[the parallel-execution change evidence](../evidence/2026-09-05-overlay-parallel.md).

This is an isolated synthetic experiment from 2026-09-05. No real consuming
project's code, configuration, names, paths, or run results were used. Do not
read it as a real team's productivity or as an adoption pass. No pass criterion
was set, and every sample and scenario fixed before the run was run. The raw run
counts, times, environment, errors, and cleanup results are in
[the selected run results](synthetic/results.json).

This experiment did not create real Git worktrees. Independent edit, build, and
deploy across several worktrees, and the effect of one side's cleanup on the
other, were checked separately in
[the follow-up worktree experiment](2026-09-05-worktree-evaluation.md).

## The development situation

The task board is a single app that returns a list of tasks. Two work
environments check, at the same time, versions that each add a different task
item. The shop is split into a shared product service and an app. Two work
environments check different discount rules while using the same product
service. Each project's baseline app keeps running as it is.

Both projects use the Node HTTP process backend. That the two app structures
differ is not evidence of portability to another backend. The synthetic changes
are generated as runnable JavaScript files. Container image builds and a real
developer's editing time are not measured.

Each app computes a hash directly from the bytes of its executable file and
returns it. The shop's response also includes the price read from the shared
product service and that service's hash. The verifying client cross-checks the
HTTP status, the requested hash, the changed feature's result, the work
environment, and the shared service's hash. The desired state recorded in the
Grove registry is not used as response evidence.

## How the comparison was made, and the boundary of the run

Direct execution is an experiment-only process management tool with the same
HTTP completion condition attached. It is not an existing team's operating
procedure. Grove calls the same process management functions through a project
adapter, but goes through the operating CLI's create, attach, and destroy paths.
Direct execution does not call Grove adapter commands by a side path; it uses a
separate entry point.

The normal comparison alternates the run order per project. Setup time includes
creating both environments, applying the change, and the independent HTTP check.
After setup, two asynchronous clients poll repeatedly at the same time, and the
baseline app's response is also checked for continuity. Teardown time includes
removing both environments and confirming that HTTP can no longer connect. The
sum of setup time and teardown time does not include the repeated polling time
in between.

The failure experiments are kept separate from the normal comparison. These are
injected: leaving the previous executable file in place; a real HTTP readiness
failure; killing the adapter process after the running process is created but
before the receipt is printed; and a failing cleanup function. The real response
is checked immediately after the failure, then the cause is released and the
same command is retried. Under Grove, the pending record and the blocking of
other changes are also checked.

In the concurrent-change experiment, the first change is held after the real
process is created, and a change command for another work environment is run.
Read concurrency and write concurrency are observed separately. The two clients
are not people and not independent AI agents, and are not used as a proxy
measure for collaboration time.

Ports are ephemeral ports on loopback. The shared product service is also a
process the experiment creates itself. Shared Docker, Kubernetes, DB, DNS, and
proxy are not touched. The processes and the Grove registry live in a temporary
directory and are removed on exit.

## The value confirmed, and the limits

Both direct execution and Grove met the conditions for a normal change and for
failure detection. In this comparison Grove did not make startup or recovery
faster. Both approaches recovered by releasing the cause and running the same
change again. Direct execution with enough verification attached can prevent the
same kind of false completion.

What Grove additionally showed is **a durable pending-operation record and a
shared recovery order**. Even when the adapter exits partway, the request
remains, and other changes are blocked until that request is recovered. This may
reduce the need to implement that state management and contract in each project.
The saving in real implementation and maintenance time is not yet measured.

On the other side, **a project-level lock serializes changes to different work
environments too.** A second Grove command that competed with a command in
progress was rejected rather than made to wait. The caller had to run it again
after the first operation finished. Direct execution writes different process
files, so it completed this situation in parallel. That fact does not prove that
the direct-execution tool is generally safe for concurrent writes.

The current investment judgment is to verify further how reusable the shared
execution contract and the recovery record are. There is not enough evidence to
sell fast startup or a productivity improvement. The next candidates for
improving the experience are guiding a competing command to wait and retry while
the lock is held, and reducing the burden of writing a project adapter.
Narrowing the lock scope right away could create concurrent-change problems on
shared resources, so this result alone is not a reason to make that change.

## Re-running, and the evidence

Run it from a checkout root that has the catalog's dependencies installed. Give
a new output path so past results are not overwritten.

```bash
node docs/evaluation/synthetic/run.mjs /tmp/grove-synthetic-result.json
npm test
```

The operating CLI's candidate SHA and the experiment tool's SHA-256 are recorded
in the result file. The experiment tool is a new file that is not contained in
that candidate commit, so check the two identifiers together. The runner prints
the aggregate, and the time comparison uses the median of paired differences
within a project. Separate runs are not merged to pick a favourable sample.

- [Experiment runner](synthetic/run.mjs) and [synthetic backend](synthetic/backend.mjs)
- [The selected run](synthetic/results.json): setup time includes the independent HTTP check.
- [First attempt](synthetic/attempt-01.json): an experiment-tool error in which
  run options were inherited through fork, so the app did not start. It did not
  reach the product comparison, and the error is preserved.
- [The previous completed run](synthetic/attempt-02.json): the scenario
  completed, but setup time ended just before the independent HTTP check. The
  measurement boundary was fixed and the whole thing was re-run.

Machine load is only the observations at the start and the end in the result
file; it is not assumed to have stayed constant throughout the run. Compilation,
image preparation, DNS routing, DB isolation, memory savings, the human time
spent on a first integration, real operator intervention, and long-term
maintenance cost are `notMeasured`.
