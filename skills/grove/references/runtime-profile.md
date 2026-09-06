# runtime-profile.yml — values the project owns

`.agents/runtime-profile.yml` at the project root. The skill states the
pattern; this file states this project's values. **Do not copy the skill
body here** — keep values, paths, and commands only. Allowed top-level keys:
`version` `project` `addressing` `runtime` `services` `overlay` `data`.
Unknown keys such as `qa` are rejected by `de-novo skills validate`.

## Full schema (comments are the spec)

```yaml
version: 1                      # omitted = 1; any other explicit version is rejected

project:
  slug: myproject               # identifier for hostnames and the machine registry
  # namespace: myproject_dev    # shared name for all isolation units. default = slug
  # host: myproject             # DNS label. default = slug with _ → -

addressing:
  # tld omitted — inherit this Grove checkout's infra/addressing.yml
  # (infra/addressing.local.yml overrides, gitignored). Pin a domain in
  # this project repo with tld: local.example.com, or
  # .agents/runtime-profile.local.yml for one clone. Not ~/.dev-infra.
  # tld: local.example.com
  # proxy: none                 # omitted = none. none|machine|project|portless
                                # machine is intent — Grove does not start a listener
  scheme:
    shared: "{service}.{project}.{tld}"     # web.acme.local.example.com
    overlay: "{service}--{env}.{project}.{tld}"
    # exclusive project domain (OAuth already bound): "{service}.{tld}"
    # shared requires {service} + {tld}; overlay also requires {env}.
    # Templates and final rendered hostnames must be valid DNS names.
  ports:
    blocks: { api: 5000, web: 5100 }
    registry: README.md         # where the port registry lives. if this file disagrees, that file wins

runtime:
  default: developer
  single_stack: true            # invariant — cannot be false
  writers: 1                    # invariant — cannot grow
  profiles:
    planner:                    # light checks / planning
      backend: docker-compose
      compose_file: docker-compose.yml
    developer:                  # development that needs overlay. omit if unused
      backend: k3d
      cluster: local            # this project's app cluster. not the Grove
                                # `infra k3d connect --cluster` default
  commands:                     # optional. init plants none. run only if present
    profile: node tools/dev-environment.mjs profile
    status: node tools/dev-environment.mjs status
    up: node tools/dev-environment.mjs up --apply
    overlay: node tools/dev-overlay.mjs   # omit when overlay: none

services:
  my-api:
    kind: api
    port: 5001
    health: /api/health         # write a measured path. guessing yields 404
    reflect: rebuild            # source | rebuild | restart
  my-web:
    kind: web
    port: 5101
    health: /
    reflect: source
  auth-api:
    kind: api
    port: 5002
    health: /health
    reflect: rebuild

overlay:                        # single-service projects: `overlay: none`
  attachable: [my-web, my-api]
  shared_only: [auth-api]       # auth, schedulers, consumers — never attach
  image_tag: full-git-sha
  plan_first: true              # omitted = true
  # stale_after: 1d             # optional; no default. s|m|h|d|w

data:
  infra: machine                # machine (omitted default) | project (project-chosen backend)
  engines:                      # machine: engines and isolation units on shared infra
    mysql: [myproject]          #   databases created by `de-novo skills setup`
    redis: { prefix: "myproject:" }
  migrate: pnpm run db:migrate:local
  fixtures: [ui, official-api, fixture-endpoint, seed-script]
  forbid_direct_db_writes: true # invariant
```

## Validation boundary

Unknown keys are rejected in project, runtime, commands, services, addressing,
ports, data, and overlay maps. Runtime profile entries preserve backend-specific
options; only the documented string fields are checked there. Backend tools
validate those additional options.

Present commands must be non-empty strings. `runtime.default` must name a
profile. Service ports and block bases must be integers from 1 to 65535; a
health path starts with a single slash and contains no whitespace; reflection
is `source`, `rebuild`, or `restart`. These checks do not execute the command,
resolve file paths, reserve ports, or measure that a health path responds.
Omitted optional fields remain valid for a newly initialized profile.

Runtime writer discovery and authorization are the operating procedure in
[SKILL.md](../SKILL.md#runtime-ownership). The profile's writer count is a
constraint on declarations, not runtime enforcement.

## How to pick values

### addressing.proxy

**Declared intent** for who would listen on this project's hostnames.
Grove does not start a listener. `de-novo skills urls` prints the names.
Compose has no Caddy; the CLI has no `proxy up`.

| Value | Meaning |
| --- | --- |
| `none` (omit default) | Print URLs only |
| `machine` | Intent: a machine listener would own these names. Not built. `urls` still prints |
| `project` | The project (k3d Gateway, etc.) listens |
| `portless` | Host process wrapper. Not machine fallthrough |

Projects whose k3d already binds `:80` must set `project` **explicitly**. If
the default were `machine`, a future listener would steal that port.

### addressing.tld — one namespace for many domains

TLD is a **repo file**, not a home-directory setting. Precedence:

1. `.agents/runtime-profile.local.yml` `addressing.tld` (this clone, gitignored)
2. this profile `addressing.tld` (committed in the project)
3. Grove checkout `infra/addressing.local.yml` (gitignored)
4. Grove checkout `infra/addressing.yml` (default `localhost`)

Default scheme is `{service}.{project}.{tld}`. With `tld: local.example.com`:

```
web.acme.local.example.com          *.*.local.example.com
web--w1.acme.local.example.com      overlay: still two labels (-- stays one label)
```

Do not write `*.local.example.com` as the tld value — wildcards belong to DNS,
not the yaml. A public record `*.local.example.com` covers **one** extra label
(`acme.local.example.com`), not `web.acme.local.example.com`. For two labels
use `*.acme.local.example.com` per project, or a resolver that matches the
whole subtree (dnsmasq `address=/local.example.com/127.0.0.1`). Let's Encrypt
wildcards are one label too.

| Method | Resolves | When |
| --- | --- | --- |
| `localhost` (Grove default) | OS `*.localhost` → loopback, any depth | Personal machine, no external callbacks |
| Owned `local.example.com` | You point DNS at 127.0.0.1 at the right depth | OAuth, phones, a domain you already own |
| dnsmasq custom TLD | `/etc/resolver/` + dnsmasq subtree | No real domain and localhost fails in a tool |

One TLD for the machine's projects. A new TLD per project multiplies certs
and trust. Exclusive `tld` in a project profile is for a domain that project
already monopolizes (OAuth allowlist).

### runtime.profiles — how to pick a tier

```
1–2 services, no parallel agents   → planner (compose) only. omit developer
multi-service, parallel agents     → add developer. backend:
  ships to k8s                     → k3d (reuse manifests)
  otherwise                        → compose is enough; Grove prints names
```

`runtime.profiles.*.cluster` is the project's **app** cluster (where k8s apps
run). Independent of `de-novo skills infra k3d connect --cluster NAME`, which
never defaults to `local`. Create flags live in the CLI checkout's
`infra/README.md`, not in the consuming project.

