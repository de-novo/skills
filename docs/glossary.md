# Glossary

Canonical names for this catalog.

## Names

| Name | Meaning |
| --- | --- |
| Ground | Shared local base and thin overlays |
| Seat | One agent seat: worktree, overlay env, journal. Does not launch an agent |
| Plan | The plan, its dependencies, the budget, and `serve` |
| Facts | Assertion source of truth, kept apart from Plan |
| Cluster seat | A seat at cluster scale, on the k3s/k3d backend |
| Egress | What may leave the seat |

## What the names mean

- **Ground.** The shared local base: one engine set for the machine, names rather than ports, and a thin overlay for the services a task changed. The other pieces stand on it. The `ground` skill is `.agents/runtime-profile.yml`, `validate`, `urls`, `overlay`, and the machine engines under `infra/`.
- **Seat.** The place one worker sits: a worktree, an overlay env when the project has one, and a journal. Preparing that place is the whole job. Seat does not launch an agent. A person picks the launcher. The CLI is `de-novo skills seat`.
- **Plan.** The work itself: items, dependencies, file claims, how many may run at once, and `serve`, which holds each seated item's real session. The CLI is `de-novo skills plan`. The verb that prints the graph is also `plan`: `de-novo skills plan plan`.
- **Facts.** What the project holds true, with time, confidence, domain, and source. It is a second graph. It is not the plan and it does not assign work. Workers propose; a judge commits. The only seam to Plan is read-only (`propose --from-seat`).
- **Cluster seat.** The same idea as a seat, at a larger scale, on the k3s/k3d backend. The local seat is a worktree on this machine. A cluster seat is work running on a cluster. Two cluster names stay distinct. `runtime.profiles.*.cluster` is the project's app cluster. `de-novo skills infra k3d connect --cluster NAME` is the engine-link, and it never defaults to `local`. Details stay in [`infra/README.md`](../infra/README.md).
- **Egress.** What is allowed to leave a seat. Use the word when a document has to say that. This catalog does not ship a network allowlist, so there is no egress command. An OAuth allowlist on a domain, and a launcher's allow list of shell commands, are different things and keep their own words.

## Where the names live

| Surface | Name |
| --- | --- |
| CLI | `seat`, `plan`, `facts`. Ground's machine commands are `infra`, `validate`, `urls`, `overlay`, and `setup`. `infra k3d` is the Cluster seat command |
| Skill directories | `skills/ground`, `skills/seat`, `skills/plan`, `skills/facts` (`/ground`, `/seat`, `/plan`, `/facts`) |
| Files | `.agents/runtime-profile.yml`, `.agents/seat-profile.yml`, `.agents/plan.yml`, `.agents/plan.local.yml`, `.agents/facts.yml` |
| Environment variables | `SEAT_ID`, `SEAT_PROJECT`, `SEAT_SKILL`, `SEAT_ENV`, `SEAT_EVIDENCE`, `PLAN_EVENTS`, `GROUND_STATE_DIR` |
| State directories | `~/.dev-infra/seats/`, `~/.dev-infra/plans/`, `~/.dev-infra/facts/` |
| JSON fields | `doctor` and `status --json` use `ground`, `seat`, `plan`, `facts` |

## Former names

| Current | Former |
| --- | --- |
| Ground | Grove |
| Seat | Dryad |
| Plan | Forester |
| Facts | Mycelium |

These former names are history only. They are not commands, files, or aliases.
