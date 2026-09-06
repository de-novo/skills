# Overlay lifecycle contract

Grove owns the lifecycle gate, lease registry, and counted receipts. The
consuming project owns its overlay workloads and routing implementation through
`runtime.commands.overlay`. Grove never invents a Docker, Compose, or Kubernetes
cleanup command.

Profile fields and value syntax live in
[`runtime-profile.md`](runtime-profile.md). This file owns the command and
receipt contract.

## Lifecycle

```text
registry --write pending--> project mutation --status postcondition--> finalize registry
                                  |                 |
                                  +--interruption---+--retry same --apply command
```

Use only the Grove front door:

```bash
de-novo skills overlay status [env] [--project <root>]
de-novo skills overlay create <env> [--project <root>] [--apply]
de-novo skills overlay attach <env> <service> --image <full-sha> [--project <root>] [--apply]
de-novo skills overlay detach <env> <service> [--project <root>] [--apply]
de-novo skills overlay destroy <env> [--project <root>] [--apply]
de-novo skills overlay touch <env> [--project <root>]
de-novo skills overlay prune [--project <root>] [--stale-after <duration>] [--apply]
```

Do not call `runtime.commands.overlay` directly. A direct call bypasses the
lease registry, so Grove cannot distinguish a live environment from leaked
workloads.

Environment names are DNS labels of at most 63 characters. Attach accepts only
an image tag ending in a 40-character lowercase git SHA or a `sha256` digest.
The service must be listed in `overlay.attachable`.

Project `create`, `attach`, `detach`, and `destroy` implementations must be
idempotent for the same arguments so a command can be retried after a process
interruption. A valid success receipt says that the command was accepted; it
does not by itself prove the runtime result.

For every applied mutation, Grove writes a pending operation for that
environment to the registry before dispatch. It then polls project
`status <env>` and finalizes the registry only after observing the
postcondition:

| Mutation | Required status postcondition |
| --- | --- |
| `create` | environment present |
| `attach` | environment and service present, observed image equals the request, and `ready: true` |
| `detach` | environment present and service absent |
| `destroy` | environment absent |

If dispatch is interrupted, its receipt is invalid, status cannot measure the
postcondition, or the postcondition times out, the pending operation remains.
`status` reports pending operations in its selected scope and returns non-zero
but never completes them. Each `pending-item` line carries a liveness label:
`in-flight pid <n>` while that environment's lock is held by a live process on
this machine, `stalled` when no live owner holds it, `unknown` when the lock
names another host or cannot be read. In-flight means wait; stalled means rerun
the same `--apply` command. The exit code does not depend on the label. A
pending operation in one environment does not make another environment's
scoped status fail. Rerun the same mutation with
`--apply`; Grove redispatches the idempotent project command, checks status
again, and finalizes only after observation. Until that recovery succeeds, the
same environment rejects any other mutation, the same mutation with different
project-specific passthrough arguments, and `touch`. Other environments can
continue. Internal `status <env>` receives the same passthrough arguments so it
measures the same project context.

## Leases and stale environments

Grove records `created_at` and `last_used_at` for every environment. Successful
`create --apply`, `attach --apply`, `detach --apply`, and `touch` operations
renew `last_used_at`. Read-only `status` does not renew it.

Staleness means:

```text
now - last_used_at >= stale_after
```

Durations use a positive integer followed by `s`, `m`, `h`, `d`, or `w`.
There is deliberately no default retention period. Put `stale_after` in the
project profile, or pass `--stale-after` to `status` and `prune`. `prune`
refuses to run without one of those explicit policies.

`status` returns non-zero when a tracked environment is stale or when project
runtime inventory differs from the registry, a tracked service is not ready,
or its runtime identity cannot be measured. A long-running task renews its
lease with `touch`. A task destroys its environment when work ends; retention
is a backstop for abandoned work, not the normal end path.

`prune` is plan-first regardless of the project implementation:

- Without `--apply`, it prints exactly which stale environments would be
  destroyed and does not invoke the project command.
- With `--apply`, it dispatches `destroy` once per stale environment. A failed
  or unverified destroy stays in the registry with its pending operation and is
  counted as retained. Cleanup continues with unrelated candidates. A busy
  environment or a pending non-prune operation is retained too. Rerun prune to
  recover its failed target; a non-prune operation needs its original command.
- Each target's staleness is checked again under that environment's lock. A
  lease renewed before cleanup acquires the lock is not removed. Environments
  already removed by another command are skipped.

An environment reported by project `status` but absent from the registry is
`untracked` drift. Grove does not assign an invented age and will not prune it
automatically. Inspect it, then clean it explicitly with
`overlay destroy <env> --apply`.

## Plan and apply

`overlay.plan_first` tells Grove how the project command behaves:

| Profile value | Grove command without `--apply` | Grove command with `--apply` |
| --- | --- | --- |
| omitted or `true` | Dispatch without `--apply`; require `plan: true`; registry unchanged | Write pending, dispatch with `--apply`, reject a plan-only receipt, verify status, then finalize registry |
| `false` | Refuse without dispatch | Write pending, dispatch without forwarding `--apply`, reject a plan-only receipt, verify status, then finalize registry |

Project-specific arguments may follow `--`. Grove never retries by guessing
from stderr.

## Project command invocation

