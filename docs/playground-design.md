# Playground — a sample project to plant Grove on, inside a sandbox

Written 2026-09-08. Status: design. Once it ships, `playground/` owns the
behaviour and `playground/README.md` owns how to use it; this note keeps only
the reasons.

## Why

The one thing this catalog does not have is a finished example you can learn
from. Today the only way to learn the skills is to plant them on your own
project, which means your first mistakes land in your own environment. The
playground runs the whole arc — plant, seat a worker, attach an overlay, verify
by name, clean up — somewhere you are meant to throw away.

The catalog is not a consuming app (AGENTS.md), so the repository root still
carries no `runtime-profile.yml`. `playground/` is the **source of a sample
project that the catalog ships**; the instance that actually runs is copied out
into a sandbox that lives outside the repository tree.

## Isolation rules — not weakenable

1. **Everything lives under one sandbox directory.** State, git repository,
   worktrees, build artifacts, logs, PIDs. `down` removes that directory and
   counts what is left.
2. **The machine registry is never touched.** `GROVE_STATE_DIR` points inside
   the sandbox. If the playground ever appears in the machine's
   `dryad projects` or overlay registry, isolation has failed. Every ordinary
   catalog verb aimed at the sandbox carries that variable, and a call without
   it is refused. The `playground` verbs are given the sandbox path itself, so
   they derive the state directory and refuse one naming a different sandbox.
   The rule governs which state directory is used, not who types it.
3. **No port number is chosen in advance.** Every listener binds port 0 and
   records what the kernel gave it. No port constant may appear in the source.
   This rule comes from the collision earlier in this work, where two projects
   each took 8080 for their own listener and one silently shadowed the other.
4. **No shared engines, no containers, no cluster.** The sample app's data is a
   file inside the sandbox. The whole arc runs on a machine without Docker.
5. **The sandbox has its own git repository.** It runs `git init`, so seats'
   branches and worktrees never reach the catalog's git.
6. **Every process started is recorded**, including its exit status, so a tool
   that ran and ended is not read as a service that died. The record can only
   say whether a process ended on its own terms, so that is the only
   distinction it makes: `finished` recorded its exit, whatever the code, and
   `stopped` is gone having recorded nothing. A non-zero exit is not a failure,
   because the overlay contract requires an adapter to refuse some calls.
   `status` counts the three and prints any non-zero code; `down` stops them and
   confirms the ports are free. Records are staged outside the process directory
   and renamed in, so a reader listing it never sees a partial name.
7. **Nothing binds beyond loopback.** A request to bind any address other than
   127.0.0.1 is refused.

## What it contains

The sample app is two dependency-free Node services. The point is to teach the
shape of Grove, not a framework, so the app itself stays minimal.

- `api` — an HTTP service returning JSON. `/health` **reaches nothing outside
  the service**, so the example satisfies the property the planting procedure
  now demands at step 2. `/notes` reads a file inside the sandbox.
- `web` — returns HTML and calls `api`. That is what makes "attach only the web
  and watch the api fall through to the baseline" visible.
- A build copies the sources into a directory named for the revision. That
  directory is this example's "image", and its tag is a full git sha. The
  adapter refuses a mutable tag.
- A router serves `<service>.playground.localhost:<port>` and
  `<service>--<env>.playground.localhost:<port>`, sending attached services to
  the overlay and everything else to the baseline. The port is decided at
  startup.

## Commands

```text
de-novo skills playground up      [--dir PATH]   create the sandbox, start the baseline
de-novo skills playground status  [--json]       sandbox, processes, ports, names
de-novo skills playground down                   stop everything, remove it, count what is left
```

`up` ends by printing the exact commands to run next: plant the profile,
`validate`, `urls`, `overlay verify`, and seat one worker. Copying those lines
runs the whole arc.

## Splitting the work

- **p1 — the sample app and its adapter.** `playground/app/**`,
  `playground/tools/**`. Done means `de-novo skills overlay verify` reports
  **10/10 with nothing skipped**.
- **p2 — the sandbox CLI and the isolation guards.** The implementation is
  catalog code and follows the existing convention: `infra/lib/playground.mjs`,
  the verb in `infra/bin/cli.mjs`, tests at `infra/bin/playground.test.mjs` so
  `npm test` picks them up, and `playground/README.md`. Only the sample project
  itself lives under `playground/`. Done means each of the seven
  rules above has a test, and reverting a guard turns one red.

The two meet only at the sandbox layout. p2 copies `playground/app` and
`playground/tools` into the sandbox without knowing what is in them.

## Sandbox layout (the contract between the two seats)

```text
<sandbox>/
  project/            its own git repository: the sample app plus
                      .agents/runtime-profile.yml and .agents/dryad-profile.yml
  state/              GROVE_STATE_DIR; overlays/ and dryads/ appear here
  seats/              the seats' worktrees
  run/                sandbox.json (ports, PIDs, names), processes/ receipts,
                      staging/ for the writes that become them, logs, artifacts
```

`up` writes `sandbox.json` and `status` reads it; the adapter records its own
state there too. p2 owns the format and p1 only reads it.

## Not this

- A framework, a database, a container, a cluster.
- A `runtime-profile.yml` at the catalog root.
- Reserving any machine port in advance.
- Writing anywhere outside the sandbox directory.
