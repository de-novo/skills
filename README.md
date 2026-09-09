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

## How the skills fit

Five skills, one machine, one direction of flow. Each owns one kind of fact
and one file; none restates another's.

```
                  a goal, and a person
                          │
                          ▼
   Forester      the plan: items, dependencies, file claims, a budget
                 .agents/forester-plan.yml (tracked) · forester.local.yml (this machine)
                          │ assign: one item → one seat
                          ▼
   Dryad         one seat per worker: a worktree, an overlay env, a task, a journal
                 .agents/dryad-profile.yml · <state>/dryads/<slug>.yml
                          │ stands on                         ▲ report done / blocked
                          ▼                                   │
   Grove         shared ground: machine engines, names not ports, thin overlays
                 .agents/runtime-profile.yml · infra/ (this catalog's backend)
                                                              │
   Mycelium      the facts: seats propose, a judge commits; time, confidence, source
                 .agents/mycelium.yml · <state>/mycelium/<slug>.jsonl  (append-only)

   Canopy        the live screen: seats, sessions, files that overlap   (reads Dryad + Forester JSON)
   Understory    the written record: the graph drawn, one line per item, facts pointed at
```

| Skill | Answers | Writes | Reads | Never does |
| --- | --- | --- | --- | --- |
| [grove](skills/grove/) | where does this project run on this machine | engines, overlay envs, names | the runtime profile | choose a port, stop shared engines |
| [dryad](skills/dryad/) | who sits where, on what task, and what did they report | a seat's worktree, env, journal | Grove's report | launch an agent, merge, order the work |
| [forester](skills/forester/) | what is the work, what may start now, how many at once | the plan (an agent writes it), seats through Dryad | the plan, the seats, the budget | call a model, hold world facts |
| [mycelium](skills/mycelium/) | what does the project hold true, since when, on whose word | one log line per propose, commit, invalidate | the log, a seat's report (read-only seam) | judge, write the plan, touch a seat |
| [understory](skills/understory/) | can a person who was not here read the work | the document (an agent writes the prose) | Forester's graph, Mycelium's ids | draw by hand, restate a fact |

Canopy is a verb of Dryad's CLI (`de-novo skills canopy`), not a skill: a
read-only screen over the same JSON the other verbs print.

**The seams are one-way.** Forester assigns into Dryad and reads Dryad's
reports back; Mycelium reads a seat's done or blocked report and never
writes a seat; Understory reads Forester's graph and Mycelium's fact ids and
writes only prose. No skill reaches around another to its file.

**Two graphs, kept apart.** Forester's graph is the work: items and their
five states. Mycelium's graph is what the work found out: assertions with a
valid interval, transaction time, confidence, domain, and writer. The plan
file never holds a world fact; the log never holds an assignment. The only
seam is `propose --from-seat`. Reasons: [`docs/mycelium-design.md`](docs/mycelium-design.md).

**Not in any skill.** Launching agents (a person picks the launcher: a
terminal, a worktree app, tmux, an ACP client); merging; browser QA and e2e;
stopping machine infra. Those are a person's, by decision.

## Install

Two routes; pick one.

**As a Claude Code plugin.** The skills arrive as a managed bundle. From
inside a session:

```
/plugin marketplace add de-novo/skills
/plugin install de-novo-skills@de-novo
```

**As a checkout.** Clone, then `npm install && npm link`; the skills load
through `.agents/skills/` symlinks and `de-novo skills` is on your PATH.

The CLI comes only with the checkout today. A plugin install gives you the
five skills; the verbs they name (`de-novo skills …`) need the checkout
linked once on the machine. The skills say what to run; the checkout is
what runs it.

## Skills

Model-invoked: a seat or a person reaches for these.

| Name | One line |
| --- | --- |
| [grove](skills/grove/) | Shared local ground: n projects, m apps each, one infra set |
| [dryad](skills/dryad/) | One seat per worker on that ground: worktree, overlay env, task. No agent launch |
| [understory](skills/understory/) | The story under the canopy: Forester's graph drawn and written up for people, a map that points rather than copies |
| [mycelium](skills/mycelium/) | The facts under the forest: one append-only log of assertions per project, with time, confidence, domain, and provenance; workers propose, a person or the judge commits |
| [herbarium](skills/herbarium/) | Every document has one house and the rest point at it; `check` counts broken links, copied prose, wrong script, and pages over the cap |

User-invoked: only a person typing the name reaches these.

| Name | One line |
| --- | --- |
| [forester](skills/forester/) | Grill the person, split the work into a plan, set how many run at once here, keep that many seated through Dryad; serve holds each seat's real session |
| [clearing](skills/clearing/) | Stop and re-pitch where the work has got to, from the graph and the facts, in plain words |

## CLI

Grove's machine-engine, profile, and overlay-lifecycle tool. Once per **this
catalog** checkout, not per consuming project:

```bash
npm install && npm link
```

Then consuming projects call `de-novo skills infra status` (and `infra up`,
`setup`, `init`, `validate`, `urls`, `overlay`, `dryad`, `forester`,
`understory`, `mycelium`). Projects choosing this machine
backend do not copy its `infra/` directory; projects choosing another backend
keep their own operating procedure. `de-novo-skills` is an alias without the `skills`
token. Machine engines are Grove-central (`infra` next to this CLI). `setup`
provisions a project's isolation units on that set. Without a link,
`node infra/bin/cli.mjs …` works the same. There is no down command —
stopping machine infra is a human decision because several projects live on it.

`de-novo skills canopy [--port N] [--once]` shows read-only [Canopy worktree cards, skill activity, files and overlaps](skills/dryad/references/seats.md#canopy).

Engine table and ports: [`infra/README.md`](infra/README.md).
Overlay lifecycle and cleanup contract:
[`skills/grove/references/overlay-contract.md`](skills/grove/references/overlay-contract.md).

## Layout

```
AGENTS.md        how agents work in this catalog
LICENSE          MIT
.claude-plugin/  plugin manifest and the repo's own marketplace entry
.agents/         skill load adapter (symlinks into skills/), and this catalog's own
                 dryad-profile.yml and mycelium.yml (it seats its own workers)
skills/          skill sources. add a skill as <name>/SKILL.md; a short README next to it
                 for people, references/ for the long facts, agents/openai.yaml for Codex
  grove/         shared ground: engines, names, overlays
  dryad/         seats on Grove's ground (no agent launch); Canopy is one of its verbs
  forester/      plan, budget, allocator over Dryad seats; serve holds sessions
  understory/    the work graph drawn and written up for people
  mycelium/      the assertion log: what the project holds true
  clearing/      stop and re-pitch where the work is (reads the two above)
  herbarium/     where each document lives and how it is written; check counts what drifts
infra/           machine-shared engines and the CLI (infra/bin/cli.mjs)
  lib/           one module per skill owns that skill's parse and rules
  bin/*.test.mjs the suite, including two sandbox arcs that seat a real worker
  addressing.yml this checkout's TLD and hostname scheme
  docker-compose.yml engine catalog (profile = engine id)
playground/      the sample project the sandbox arcs copy out and throw away
docs/            documentation index, design notes, dated evidence, archived designs
```

Documentation index and historical designs: [docs/README.md](docs/README.md).
