---
name: grove
description: >-
  de-novo Grove — shared local ground on one machine. n projects, m apps each,
  one infra set. Names instead of ports; thin overlays instead of cloned stacks.
  Use when starting, checking, or switching a local environment; when matching
  ports; when several agents work and verify on the same machine at once; when
  planting Grove on a new project; when managing machine-shared engines
  (de-novo skills infra); when the user runs /grove or /grove infra. Project
  values live in .agents/runtime-profile.yml. Browser QA and e2e runners are
  out of scope.
---

# Grove

A de-novo skill. Shared local ground for many projects and agents on one machine.
One soil (engines), n trees (projects), m branches (apps) per project. Grafts
(overlays) cover only the apps you changed. Human diagram and apply steps:
[README.md](README.md).

On one machine, several people and agents break the environment in two ways:

- **Ports.** Each project and each agent starts a stack and fights over well-known
  ports. CORS and redirects break. Nobody can answer which port that app is on.
- **Parallel verification.** Several agents each want to open *their* change.
  Cloning a full stack explodes ports. Sharing one stack overwrites deploys.

This skill runs local infra in one place so those two stop happening. It does
not prescribe how you verify — it gives named addresses (`urls`) and one
engine set. It does not start a hostname listener.

**This file is the pattern only.** Domains, ports, service lists, backends, and
real commands live in the project's `.agents/runtime-profile.yml`. Read it
before you work. If there is no profile, first run
`de-novo skills init <project-root>`. Schema:
[runtime-profile.md](references/runtime-profile.md). Implementation details
belong to the backend the profile chose — this skill does not pick a backend.

`m` is the number of keys in profile `services`. The project is `project.slug`.

## Operating model — four pillars

### 1. One long-lived shared baseline

Sharing has two layers.

- **Infra engines (DB, cache, broker) are one set, Grove-central.** Projects
  do not own them and do not put them in project compose. Operate them with
  `de-novo skills infra`. The catalog is the compose file **next to that
  CLI** (the Grove catalog checkout you linked), not a file in the consuming
  project. Do not create `infra/docker-compose.yml` in the app repo.
  Isolate inside the engine (database, account, prefix), not by port. The
  shared name for those units is the project **namespace**
  (profile `project.namespace`, default = slug).
- **One app baseline per project.** Do not run a full stack per agent. The m
  apps live on that one set.

How it runs is `runtime.profiles`. If two profiles own the same fixed ports,
**do not run them at once.** Switch explicitly.

### 2. Thin per-agent overlay

Parallel verification is an overlay, not a cloned stack. Attach **only the
apps you changed**; the rest fall through to baseline. Do not add ports —
split by address. Grove CLI gates and records the lifecycle, then dispatches
`runtime.commands.overlay`; the project still owns workloads and fallthrough.

- Attachable apps are `overlay.attachable`. Never attach `overlay.shared_only`.
- Overlay images are tagged with a full git SHA. There is no "latest".
- Detach as soon as the override is unused, and destroy the env when the unit
  of work ends. Overlay lifetime is the task. A stale lease is only a backstop.
- Applied mutations are complete only after project `status` reports the
  matching runtime postcondition. A success receipt alone is not completion.
- Run overlay verbs only when `runtime.commands.overlay` exists. If the
  command is missing or `overlay: none`, do not apply this pillar.

### 3. Hostname fallthrough routing

Do not make people pick ports. Addresses are names. One wildcard local domain
on the machine; `addressing.scheme` sets the name rules.

```
shared  : {service}.{project}.{tld}           baseline
overlay : {service}--{env}.{project}.{tld}    overlay if attached, else fall through
```

