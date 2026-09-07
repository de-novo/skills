# Writing a project overlay adapter

`runtime.commands.overlay` is the one command Grove dispatches to put a
changed service beside a project's baseline. The project writes it; Grove
never invents it.

The rules that command must obey live in
[`overlay-contract.md`](overlay-contract.md); the profile fields live in
[`runtime-profile.md`](runtime-profile.md). This file owns the **procedure**:
how to derive an adapter from the project you are sitting in, and how to know
it is right before anyone depends on it.

Checking is a command, not a review:

```bash
de-novo skills overlay verify --project <root> --image <repo>:<full-sha>
```

Write the adapter against what you measure in the project. Do not copy an
example.

## 0. Decide whether the project needs one

An overlay is a second copy of *one changed service*, addressed apart from the
baseline every other worker keeps using. If workers never need that — one
worktree at a time, or every change is verified against the baseline — leave
`overlay: none` in the profile and stop here. An adapter nobody dispatches is
a liability.

## 1. Measure what this project already runs

The adapter is a thin wrapper over the deployment path the project already
has. Find it before writing a line. Read, in this order:

| Question | Where the answer usually is |
| --- | --- |
| How does one service start locally today? | the local service-composition file, a start script, a process supervisor file, a cluster manifest set, an existing per-worktree tool |
| How is a service's image built and named? | the build or release pipeline; note whether it can produce an immutable reference |
| How is a *running* instance observed? | a health endpoint, a runtime inspection command, a readiness field, a port or endpoint file |
| How is one instance addressed apart from another? | a name prefix, a label, a host header, a generated endpoint |
| Where does per-instance state live? | a directory, a namespace, a label selector |

For each answer write down the exact command, its inputs, and where its state
lives. Two of those answers matter most: the one that can *start a named
instance*, and the one that can *observe a running instance*. The first
becomes `create`/`attach`, the second becomes `status`, and without the second
no attach can ever finalize.

If nothing in the project can start a second instance of a service, the
project has no local runtime to overlay. Say so and stop; do not introduce a
runtime the project has not chosen.

## 2. Map the five verbs onto what you found

The adapter is one executable that takes a verb, its arguments, and `--apply`,
and prints one JSON object as its last stdout line. Grove tokenizes the
configured string and runs it from the project root without a shell; argv,
environment, and timeouts are in the contract.

| Verb | What it must mean here |
| --- | --- |
| `create` | bring an empty environment into being — the namespace, directory, label, or record everything else hangs from. Keep it cheap and repeatable. |
| `attach` | make this environment's copy of one service run exactly the requested immutable image, replacing whatever ran before. |
| `detach` | remove that service from this environment; the environment stays. |
| `destroy` | remove the environment and every workload and routing resource it owns. |
| `status` | report what is running now, per environment and per service. |

Every verb runs twice sooner or later — a retry after an interruption is
normal — so each must be idempotent for the same arguments. Postconditions,
plan semantics, and the recovery rules are the contract's.

## 3. Answer status from the runtime, not from the spec

This is the step most adapters get wrong, and it is the one that makes attach
finalize or hang.

- Build the inventory on every call from the backend you selected: ask the
  running instance, not the file that says what should run. A desired-state
  file will happily report an image that failed to start.
- Report `ready` from the project's own readiness check, not from "the start
  command exited zero".
- Report the image you observed, in the same canonical form attach was given.
  Grove compares the two exactly and resolves nothing. During a replacement,
  report the previous image or `ready: false` until the new revision is
  actually serving.
- Keep an environment present until every resource it owns is gone.

If the backend cannot tell you which image a running instance is, give the
workload a way to say so at attach time — a label, an environment variable it
echoes, an endpoint that returns its own revision — and read it back in
`status`. An adapter that cannot observe its own image cannot attach.

## 4. Where the receipt comes from

The receipt is the adapter's answer, not a transcript. Echo the identity you
were handed — environment, service, image — verbatim; Grove rejects a receipt
whose identity disagrees with the request, and normalizing an image reference
is the usual way to trip that.

