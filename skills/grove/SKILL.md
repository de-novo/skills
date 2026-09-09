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

Shared local ground for many projects and agents on one machine. Keep one
standing app baseline per project and share engines through the backend the
project chose. Add thin overlays only when parallel work needs them.

This file owns the operating pattern. Project values and executable commands
belong in `.agents/runtime-profile.yml`. Read it before acting; do not invent
missing commands. Schema: [runtime-profile.md](references/runtime-profile.md).
Human diagram and CLI onboarding: [README.md](README.md).

## Plant it

For a repository without a profile, follow
[Apply to a project](references/planting.md#apply-to-a-project): measure the existing
project before writing its values. That procedure owns the planting steps.

## First actions

Run these in order before changing anything. Each one counts what it saw.

1. `de-novo skills validate <project-root>` — configuration invariants only.
   It does not acquire ownership, probe health, or verify routing.
2. `de-novo skills urls <project-root>` — the names this project uses. Grove
   prints them; the project's listener routes them.
3. If `runtime.commands.status` exists, run that project command from the
   designated runtime location. `de-novo skills status` is the machine engine
   report, not the project's status.
4. If `runtime.commands.overlay` exists, `de-novo skills overlay status`.

Machine engines (`/grove infra`): `de-novo skills infra status` reads. `infra
up`, `infra provision`, `setup`, and `infra k3d connect` mutate the shared
engine set and need the machine owner's authorization. Their effects and
execution conditions live in the CLI checkout's `infra/README.md`, not here.
There is no down command.

## Addressing and isolation

Use the profile's names and port registry. Named URLs do not prove DNS,
listener, routing, or application readiness. Grove prints names; the project's
chosen listener routes them. A proxy declaration is intent, not a process.

Share engines and isolate each project's data with its namespace and permitted
accounts or prefixes. The catalog's machine backend is optional. When chosen,
use its existing engine set; do not duplicate it inside the consuming project.
Other backends retain their own documented ownership and operating procedure.

## Runtime ownership

Many readers, one runtime writer. A profile declaring one writer is a policy,
not a lock. Before any baseline mutation:

1. Read the project's runtime status and operating documentation to identify
   the current writer, designated runtime location, and ownership mechanism.
2. Use that mechanism to obtain ownership, or send the need to the current
   owner through an already authorized channel. If ownership cannot be
   established, report the missing information and stop before mutation.
3. Execute only configured commands from the designated runtime location.
   Never start a competing baseline from an agent worktree. Verify the change,
   then release or hand back ownership through the same project mechanism.

Command presence is capability, not authorization. Existing task authorization
remains valid for its stated target and scope; do not ask for it again.
Shared engine starts, restarts, provisioning, and migrations require the
machine owner's authorization. Routine inspection or app work does not grant
it. Data creation must use the profile's permitted fixture paths, with a
before/after probe; never write directly to shared databases.

When profiles compete for fixed resources, switch through the owner. Do not
stop machine infrastructure to switch an app profile.

## Overlay work

Leave overlays off unless the profile enables them and supplies its overlay
command. Attach only changed services permitted by the profile; shared-only
services always remain on baseline. The project owns image builds, workloads,
and fallthrough routing. Use exact revisions and verify runtime identity.

Operate through `de-novo skills overlay`, never the project overlay command.
Why, and every lifecycle rule (plans, application, readiness, pending-operation
recovery, leases, cleanup, concurrency) have one authority:
[overlay-contract.md](references/overlay-contract.md). Writing that project
command, and checking it with `de-novo skills overlay verify`:
[adapter.md](references/adapter.md).

Renew the lease during long work. Detach unused overrides and destroy the
environment when the task ends. Stale cleanup is an explicit backstop, not the
normal completion path. Overlay locks do not establish baseline writer
ownership.

## Verification

Use each service's measured reflection mode to determine how an edit lands.
Check the affected runtime before claiming the change is visible. Count the
artifacts actually observed and distinguish configuration validation, runtime
identity, readiness, and routing. Report an unmeasured boundary as such.

Keep browser QA and e2e procedures in the consuming project's verification
tools. They are outside this skill's ownership.