`tld` is a repo file (Grove CLI checkout `infra/addressing.yml`, or the
project's profile / `.local.yml`). `tld: local.example.com` →
`web.acme.local.example.com`.
Grove prints those names (`de-novo skills urls`). It does not start a
listener. `addressing.proxy` is declared intent, not a running process —
values: [runtime-profile.md](references/runtime-profile.md).

### 4. Single writer for runtime

Many readers, one writer (`runtime.writers: 1`).

- **Do not start services from a worktree.** Runtime ownership sits in the
  designated runtime environment.
- Agents do not start, stop, or restart shared infra, do not run shared
  migrations, and do not write the shared DB directly. Declare the need to
  the owner.
- When you need data, create it only on paths `data.fixtures` allows, and
  leave a before/after probe.

## Procedure

Values come from the profile. Do not invent a missing command. After `init`,
the planted profile has no `runtime.commands` — use Grove CLI until the
project fills those keys.

1. No profile → `de-novo skills init <project-root>` (`overlay: none`).
2. `de-novo skills validate <project-root>` — count invariants, no docker.
3. `de-novo skills urls <project-root>` — print names. Grove does not start
   a listener. `addressing.proxy: machine` is intent, not a running Caddy.
4. `de-novo skills infra status` — catalog + tld + ready n/n.
5. When `data.infra: machine`: `de-novo skills setup <project-root>` —
   start declared engines that are down and provision isolation units.

Run `runtime.commands.status` / `up` only when those keys exist. Never invoke
`runtime.commands.overlay` directly; use `de-novo skills overlay` so the lease
registry stays complete. If commands are missing, stop at the steps above. Do
not stop machine infra to switch a profile. There is no down command.

### Machine infra is Grove-central

Do not start MySQL, Postgres, Redis, or other engines from a project. Grove
owns the machine set.

```
de-novo skills infra status              catalog + tld + ready n/n
de-novo skills infra up mysql pg         start those compose engines
de-novo skills infra provision mysql <slug>
```

Catalog and TLD live next to the CLI, not in the consuming project. Engine
id is the compose profile. There is no second engine-name list. `infra
status` first — "it is probably up" is not a measurement.

Every catalog engine has an explicit healthcheck. A merely running container
is not ready; `infra status` and `setup` count only healthy containers.

A new engine is a compose service with one profile **in that CLI checkout**,
then `infra up <name>`. Do not invent a command. There is no down command.

### k3d — two cluster names

Do not mix them. Create flags live in the CLI checkout's `infra/README.md`,
not in the consuming project. Do not follow a relative `infra/` path from
this skill copy.

- **App cluster** is `runtime.profiles.*.cluster` — where this project's k8s
  apps run. Often the machine's existing `local` that already owns `:80`.
- **Engine-link cluster** is `--cluster NAME` on
  `de-novo skills infra k3d connect`. Required. Never defaults to `local`.
  `--cluster local` warns, then continues only because a human passed it.
  `infra k3d status` also compares the managed Service and EndpointSlice IPs
  and ports; missing, stale, or unexpected resources are a failed status.

Do not use `host.k3d.internal` — it does not reach `127.0.0.1` engine ports.
k3d projects set `addressing.proxy: project`.

### Project isolation is the profile yaml

Declared engines in `data.engines` are **isolation units** on that central
set (databases, prefixes), not a private stack. `de-novo skills setup
<project-root>` (when `data.infra: machine`) starts any declared engines that
are down and provisions units idempotently. Counted summary: engines n/n,
DBs n/n.

### Overlay lifecycle

Run overlay verbs only when `runtime.commands.overlay` exists. If that command
is missing or `overlay: none`, stop here. Full command and JSON receipt
contract: [overlay-contract.md](references/overlay-contract.md).

```
de-novo skills overlay status
de-novo skills overlay create <env> --apply
de-novo skills overlay attach <env> <service> --image <full-sha> --apply
de-novo skills overlay touch <env>
de-novo skills overlay detach <env> <service> --apply
de-novo skills overlay destroy <env> --apply
de-novo skills overlay prune                 # plan only
de-novo skills overlay prune --apply         # explicit stale cleanup
```

Workload mutations without `--apply` are plans; `touch` only renews the lease.
`status` is non-zero for stale leases or measured registry/runtime drift. Long
work renews its lease with `touch`; normal completion still uses `destroy`.
`prune` requires an explicit stale policy from the profile or `--stale-after`
and never guesses one. Grove journals an applied mutation before dispatch and
clears it only after `status` observes the result. If `status` reports a pending
operation, rerun that same `--apply` command to recover it before doing other
mutations.

`urls --env <env>` prints the overlay names. Whether they route is the
project's listener, not this CLI.

### Check how changes land before you say "nothing changed"

How a change shows up is `services.*.reflect`:

```
source    edit is live immediately
rebuild   rebuild and restart before it shows
restart   restart only
```

The usual cause of "I don't see my edit" is changing a rebuild app and
hitting the same address again.

## Setting up a new project

1. `de-novo skills init <project-root>` plants a minimal profile
   (`overlay: none`). `--slug` `--engines` `--services` can fill values.
   Init does not plant `runtime.commands`. Then edit app list (m), backend
   tier, address scheme, and data policy in the profile. Schema:
   [runtime-profile.md](references/runtime-profile.md). Examples:
   [examples/](examples/) — shape of values, not a required backend.
2. **Do not over-tier.** If there are few apps and no parallel agents, apply
   addressing and ownership only and leave overlay off (`overlay: none`).
   Overlay pays off when m is large and several agents verify the same
   project at once.
3. Keep the port registry in the file the profile points at, and declare it
   as source of truth. Ports outside the registry die first in CORS and auth.

## Invariants — not weakenable

The profile may change values. These are not values; the profile cannot
weaken them.

- One standing stack per project (`single_stack`)
- One runtime writer (`writers: 1`)
- No starting services from a worktree
- No direct writes to the shared DB; create data only via fixture paths
- Overlay images tagged with an exact revision
- Success of start/install is artifacts existing, not exit code 0

## Later — other machines

Not this skill's procedure. Goal only:
[later.md](references/later.md) (Tailscale or Headscale, one writer, laptop
is a client). Do not implement it when operating Grove today.
