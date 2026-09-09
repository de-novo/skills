# Forester

The plan, the budget, the allocator. An agent reading the skill interviews
the person, splits the work into items with dependencies and file claims,
and writes the plan; the CLI keeps as many seated as this machine allows.

```
goal ──(grill, then an agent writes)──▶ .agents/forester-plan.yml
                                              │
             .agents/forester.local.yml ──▶ allocate ──▶ dryad plan <id> --apply
             (parallel, this machine)          ▲                 │
                                               └── dryad report ─┘
```

## What it does

Turns a goal into items a single worker can finish alone, each a vertical
slice sized to one context window, with `owns` claims and `depends_on`
edges; then assigns the ready ones into Dryad seats up to the budget. The
defining constraint: the CLI never calls a model and never schedules by
estimate. The same plan, seats, and budget give the same assignment.

## When to reach for it

You type `/forester`; the agent does not reach for it on its own. Reach for
it when a body of work should run as parallel items, when you want to know
what may start now, or when free slots should be filled. For a single
seat with a task you already have, use [dryad](../dryad/README.md) directly.

## It's working if

- `forester plan` prints a graph a person reads and understands without asking you.
- The grilling ended with an empty frontier, and the person approved the item list before the file existed.
- `assign --apply` seats only items whose claims do not intersect a live seat's.

## Where it fits

The first step after a goal: it feeds Dryad, Understory draws its graph,
Mycelium keeps the decisions the grilling locked. Root map:
[How the skills fit](../../README.md#how-the-skills-fit).

## Apply to a project

1. The project has `.agents/dryad-profile.yml` (and usually Grove's
   `runtime-profile.yml`).
2. An agent reading [SKILL.md](SKILL.md) writes `.agents/forester-plan.yml`.
3. Set `parallel` in `.agents/forester.local.yml`, or in the plan when the
   project owns that decision.
4. `forester plan`, read it, then either `forester assign --apply` and seat
   the workers with any launcher, rerunning `assign --apply` as done reports
   arrive, or `forester serve` in a terminal of its own and `forester attach
   <id>` whenever `status` shows a session that needs input.
5. `serve` needs `@lydell/node-pty`, an optional dependency of the catalog;
   `npm install` in the catalog brings it. Nothing else needs it.

## Pointers

Fields, the local file, item states, the allocation rule, the CLI, sessions
and hooks: [references/plan.md](references/plan.md). Pattern:
[SKILL.md](SKILL.md). Reasons: [`docs/forester-design.md`](../../docs/forester-design.md).
