# de-novo skills

Open-source skills and tools for developers and agents sharing development environments.

Grove helps independent worktrees verify their changes against a shared app
baseline. Give each task a named overlay, replace only the services it changes,
and track the work through readiness checks, interruption, retry, and cleanup.

## Why Grove

- **Work in parallel.** Different overlays can change concurrently; operations
  on the same overlay remain exclusive.
- **Verify the running change.** Attachment checks the adapter's observed image
  and readiness before marking the operation complete.
- **Recover unfinished work.** Pending operations remain visible for inspection
  and retry, including failed cleanup.
- **Bring your backend.** A project profile connects existing build and runtime
  commands to the common lifecycle contract.

The [reproducible Kubernetes lab](docs/evaluation/kubernetes/README.md) demonstrates
these behaviors with a synthetic web/API app, real worktrees, Docker builds,
and failure injection. [Recorded results](docs/evidence/2026-09-06-kubernetes-lifecycle.md)
include unsuccessful attempts and the limits of what was measured.

Projects supply workloads, routing, and data isolation through their adapters.
Grove's lifecycle checks do not establish application correctness or measured
productivity gains.

## Start here

- [Understand Grove and connect a project](skills/grove/README.md)
- [Run the disposable lab](docs/evaluation/kubernetes/README.md)
- [Read the overlay adapter contract](skills/grove/references/overlay-contract.md)

The source of truth for each skill is `skills/<name>/SKILL.md`. Human docs sit next to it as README. Project-specific values do not belong in a skill.

Agents working in this catalog: [`AGENTS.md`](AGENTS.md). Skill load paths: [`.agents/`](.agents/).

## Skills

| Name | One line |
| --- | --- |
| [grove](skills/grove/) | Shared local ground: n projects, m apps each, one infra set |
| [dryad](skills/dryad/) | One seat per worker on that ground: worktree, overlay env, task. No agent launch |
| [forester](skills/forester/) | Analyse the work into a plan, set how many run at once here, keep that many seated through Dryad; serve holds each seat's real session |
| [understory](skills/understory/) | The story under the canopy: Forester's graph drawn and written up for people, a map that points rather than copies |
| [mycelium](skills/mycelium/) | The facts under the forest: one append-only log of assertions per project, with time, confidence, domain, and provenance; workers propose, a person or the judge commits |

## CLI

Grove's machine-engine, profile, and overlay-lifecycle tool. Once per **this
catalog** checkout, not per consuming project:

```bash
npm install && npm link
```

Then consuming projects call `de-novo skills infra status` (and `infra up`,
`setup`, `init`, `validate`, `urls`, `overlay`, `dryad`). Projects choosing this machine
backend do not copy its `infra/` directory; projects choosing another backend
keep their own operating procedure. `de-novo-skills` is an alias without the `skills`
token. Machine engines are Grove-central (`infra` next to this CLI). `setup`
provisions a project's isolation units on that set. Without a link,
`node infra/bin/cli.mjs …` works the same. There is no down command —
stopping machine infra is a human decision because several projects live on it.

`de-novo skills canopy [--port N] [--once]` shows read-only [Canopy worktree cards, skill activity, files and overlaps](skills/dryad/README.md#canopy).

Engine table and ports: [`infra/README.md`](infra/README.md).
Overlay lifecycle and cleanup contract:
[`skills/grove/references/overlay-contract.md`](skills/grove/references/overlay-contract.md).

## Layout

```
AGENTS.md        how agents work in this catalog
.agents/         skill load adapter (symlinks into skills/)
skills/          skill sources. add a skill as <name>/SKILL.md
  grove/         first skill
  dryad/         seats on Grove's ground (no agent launch)
infra/           machine-shared engines Grove uses
  addressing.yml this checkout's TLD and hostname scheme
  docker-compose.yml engine catalog (profile = engine id)
docs/            documentation index + archived designs
```

Documentation index and historical designs: [docs/README.md](docs/README.md).