Grove tokenizes `runtime.commands.overlay` as an executable and arguments. It
does not evaluate a shell expression.

```text
cwd     = project root containing .agents/runtime-profile.yml
timeout = 120000ms
argv    = configured command + verb + lifecycle arguments
```

`GROVE_OVERLAY_TIMEOUT_MS` may set a positive timeout in milliseconds
(`DEVINFRA_OVERLAY_TIMEOUT_MS` is a legacy alias read only when the Grove name
is unset). Postcondition polling also defaults to 120000ms;
`GROVE_OVERLAY_VERIFY_TIMEOUT_MS` may set that deadline. Each internal status
call is bounded by the remaining verification time.

The last non-empty stdout line must be one JSON object. Exit code zero without
`ok: true` is a failure. Identity fields must match the request; otherwise
tracked environments remain unchanged and an applied operation retains its
pending journal.

```json
{
  "ok": true,
  "verb": "attach",
  "env": "w1",
  "service": "api",
  "image": "example/api:0123456789abcdef0123456789abcdef01234567",
  "plan": false
}
```

Required fields:

| Verb | Required receipt identity |
| --- | --- |
| `create` | `ok`, `verb`, `env` |
| `attach` | `ok`, `verb`, `env`, `service`, `image` |
| `detach` | `ok`, `verb`, `env`, `service` |
| `destroy` | `ok`, `verb`, `env` |
| `status` | `ok`, `verb` |

An applied `attach` with `addressing.proxy: machine` also requires `upstream`.
Grove still does not start a hostname listener; that proxy value is declared
intent.

`status` must add runtime inventory to report a clean runtime. With no
environment argument it is the complete inventory; with `status <env>` it
contains that environment or an empty list when absent:

```json
{
  "ok": true,
  "verb": "status",
  "environments": [
    {
      "env": "w1",
      "services": [
        {
          "service": "api",
          "image": "example/api:0123456789abcdef0123456789abcdef01234567",
          "ready": true
        }
      ]
    }
  ]
}
```

Each service observation carries a unique `service`, an immutable `image`,
and a boolean `ready`. The image must describe the running workload, not merely
its desired deployment spec. Report ready only when the project's workload
readiness checks pass. During replacement, report the old image or `ready:
false` until the requested revision is running and ready. Use the same canonical
image reference in attach and status; Grove compares it exactly and does not
resolve registry tags to digests. Prefer a digest when the backend exposes one.
Readiness does not prove hostname routing; verify that separately in the project.

Name-only `services` lists and legacy `overrides` keys are accepted for
inspection and absence checks. They cannot finalize attach. For tracked
attachments they produce `runtime image and readiness notMeasured` drift and
non-zero status. Update project adapters to service observations before using
attach. No registry migration is required; recorded images already exist.

Build this inventory from the selected runtime backend on every call, not from
Grove's registry or an optimistic mutation result. Keep an environment present
until all project-owned workload and routing resources represented by that
environment are actually absent.

If `environments` is omitted, an operator-requested status report says
`drift notMeasured` and returns non-zero. Applied mutations cannot finalize
without this inventory; their pending operation remains. `project-status 1/1`
means only that the command returned a valid receipt; it is not presented as a
clean runtime.

## Registry and concurrency

The machine-local registry is `~/.dev-infra/overlays/<project-slug>.yml`.
`GROVE_STATE_DIR` overrides its directory for isolated tooling and tests.
Files are written by temporary-file rename with private permissions. Each
environment has an exclusive lock under `<project-slug>.yml.env-locks/` held
through project dispatch, readiness verification, and finalization. Commands
for different environments can run concurrently; a command for an already
busy environment fails without dispatch. Same-environment commands are not
automatically queued.

The project registry lock protects only short read/merge/write transactions.
Contending metadata writers retry for up to two seconds; no project workload
command or readiness poll runs while holding this lock. Finalization rereads
the registry and updates only its own environment so another command's records
and pending operations survive. Touch and prune use the same environment locks;
prune never holds a project lock across its cleanup loop.

A dead same-machine process lock is recovered, while a live or unknown owner
is not stolen. Dead-owner recovery itself is serialized. An interrupted lock
recovery marker is retained for inspection rather than removed speculatively.

Project adapters must support concurrent operations on different environments.
Use environment-specific workload state, and serialize only genuinely shared
backend updates such as a shared routing file. Grove's registry lock does not
protect project-owned files, routers, or database changes. Update adapters that
relied on project-wide dispatch serialization before using the parallel CLI.

The registry contains lifecycle metadata, image references, optional upstreams,
the creating agent/worktree, and at most one pending mutation per environment
in `pending_by_env`. The pending record is the crash-recovery journal and is
written before project dispatch. It
contains no credentials or raw project-specific passthrough arguments; only a
SHA-256 digest is retained to reject recovery in a different context. The
registry is not a second workload controller: runtime drift is reported, not
silently repaired.

Registry version 2 stores these per-environment journals. Version 1 registries
are accepted on read, including an existing single `pending` operation; the
next successful metadata write preserves it under its environment and writes
version 2. Read-only status does not rewrite the file. Older CLIs reject
version 2, preventing them from silently overwriting concurrent journals.
Upgrade CLI users of a shared registry together; downgrading requires finishing
or explicitly recovering outstanding work with the current CLI first.

Overlay cleanup never stops Grove's shared engines. There is no `down` command.
