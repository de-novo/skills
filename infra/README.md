# Machine-shared infra

Databases, caches, and brokers shared by projects choosing this machine backend.
Projects choosing this backend use its existing engines. Other backends follow
their own ownership procedure.

One rule: **one engine on the machine, isolate inside it.** Because there is
only one, ports stay standard — default tool config just works. Isolation is
an engine-internal unit, not a port:

| Engine   | Isolation unit                       | How to create                       |
| -------- | ------------------------------------ | ----------------------------------- |
| MySQL    | database + dedicated account         | `de-novo skills infra provision mysql <slug>` |
| Postgres | database + dedicated role            | `de-novo skills infra provision pg <slug>` |
| Redis    | key prefix `<slug>:` (default)       | convention — set the prefix in app config |
| Kafka    | topic and consumer-group prefix `<slug>.` | convention                     |
| Mongo    | database                             | created on first connect            |
| MinIO    | bucket `<slug>-*`                    | console or mc                       |

The shared name for those units is the project **namespace** — one
`project.namespace` (default = slug) produces database, prefix, and bucket
names, and k8s-using projects reuse it for the app-layer namespace. Engine
character rules (`-` / `_`) are rewritten by the setup tool.

The project boundary is GRANT: an account may only touch its own database.
root/postgres accounts are for provisioning, not app connections.

Hostnames are not ports. This checkout's TLD and scheme live in
[`addressing.yml`](addressing.yml). A clone-specific domain is
`addressing.local.yml` (gitignored). Consuming projects inherit that tld when
their profile omits `addressing.tld`. `de-novo skills urls` prints the names.

The engine catalog is this compose file. Engine id is the compose profile.
`grove.provision` / `grove.aliases` labels teach the CLI; do not add a second
list. A project starts only `data.engines`. `up` with no names starts nothing.

## Start

These mutation commands require machine-owner authorization for the named
engines and project. Authorization already given for that scope remains valid.
Read-only status does not authorize setup, provisioning, or an engine restart.

The CLI (`npm install && npm link`, then `de-novo`) is the front;
compose is the floor:

```bash
de-novo skills infra status        # catalog, tld, ready n/n
de-novo skills infra up mysql pg   # those compose engines
de-novo skills setup <project>     # project's isolation units on this set
# every engine is a profile. bare `docker compose up` starts none.
```

`restart: unless-stopped`, so when the Docker engine (OrbStack / Docker
Desktop) comes up at login, infra follows. "Start it every time" ends here.

Success is the counted healthy catalog, not exit code alone:

```bash
de-novo skills infra status        # ready n/n; every engine has a healthcheck
```

## Engines

All on 127.0.0.1, standard ports. Credentials are local-dev only.

| Engine      | Container   | Connect                     | Profile |
| ----------- | ----------- | --------------------------- | ------- |
| MySQL 8.4   | dev-mysql8  | localhost:3306 (root/root)  | mysql   |
| Postgres 16 | dev-pg16    | localhost:5432 (postgres/…) | pg      |
| Redis 7     | dev-redis7  | localhost:6379              | redis   |
| Kafka 3.9   | dev-kafka   | localhost:9092              | kafka   |
| Mongo 7     | dev-mongo7  | localhost:27017             | mongo   |
| Mailpit     | dev-mailpit | SMTP 1025 · UI 8025         | mail    |
| MinIO       | dev-minio   | 9000 · console 9001         | minio   |

From a container in a project compose, use `host.docker.internal:<port>`, or
join the external network `dev-infra` and the container name (kafka:
`dev-kafka:19092`).

k3d / Kubernetes on the same Docker engine: engines bind `127.0.0.1`, so
`host.k3d.internal:<port>` does **not** connect (measured: MySQL 2003/111).

Two cluster names — do not mix them. `runtime.profiles.*.cluster` is the
project's **app** cluster (often the existing `local` that already owns
`:80`). `infra k3d connect --cluster NAME` is the **engine-link**. `--cluster`
is required and never defaults to `local`. `--cluster local` warns, then
continues only because a human passed it.

