# Grove

A de-novo skill. Shared local ground for many projects and agents on one machine.

One soil (engines), n trees (projects), m branches (apps) per project. Grafts
(overlays) cover only the apps you changed. Developers and agents pick names,
never ports. `urls` prints those names. How you verify (browser, e2e) is out
of this skill.

Pattern: [SKILL.md](SKILL.md). Schema: [references/runtime-profile.md](references/runtime-profile.md).
Optional machine backend: `de-novo skills infra` — compose sits next to that
CLI (Grove catalog checkout), not in the consuming project. Project values (domains, ports,
service lists) live in each project's `.agents/runtime-profile.yml`.

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

## Apply to a project

CLI install: `npm install && npm link` **in the Grove catalog checkout**,
once per machine — not in the consuming app. The app gets a profile, not an
`infra/` directory. Catalog layout: [root README](../../README.md).

1. `de-novo skills init <project-root>` — writes a minimal `.agents/runtime-profile.yml`
   (`overlay: none`). Pass `--slug` `--engines` `--services` for values.
   Init plants no `runtime.commands`.
2. `de-novo skills validate <project-root>` — counts invariants, no docker.
3. `de-novo skills urls <project-root>` — prints hostnames from addressing files.
   Grove does not start a listener.
4. Choose `data.infra` according to the project's existing backend. For
   `machine`, inspect `de-novo skills infra status`. For `project`, use the
   project's operating procedure; catalog setup does not apply.
5. Machine preparation is a separate authorized operation, not a routine
   inspection step. Read the **Project onboarding** section in the linked
   CLI checkout's `infra/README.md` for setup effects and execution conditions.
   In the source catalog it is [here](../../infra/README.md#project-onboarding).
   Resolve this against the CLI checkout, not an installed skill directory.
6. For an overlay-enabled profile, use `de-novo skills overlay status`, then
   `create` / `attach`; use `touch` for long work and `destroy` at task end.
   `prune` lists stale leases and destroys them only with `--apply`. Contract:
   [references/overlay-contract.md](references/overlay-contract.md). Writing
   the project's own `runtime.commands.overlay` and checking it with
   `de-novo skills overlay verify`:
   [references/adapter.md](references/adapter.md).
7. Make the skill loadable: in the project, keep one canonical copy under
   `.agents/skills/grove` and put only symlinks in tool-specific dirs
   (`.claude/skills/`, `.cursor/skills/`, …). For a user-wide install, symlink
   from `~/.claude/skills/grove` to the catalog checkout. Never copy the body;
   a copy stops receiving contract updates.

Agent procedure (what exists after init, what not to invent): [SKILL.md](SKILL.md).

Examples: [examples/](examples/). They show the shape of values, not a required backend.

Contributing to this skill's source: [root AGENTS.md](../../AGENTS.md).
