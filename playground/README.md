# Playground

Run a disposable sample project with its own Git repository, state, seats,
artifacts and processes. The catalog root remains a skill catalog. The sample
application and adapter live in `app/` and `tools/`; the sandbox lifecycle
implementation lives in [`infra/lib/playground.mjs`](../infra/lib/playground.mjs).

From a catalog checkout:

```sh
node infra/bin/cli.mjs playground up
```

The default instance is `.playground/sandbox`, in a gitignored area outside
this checkout's tracked source tree. Pass `--dir PATH` for another new directory.
Existing directories are refused. Multiple instances may run at once; each
listener requests port zero and receives its port from the kernel.

`up` copies the sample and profiles, creates the initial Git commit, starts
the baseline through `runtime.commands.up`, and prints the commands to run
next. Planting is already done. Copy the printed `validate`, `urls`,
`overlay verify`, and `dryad plan` lines: each includes the exact sandbox
state directory and project path. They use the CLI from this checkout, so an
installed CLI pointing to another checkout cannot silently select older code.

For later inspection and cleanup, use the state path from that output:

```sh
GROVE_STATE_DIR="$PWD/.playground/sandbox/state" node infra/bin/cli.mjs playground status --json
GROVE_STATE_DIR="$PWD/.playground/sandbox/state" node infra/bin/cli.mjs playground down
```

For a custom sandbox, set `GROVE_STATE_DIR` to its `state` directory. `status`
and `down` infer the sandbox from that value; both also accept `--dir PATH`.
After bootstrapping with `up`, sandbox CLI calls without the matching
`GROVE_STATE_DIR` are refused. Calls from a seated catalog worker do not carry
that worker's project or seat into the sandbox.

`status` reports process liveness, kernel-assigned ports, names from the
project profile, and references in the machine registries. Machine references
must be empty. `down` stops recorded processes, removes the sandbox directory,
and prints counts of surviving processes, listening ports, machine registry
references and remaining directories. Every count must be zero. A process
that cannot be stopped leaves the directory intact for a retry.

No shared engine or cluster is involved. Machine and provisioning verbs are
refused in a sandbox. Requests to bind beyond `127.0.0.1`, choose a nonzero
listener port, or follow a sandbox symlink are refused.

## Adapter handoff

The layout contract is in the [design](../docs/playground-design.md#sandbox-layout-the-contract-between-the-two-seats).
The lifecycle copies `app/` and `tools/` recursively without interpreting their
contents. The sample’s `.agents/runtime-profile.yml` and `.agents/dryad-profile.yml` are copied
into the project's `.agents/` directory. The Dryad worktree root must resolve
to the sandbox's `seats/` directory. The runtime profile's `commands.up` must
be a Node command that exits once the baseline is ready.

Before startup, `run/sandbox.json` contains:

- `version`: receipt format version.
- `sandbox`, `project`, `state`, `seats`, `run`: absolute layout paths.
- `host`: the permitted loopback address.
- `revision`: the initial project commit, available before the adapter runs.
- `verify_image`: the attachable service at that full revision, used in the printed verify command.
- `names`: shared service hostname records rendered from the profile.
- `processes` and `ports`: initially empty, refreshed after startup and by status.

The adapter may read this receipt and keep its own files under `run/`. Node
children inherit a sandbox preload through `NODE_OPTIONS`; it records their
PID and start time in `run/processes/<pid>.json` before application code runs,
then records ports on the listener's `listening` event. Those receipts include
completed adapter invocations as well as live services. The preload permits
Node, Git and process inspection commands, rejects shells and other commands,
and enforces loopback and port-zero binding. Keep its environment when
launching a child. `status` combines those receipts into `sandbox.json` and
checks process start times so an unrelated process reusing a PID is not stopped.

This is a disposable development environment for the supplied sample, not an
operating-system security boundary for untrusted code.

## Verification

```sh
node --test infra/bin/playground.test.mjs
npm test
```

The isolation tests use a dependency-free stub with the same `app/` and
`tools/` handoff. They execute real listeners, two simultaneous instances,
Git initialization and seats, registry inspection, and cleanup. Each isolation
rule has a separate test so its guard can be reverted and that test run alone.
The engine refusal tests use harmless executable stubs; the non-loopback
refusal probes stop at an instrumented listener boundary, including when the
guard is deliberately reverted. Neither red check reaches shared engines or
opens an external listener.