Two answers, and no third:

- **Accepted.** Exit zero with `ok: true` and the identity fields for that
  verb. Without `--apply` on a plan-first adapter, add `plan: true` and change
  nothing.
- **Refused.** Anything you will not honor — a service this project does not
  overlay, an image that is not a full sha or digest, an environment name you
  cannot use — is rejected **before touching the runtime**: exit non-zero with
  `{ "ok": false, "mutated": false, "error": "…" }`. That shape is what lets
  Grove withdraw the journal it wrote and leave the environment usable. A
  crash halfway through a mutation is the opposite case: exit non-zero without
  that shape, and the operation stays pending until it is rerun.

Validate first, mutate second. An adapter that validates after starting work
cannot honestly claim `mutated: false`.

## 5. When the project's tool binds an environment to a revision

Some backends cannot create an empty environment: the environment is born from
a worktree and a revision in one step. Set `overlay.create_on: attach` in the
profile. The first applied attach for an untracked environment then dispatches
`create` immediately before it, from the caller's directory, as its own
journaled mutation; the caller's directory reaches the adapter in the
environment (see the contract). The adapter's own obligations do not change:
`create` stays idempotent, and `status` must show the environment afterwards.

Leave the default (`plan`) when an environment can exist before any image is
attached — it is simpler and lets whoever seats a worker create the
environment up front.

## 6. Run `overlay verify` until it is green

`verify` drives the project's own adapter through the contract in a throwaway
environment and prints one counted report: each case as pass, fail, or skip
with the evidence it observed. It exits non-zero when any case fails.

```bash
de-novo skills overlay verify --project <root>                       # lifecycle only
de-novo skills overlay verify --project <root> --image <immutable>   # attach cases too
de-novo skills overlay verify --project <root> --json                # for tooling
```

- The attach cases need a real image the project can actually run. Without
  `--image` they are skipped and counted as skipped — a green report with
  skips has not verified attach.
- `verify` names its own environment (`--env` overrides) and refuses to run
  against a name that already exists, so it can never touch a worker's
  environment.
- It destroys what it created, even when a case fails, and reports whether
  that cleanup succeeded.

What the failures usually mean:

| Case that fails | Fix in the adapter |
| --- | --- |
| `plan-mutates-nothing` | the verb acted without `--apply`; gate the mutation, or declare `overlay.plan_first: false` |
| `create-observed` | `status` does not list an environment `create` just made |
| `create-idempotent` | a second `create` left another environment; make it a no-op when the target exists |
| `attach-refuses-unknown-service` / `attach-refuses-mutable-tag` | the adapter accepted a request it should refuse; add the refusal receipt from step 4 |
| `attach-observed` | the observed image or `ready` does not match the request — usually status read a spec, or the readiness check is too eager |
| `status-inventory-shape` | services are reported as bare names; report `service`, `image`, `ready` per service |
| `refusal-leaves-no-journal` | a refusal reached the runtime, or arrived without the `mutated: false` shape, and locked the environment |
| `receipt-identity` | the receipt drops or rewrites a field it was handed |
| `destroy-observed` | something the environment owns outlived `destroy` |

Run it after every change to the adapter, and once more against the real
backend before any worker is seated on it. A red case is cheaper now than a
pending operation in someone else's environment later.

## A worked shape

The Grove catalog carries a small process backend used to execute this
contract for real:
[`infra/bin/fixtures/process-overlay.mjs`](../../../infra/bin/fixtures/process-overlay.mjs).
An environment is a directory, `attach` starts the artifact's process and
records the endpoint it reports, `status` queries that endpoint and answers
with the image the process says it is running and readiness from the response,
and `destroy` shuts it down and removes the marker. Roughly seventy lines, and
every rule above is visible in it.

Read it as a shape — the smallest thing that satisfies the contract — not as a
template. Your project's backend is whatever step 1 found.
