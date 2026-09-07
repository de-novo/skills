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

Start in the consuming repository: read its working rules, onboarding notes,
and runtime ownership procedure. Keep a discovery record with the source
file, observation, and date for each value. Use the
[runtime ownership procedure](SKILL.md#runtime-ownership) before an edit or
runtime action that needs ownership. Do not start a second baseline to probe it.

Measure in this order before writing the profile. If a value cannot be
measured, leave it out and say what was not measured and why. Never invent
it or copy an example's values. An omitted value can still have a default;
consult the [schema](references/runtime-profile.md) and do not treat a default
as evidence or permission. If missing evidence prevents safe operation, stop
at the incomplete profile and report what is needed.

1. **Find services.** Inspect workspace/package manifests, launch scripts,
   container or deployment definitions, and the repository's run instructions.
   Match each declared application to a running process or workload. A service
   runs independently; a library is imported or built into another application
   and has no independent runtime. Do not turn every package directory into a
   service. Record declaration paths and runtime identities, including workers
   that have no HTTP listener.
2. **Measure ports and health.** Trace each service's startup configuration to
   its live listener and any host-to-container mapping; distinguish its port
   from the proxy's port. Find a candidate health path in route definitions or
   existing probes. Make one request to that service at the observed port and
   path, read the HTTP status, and record the target and result. A failed or
   non-health response is evidence to investigate, not a path to publish as
   healthy. Confirm the request reached that service. For a service with no
   HTTP endpoint, omit the unmeasured HTTP values and record that fact.
3. **Measure reflection.** In the authorized worktree/runtime, make one small,
   reversible source edit with an observable result. Observe whether it lands
   automatically, after the project's restart procedure, or only after its
   build and deployment procedure. Record the operation that actually made
   the edit visible, then restore the edit and verify restoration. Use that
   evidence to choose `reflect` from the schema; a watcher script or image
   declaration alone does not prove reflection.
4. **Find the runtime backend.** Match the project's existing run procedure
   and manifests to what is running now. Reuse that backend and its designated
   runtime location, rather than introducing a backend to fit an example.
   Before recording a runtime command, locate its implementation and observe
   it through the project's authorized procedure. Leave unavailable commands
   out; planting does not require building a new runtime adapter.
5. **Determine engine ownership.** Trace the application's configured engine
   endpoints, without recording credentials, to the engines it actually uses
   and their operating owner. Choose `data.infra` from that evidence: catalog
   machine engines or the project's own backend. For machine engines, inspect
   `de-novo skills infra status` and match the inventory; for project engines,
   use the project's inspection procedure. Do not infer ownership just from
   an engine type or a container being present.
6. **Measure addressing.** Inspect current listening sockets and their owning
   processes, proxy routes, resolver configuration, and the project's existing
   URLs. Resolve and request those names to check the actual route. Choose the
   addressing scheme and `proxy` to match that evidence, using the schema for
   their meaning and syntax. Check other listeners before proposing any new
   binding. Printed names alone do not prove a listener exists; record absent
   or unmeasured routing instead of claiming a proxy is running.
7. **Decide whether overlays pay for themselves.** Establish whether parallel
   workers actually need independently changed services, and whether the
   project already supports isolated builds and routing. For a single service
   with no parallel work, keep `overlay: none` and stop overlay preparation;
   finish the ordinary profile checks below. Otherwise compare that need with
   the cost of a project adapter. Leave overlays off until the project can
   implement and measure the existing
   [overlay contract](references/overlay-contract.md). Do not invent an adapter
   command or enable overlays on the strength of a copied example.

With the discovery record in hand:

1. `de-novo skills init <project-root>` — writes a minimal `.agents/runtime-profile.yml`
   (`overlay: none`). Pass `--slug` `--engines` `--services` only for established
   values. Confirm the project identity in its own documentation before using
   its slug; if no identity is established, resolve that choice before init.
   Init plants no `runtime.commands`. Review the generated values against the
   record and fill only measured values using the schema above.
2. `de-novo skills validate <project-root>` — counts invariants, no docker.
   Record the count; validation does not replace the runtime measurements.
3. `de-novo skills urls <project-root>` — prints hostnames from addressing files.
   Compare them with the addressing measurements. Grove does not start a
   listener. Make the service requests through existing routes and report how
   many answered out of how many checked, separately from printed names.
4. Machine preparation is a separate authorized operation, not a routine
   inspection step. Read the **Project onboarding** section in the linked
   CLI checkout's `infra/README.md` for setup effects and execution conditions.
   In the source catalog it is [here](../../infra/README.md#project-onboarding).
   Resolve this against the CLI checkout, not an installed skill directory.
5. Only after deciding to enable overlays and measuring the adapter against
   its contract, use `de-novo skills overlay status`, then `create` / `attach`;
   use `touch` for long work and `destroy` at task end. `prune` lists stale
   leases and destroys them only with `--apply`. Follow the linked overlay
   contract for execution and evidence, rather than treating exit zero as proof.
6. Make the skill loadable: in the project, keep one canonical copy under
   `.agents/skills/grove` and put only symlinks in tool-specific dirs
   (`.claude/skills/`, `.cursor/skills/`, …). For a user-wide install, symlink
   from `~/.claude/skills/grove` to the catalog checkout. Never copy the body;
   a copy stops receiving contract updates.

Ongoing operating pattern: [SKILL.md](SKILL.md).

Examples: [examples/](examples/). They show the shape of values, not a required backend.

Contributing to this skill's source: [root AGENTS.md](../../AGENTS.md).