The moment you add developer(k3d) you owe a SHA image-build pipeline. Decide
if the project will pay that cost.

### overlay lifecycle

`runtime.commands.overlay` must implement the Grove command/JSON contract:
[overlay-contract.md](overlay-contract.md). That file owns how the command is
invoked, what `--apply` and `plan_first` do, and how `stale_after` leases are
measured and cleaned. This file only fixes value syntax: `stale_after` is an
optional positive duration (`s` `m` `h` `d` `w`) with no default; `plan_first`
omitted is `true`; `image_tag` omitted is `full-git-sha` and no mutable tag mode
is supported.

### ports.blocks

These are **app** ports — infra engines are machine-shared (Grove CLI
`infra/`, standard ports) and do not belong in the project port plan. Layer blocks
(api/web) are convention; values are free. When several projects bind fixed
ports on one machine, assign non-overlapping 100-wide blocks. Hostnames are
the public surface; ports stay in the registry.

### data.infra

Default is `machine`: engines come from the Grove CLI's shared infra; the
project declares only its databases and prefixes. Choose `project` when an
existing or new project uses another backend and its own operating procedure.
It is a supported ownership choice, not a mandatory migration stage. Catalog
`setup` applies only to `machine`; `validate`, `urls`, and overlay contracts
remain available for either choice.

### project.namespace — shared name for isolation units

Every name that isolates this project on machine infra comes from here:
database (`<ns>`), redis key prefix (`<ns>:`), kafka topic/group prefix
(`<ns>.`), minio bucket, and if developer(k3d) is used, the app-layer k8s
namespace. Per-engine declarations override this default only when needed.

Engines have different character rules; the setup tool rewrites them:
database `-`→`_`, bucket/k8s `_`→`-`. To skip rewriting, start with
`[a-z][a-z0-9]*` so the name is identical everywhere.

### data.engines — the declaration is the setup input

For `data.infra: machine`, `de-novo skills setup <project-root>` reads these
declarations. Setup reconciles the declared engines and provisions SQL accounts,
including existing credentials. Authorization and rerun effects are defined in
the linked CLI checkout's `infra/README.md`, **Project onboarding** section.
Declaring engines does not authorize setup. Value shapes:

| Engine                     | Value                                     | What setup does              |
| -------------------------- | ----------------------------------------- | ---------------------------- |
| `mysql` / `pg` (postgres)  | `true` (= namespace) or `[db-name, …]`         | create database + dedicated account |
| `redis`                    | `true` or `{ prefix: "slug:" }`           | start only — prefix is an app convention |
| `kafka`                    | `true` or `{ topic_prefix: "slug." }`     | start only — prefix is an app convention |
| `mongo`                    | `true` or `[db-name, …]`                  | start only — DB created on first connect |
| `mail` / `minio`           | `true` (minio may use `{ bucket }`)       | start only                   |

Unknown engine names are rejected — they must exist as a compose profile in
the Grove CLI's `infra/docker-compose.yml` (the catalog checkout you
linked), not in the consuming project. Add the service there, then declare
it in the project. `setup` starts only `data.engines`. There is no second
enabled-engine list to maintain. `false`, scalar service declarations,
unknown engine-specific keys, and duplicate canonical/alias declarations are
errors rather than implicit defaults.

### services.*.health / reflect

**Measure, then write.** Health is a path that actually returned 200. Reflect
is how an edit lands, confirmed by making one change. A measured date in a
comment lets the next person doubt staleness.

## Verify

After writing or editing a profile:

1. `de-novo skills validate` counts configuration invariants. It does not
   acquire runtime ownership, run commands, probe health, or verify routing.
   After init there is no `commands.status` — do not invent it.
2. `de-novo skills urls` prints at least one hostname. Routing is the
   project's listener, not Grove.
3. When `runtime.commands.status` exists, run that project command yourself
   from the designated runtime location and match its output to the service
   list. `de-novo skills status` is the machine engine report, not this step.
   Request every health path and get the expected response (checking 0 of 0
   is not a check — count how many of how many answered).
4. The port registry (`ports.registry`) agrees with this file.
