# Glossary

User-facing names for this catalog. The old names stay as aliases. Skill
directories, profile filenames, environment variables, JSON fields, and the
existing CLI subcommands are unchanged. This page is the home of the
mapping. Other documents point here.

## Names

| Old | New | Meaning |
| --- | --- | --- |
| Grove | Ground | Shared local base and thin overlays |
| Dryad | Seat | One agent seat: worktree, overlay env, journal. Does not launch an agent |
| Forester | Plan | The plan, its dependencies, the budget, and `serve` |
| Mycelium | Facts | Assertion source of truth, kept apart from Plan |
| k3s/cluster backend | Cluster seat | A seat at cluster scale |
| network allowlist (if any) | Egress | What may leave the seat |

## Why the new names

Each old name is a forest metaphor. A newcomer cannot tell from the word
what the thing does, or which of two graphs they are reading.

- **Ground.** The shared local base: one engine set for the machine, names
  rather than ports, and a thin overlay for the services a task changed.
  "Ground" says what the other pieces stand on.
- **Seat.** The place one worker sits: a worktree, an overlay env when the
  project has one, and a journal. Preparing that place is the whole job.
  Seat does not launch an agent. A person picks the launcher.
- **Plan.** The work itself: items, dependencies, file claims, how many may
  run at once, and `serve`, which holds each seated item's real session.
  "Plan" is the artifact a person reads.
- **Facts.** What the project holds true, with time, confidence, domain,
  and source. It is a second graph. It is not the plan and it does not
  assign work. Workers propose; a judge commits.
- **Cluster seat.** The same idea as a seat, at a larger scale, on the
  k3s/k3d backend. The local seat is a worktree on this machine. A cluster
  seat is work running on a cluster.
- **Egress.** The name for what is allowed to leave a seat. Use it when a
  document has to say that. This catalog does not ship a network allowlist
  today, so there is no egress command to run.

## What those names point at today

Ground is the grove skill: `.agents/runtime-profile.yml`, `validate`,
`urls`, `overlay`, and the machine engines under `infra/`.

Seat is the dryad skill. One registered seat is still a worktree plus env
plus journal. The CLI that prepares it does not start the agent.

Plan is the forester skill: `.agents/forester-plan.yml`, the local budget,
`assign`, and `serve`.

Facts is the mycelium skill: the append-only assertion log. The only seam
to Plan is read-only (`propose --from-seat`).

Cluster seat is the name for the existing k3s/k3d backend, not a new
object. Two cluster names already exist and stay distinct.
`runtime.profiles.*.cluster` is the project's app cluster.
`de-novo skills infra k3d connect --cluster NAME` is the engine-link, and
it never defaults to `local`. Neither command was renamed. Details stay in
[`infra/README.md`](../infra/README.md).

Egress is only a name. An OAuth allowlist on a domain, and a launcher's
allow list of shell commands, are different things and keep their own words.

## The rule

CLI errors, new documents, and onboarding say **Seat**, **Plan**,
**Facts**, and **Ground**. The old names remain aliases, in parentheses
where a reader still needs the command or the file.

Write `Ground (Grove)`, `Seat (Dryad)`, `Plan (Forester)`, `Facts
(Mycelium)`, and `Cluster seat` (the k3d/k3s backend). Say Egress for what
may leave a seat.

These stay as they are:

| Surface | Stays |
| --- | --- |
| CLI subcommands | `dryad`, `forester`, `mycelium`, `infra k3d`. `seat`, `plan`, and `facts` call the same code |
| Skill directories and `name` | `skills/grove`, `skills/dryad`, `skills/forester`, `skills/mycelium`, and `/grove`, `/dryad`, `/forester`, `/mycelium` |
| Files | `.agents/runtime-profile.yml`, `.agents/dryad-profile.yml`, `.agents/forester-plan.yml`, `.agents/forester.local.yml`, `.agents/mycelium.yml` |
| Environment variables | `DRYAD_ID`, `DRYAD_PROJECT`, `DRYAD_SKILL`, `DRYAD_ENV`, `DRYAD_EVIDENCE`, `FORESTER_EVENTS`, `GROVE_STATE_DIR` |
| State directories | `~/.dev-infra/dryads/`, `~/.dev-infra/foresters/`, `~/.dev-infra/mycelium/` |
| JSON fields | `doctor` and `status --json` keep `grove`, `dryad`, `forester`, `mycelium` |
| Code | module paths, function names, compose labels, container names |

`de-novo skills plan` is the Plan command (an alias of `forester`). The
verb under it is still `plan`: `de-novo skills forester plan` and
`de-novo skills plan plan` both print the graph.