Create a **separate** engine-link cluster on `dev-infra`, not the machine's
existing one that already owns `:80`:

```bash
k3d cluster create grove-qa \
  --network dev-infra \
  --api-port 127.0.0.1:6550 \
  --port '127.0.0.1:9080:80@loadbalancer' \
  --kubeconfig-update-default=false
```

Then link engines (idempotent). Requires `--cluster`; will not pick `local`:

```bash
de-novo skills infra k3d connect --cluster grove-qa
# apps: mysql.grove-infra:3306  pg.grove-infra:5432
de-novo skills infra k3d status --cluster grove-qa
# resources n/n; stale or missing Service/EndpointSlice makes status non-zero
```

`addressing.proxy: project`. Do not publish engine ports on `0.0.0.0`.

Need a new major version? Run it beside the existing service (that is when a
non-standard port appears) — other projects still live on the old version.

## Project onboarding

Which engines a project uses is its `.agents/runtime-profile.yml`
(`data.engines`). Setup reads that yaml only when `data.infra: machine`.

Before executing, identify the project namespace, declared engines/databases,
and credential source; obtain machine-owner authorization for those targets.
Routine app work and a successful `validate` do not grant this authority.

`setup` executes Compose `up -d --wait` for every declared engine, including
engines already running. Compose may reconcile changed configuration. It then
provisions each declared SQL database and account, setting existing account
passwords from `GROVE_PROVISION_PASSWORD` or the local-development default and
reapplying grants. Repeated execution with different credentials can break
existing app connections. Coordinate credential changes and app configuration
with the owner; do not use setup as a status check. It has no dry-run mode.

The owner-approved execution is:

```bash
de-novo skills setup <project-root>   # reconcile declared engines + provision DBs and account credentials
```

`de-novo skills infra provision (mysql|pg) <name>` is the low-level tool setup
uses — call it directly only when you need one DB in a hurry without a
profile. It prints a counted receipt without credentials. To override the
local-development credential, pass it through `GROVE_PROVISION_PASSWORD`;
positional password arguments are rejected so they do not enter shell history
or process arguments.

Database and account names come from the consuming project's
`project.namespace` and `data.engines`; several per project use
`<namespace>_<purpose>`. Do not copy that declaration into a second registry.

## Overlay lifecycle

Grove does not implement project workloads, but it owns their lifecycle gate
and lease registry. An overlay-enabled project declares
`runtime.commands.overlay`; operate it only through the CLI:

```bash
de-novo skills overlay status --project <project-root>          # add --json for tools
de-novo skills overlay touch <env> --project <project-root>
de-novo skills overlay prune --project <project-root>           # plan
de-novo skills overlay prune --project <project-root> --apply   # destroy stale leases
```

The project chooses `overlay.stale_after`, or the operator supplies
`--stale-after`. There is no default retention period and no implicit deletion.
Failed destroys remain tracked and make the counted cleanup non-zero. Runtime
environments absent from the registry are reported as drift and require an
explicit `destroy`; Grove does not invent their age. Full contract:
[`overlay-contract.md`](../skills/grove/references/overlay-contract.md).

## Rules (not weakenable)

- **Projects do not re-declare these engines in their own compose.** Two
  instances and "which DB am I looking at?" has no answer.
- **Neither projects nor agents stop or restart machine infra.** Other
  projects are running on it. A human decides if something is wrong.
- **Do not attach to another project's database or prefix.**
- Do not put real data or real secrets here.
- Data lives on named volumes. `docker compose down -v` wipes **every
  project's local data** — if you must delete, delete one volume.

## Migrating an existing project

Projects that still own infra inside their compose/k8s stack migrate
gradually. If the old stack used non-standard ports, it can run next to
machine infra (standard ports) without colliding. Steps: (1) `provision` a
database (2) point app config at machine infra (3) migrate data (4) remove
infra services from the project stack. While both exist, "which one am I
looking at?" is the app config — do not guess. Record the ownership value in
that project's `.agents/runtime-profile.yml`.
