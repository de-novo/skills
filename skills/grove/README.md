# Grove

A de-novo skill. Shared local ground for many projects and agents on one machine.

One soil (engines), n trees (projects), m branches (apps) per project. Grafts
(overlays) cover only the apps you changed. Developers and agents pick names,
never ports. `urls` prints those names. How you verify (browser, e2e) is out
of this skill.

```
+----------------------------------------------------------------------------+
|                         one developer machine                              |
|                                                                            |
|  n projects  x  m apps each  x  1 shared infra                             |
|  pick hostnames, never ports                                               |
|                                                                            |
|    acme                      sideapp                    ... n              |
|    api.acme.localhost        web.sideapp.localhost            |            |
|    catalog.acme.localhost    api.sideapp.localhost            |            |
|    web.acme.localhost                |                        |            |
|    api--w1.acme.localhost  (overlay) |                        |            |
|             |                        |                        |            |
|             |                        |                        |            |
|             |                        |                        |            |
|       +-----+------------------------+------------------------+----+       |
|       | names  {service}.{project}.{tld}                           |       |
|       +------------------------------------------------------------+       |
|       | de-novo skills urls prints them — Grove starts no listener |       |
|       | overlay CLI tracks leases + dispatches project commands    |       |
|       +-----+------------------------+------------------------+----+       |
|             |                        |                        |            |
|             |                        |                        |            |
|  +----------+---------+   +----------+---------+   +----------+---------+  |
|  | PROJECT  acme      |   | PROJECT  sideapp   |   | PROJECT  n         |  |
|  +--------------------+   +--------------------+   +--------------------+  |
|  | baseline (1)       |   | baseline (1)       |   | .                  |  |
|  |  [api] [catalog]   |   |  [web] [api]       |   | .                  |  |
|  |  [web] [worker]    |   |                    |   | .                  |  |
|  |           m apps   |   |           m apps   |   |                    |  |
|  | overlay w1 [api]   |   | overlay: none      |   | (more projects)    |  |
|  |                    |   |                    |   |                    |  |
|  +----------+---------+   +----------+---------+   +----------+---------+  |
|             |                        |                        |            |
|             |                        |                        |            |
|             +------------------------+------------------------+            |
|                                      |                                     |
|                                      v                                     |
|       +------------------------------+-----------------------------+       |
|       | SHARED INFRA   (CLI checkout, one set)                     |       |
|       +------------------------------------------------------------+       |
|       |                                                            |       |
|       |  +-------+   +-------+   +-------+   +-------+             |       |
|       |  | mysql |   |  pg   |   | redis |   | kafka |             |       |
|       |  | :3306 |   | :5432 |   | :6379 |   | :9092 |             |       |
|       |  +-------+   +-------+   +-------+   +-------+             |       |
|       |                                                            |       |
|       |  isolate by database / prefix, not port                    |       |
|       |    acme_      sideapp_      ..._                           |       |
|       +------------------------------------------------------------+       |
+----------------------------------------------------------------------------+
```

- One app baseline per project. Do not spin a full stack per agent.
- Overlay only the apps you changed. Unattached `{app}--{env}` hostnames fall through to that project's baseline — when the project has a listener. Grove prints the names; it does not route packets.
- One engine set on the machine. Isolate by database and prefix (`acme_` / `sideapp_`), not by port.

```
  Grove CLI checkout                 consuming project
  -----------------                  -----------------
  engine compose                     .agents/runtime-profile.yml values
  infra/addressing.yml (TLD)         .agents/runtime-profile.local.yml (clone TLD)
  urls (prints names; no listener)   app compose / k8s  (m apps)
  overlay lifecycle + lease state    overlay workloads · image builds
  profile invariants                 runtime.commands.* (project fills these)
  skill source                       verification tools
                                     chosen backend and runtime ownership
```

## What it does

Gives every project on the machine one app baseline and one shared engine
set, and gives every task a thin overlay that replaces only the services it
changed. The defining constraint: names, never ports. `urls` prints
hostnames and starts no listener; isolation is by database and prefix, not
by port; and there is no down command, because several projects live on
the same engines.

## When to reach for it

A seat or a person reaches for it to start, check, or switch a local
environment, to match a name to a service, or to verify a change against
the baseline while others do the same. Planting it on a new project is a
measured procedure, below. Browser QA and e2e runners are not here.

## It's working if

- `de-novo skills validate` counts invariants and `urls` prints names you can resolve.
- Two seats attach different overlays at once and neither waits for the other.
- A failed attach leaves a pending record you can read and retry, not a silent half-state.

## Where it fits

The ground. Dryad seats stand on it; Forester never touches it directly;
the machine backend lives in this catalog's `infra/`, not in the project.
Root map: [How the skills fit](../../README.md#how-the-skills-fit).

## What it does to your machine

| Writes | Downloads | Runs | Undo |
| --- | --- | --- | --- |
| Machine engines as Docker containers on the `dev-infra` network, only on `infra up` or `setup`; overlay envs through the project's own adapter; the overlay registry under `~/.dev-infra/overlays/` | The engine images the compose catalog names, only on `infra up` | The project's own `runtime.commands` (status, up, overlay) and Docker for the engines | `overlay destroy` per env; there is no `down` on purpose, a person stops shared engines with Docker |

## Apply to a project

Install the CLI once per machine in the catalog checkout (`npm install &&
npm link`). Then follow [references/planting.md](references/planting.md):
seven measurements before the profile is written, then `init`, `validate`,
`urls`, and the overlay contract only when overlays pay for themselves. An
unmeasured value is left out and named, never invented.

## Pointers

Schema: [references/runtime-profile.md](references/runtime-profile.md).
Overlay contract: [references/overlay-contract.md](references/overlay-contract.md).
Adapter: [references/adapter.md](references/adapter.md). Pattern: [SKILL.md](SKILL.md).
Examples: [examples/](examples/). Machine backend: [`infra/README.md`](../../infra/README.md).
