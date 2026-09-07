# Playground arc evidence — 2026-09-08

The playground is the catalog's disposable sample project. This record is one
execution of its whole arc, on a machine with no Docker involved, plus the
defects that execution found and what each fix is guarded by.

## What the run demonstrates

| Capability | Observed result |
| --- | --- |
| Sandbox creation | `up` copied the sample, initialised its own Git repository, and started 3 loopback listeners on kernel-assigned ports |
| No port chosen in advance | Two consecutive sandboxes took different ports; no port constant appears in the sample source |
| Adapter conformance | `overlay verify` reported cases 10/10, skipped 0, with the service inferred from the image reference |
| Thin overlays | `web` attached at a new revision; `web--w1` served the changed heading while `web` served the baseline one |
| Fallthrough | `api` was never attached, so `api--w1` and `api` both answered from the baseline at the same revision |
| Seating a worker | `dryad plan` created the seat worktree and branch inside the sandbox, and flagged the hand-made environment that had no seat |
| Machine isolation | Machine Dryad and overlay registries showed 0 playground mentions throughout, checked with the machine's own state directory |
| Teardown | `down` reported 0 processes alive, 0 ports listening, 0 registry mentions, 0 directories remaining |

The counts above are one dated execution, not a guarantee.

## The commands that ran

```bash
node infra/bin/cli.mjs playground up --dir "$PWD/.playground/sandbox"
# then, with GROVE_STATE_DIR set to the sandbox, the lines `up` prints:
node infra/bin/cli.mjs validate "$SB/project"
node infra/bin/cli.mjs urls "$SB/project"
node infra/bin/cli.mjs overlay verify --project "$SB/project" --image "playground/api:$SHA"
node infra/bin/cli.mjs dryad plan worker --project "$SB/project" --task '…' --by reader --apply
# the overlay, from inside the sandbox project:
node tools/build.mjs web --sha "$NEW"
node infra/bin/cli.mjs overlay create w1 --apply --project .
node infra/bin/cli.mjs overlay attach w1 web --image "playground/web:$NEW" --apply --project .
node infra/bin/cli.mjs playground down --dir "$PWD/.playground/sandbox"
```

Observed at the router, by name:

```text
web.playground.localhost       <h1>playground / web</h1>
web--w1.playground.localhost   <h1>playground / web — second edition</h1>
api--w1.playground.localhost   {"env":"baseline","revision":"0f4ec10c88b8…"}
```

## What the run found

Three defects, all in the playground itself, all found by running it rather
than by reading it.

1. **`status` and `down` refused without `GROVE_STATE_DIR`** even though the
   sandbox path was the argument they were given. `up` never required it, so
   this was an inconsistency, not a protection. They now derive the state
   directory and refuse one naming a different sandbox. Every other catalog
   verb still requires it, which is what actually keeps a sandbox call away
   from the machine registry.
2. **The process record could not tell a tool that ran from a service that
   died.** `up` printed `3/4 alive` and `status` printed 40 lines of `stopped`
   for one-shot invocations, so a normal sandbox read as a broken one. The
   guard now records the exit status, and the record makes the only
   distinction it can support: `finished` recorded its own exit, whatever the
   code, and `stopped` is gone having recorded nothing. A non-zero exit is not
   a failure, because `overlay verify` requires the adapter to refuse five
   calls and a refusal is a tool exiting non-zero on purpose. The first
   attempt at this fix counted those five refusals as deaths; running verify
   again is what caught it.
3. **The process directory published its own staging file.** Records were
   written as `<pid>.json.tmp` beside `<pid>.json`, so anything listing that
   directory could see a name that was about to disappear. It surfaced as an
   ENOENT during `up` under parallel test load, once in eight runs. Records
   are now staged in `run/staging/` and renamed in. Grove's own registries were
   never exposed to this: their staging names are dot-prefixed and end in
   `.tmp`, and every reader filters for `.json`.

## Measurement

```bash
node --test infra/bin/playground.test.mjs   # 10/10
npm test                                    # 234/234 (231 before)
```

Each new guard was reverted once and the test run again:

| Reverted | Red |
| --- | --- |
| `status` derives its own state directory | 1 |
| Exit status recorded | 1 |
| Ports name what is listening now | 3 |
| A conflicting state directory is refused | 1 |
| Staging outside the process directory | 1 |
| A recorded exit means finished, whatever the code | 1 |

The ENOENT flake was reproduced three times out of eight before the fix, by
running the playground tests against eight concurrent copies of the suite, and
did not reproduce in three such runs after it.

A read-retry added alongside the staging fix could not be made to fail once
staging moved out of the published directory, so it was removed rather than
kept as unexercised code.

## Not measured

- A second person running the arc without help. The time it takes someone else
  to learn this is still unmeasured.
- Anything at scale or over time: one sandbox, one seat, one afternoon.
- Any shared engine, container, or cluster. Isolation rule 4 puts those out of
  scope for the playground by design, and they are measured in the
  [Kubernetes lifecycle record](2026-09-06-kubernetes-lifecycle.md) instead.
