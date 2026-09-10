---
name: forester
description: >-
  de-novo Forester — break a body of work into a plan of items with
  dependencies and file claims, set how many may run at once on this
  machine, and keep that many seated as Dryad seats. Values live in
  .agents/forester-plan.yml (the plan, tracked) and
  .agents/forester.local.yml (this machine's budget, never committed). The
  CLI never calls a model; the analysis is yours.
disable-model-invocation: true
---

# Forester

Grove is the ground and Dryad seats one worker on it. Forester decides which
work exists, in what order, and how much of it this machine runs at once.
The CLI is a pure function of three inputs: the plan, the Dryad seats, and
the budget. The same inputs give the same assignment every time.

This file owns the pattern. The fields, the allocation rule, and the CLI are
in [references/plan.md](references/plan.md). Dryad pattern: [dryad](../dryad/SKILL.md).

## Grill first

Nobody knows exactly what they want. Before any item exists, interview the
person until the two of you hold the same picture. Work it as a **design
tree**: every decision branches into the decisions that hang off it. The
**frontier** is every question whose prerequisites are already answered.
Ask the whole frontier in one round, numbered, each with your recommended
answer, then wait. A round with one question is a round; a round that
guesses at an answer it has not heard is not.

```
Q1  <title>: <the question, with the choices if there are some>
    → <your recommended answer, and why in one line>
```

Stop when the frontier is empty: no open question remains whose answer
would change an item, a claim, or an edge. A locked decision is a fact
worth keeping: propose it to Mycelium as a `decision` when the project has
the log (Call the Skill tool with "mycelium").

## Analyse the work

You write the plan. The CLI reads it. When the grilling is done:

1. **Split it into items a single worker can finish alone**, each with a
   one-line title and, unless the title says it all, a `brief` file that a
   stranger could start from (outcome, boundary, verification, report,
   forbidden: the shape in [Dryad's seat brief](../dryad/references/seats.md#writing-a-seat-brief)).
   Name the checks in `verify`; the handoff carries both. An item is a **vertical
   slice**: a narrow but complete path through every layer it touches, so a
   finished item is demoable or verifiable on its own, never one layer of
   something bigger. Size each to one fresh context window. An item is too
   big when its task line needs "and". It is too small when its worktree
   would hold one trivial change. A **wide refactor** (one mechanical change
   whose blast radius is the whole codebase) is the exception: sequence it
   as expand, then migrate in batches sized by blast radius, then contract,
   each batch an item blocked by the expand.
2. **Name what each item will touch** in `owns`, as paths or globs. This is
   a claim, not a lock: the allocator refuses to run two items whose claims
   intersect, and nothing else enforces it. Claim what you honestly expect
   the worker to edit. Two items that must edit the same file are one item,
   or one depends on the other.
3. **Declare `depends_on`** only where the second item cannot start until
   the first is done, and say what it needs. A bare id means the second
   item starts from a base that holds the first one's result, so it waits
   until a person has merged that branch (or recorded the squash with
   `dryad integrate`). `{ item: <id>, needs: order }` means only that the
   first has reported done. A shared reference that both read is a result
   dependency on the item that writes it. Sharing an opinion is not.
4. **Order matters.** Items are walked in declared order and ties are broken
   by it. Put the item that unblocks the most first. Do not encode priority
   any other way; there is no estimate field on purpose.
5. Give `retry.max_attempts` above one only to an item whose failure is
   likely to be the worker's, not the plan's.

6. **Quiz the person before writing the file.** Show the items as a
   numbered list: title, blocked by, what it delivers end to end. Ask three
   things: is the granularity right, does each edge gate what it says it
   gates, should any item be merged or split. Iterate until they say yes.

Then write `.agents/forester-plan.yml`, validate it with
`de-novo skills forester plan`, and show the person the printed graph before
anything is assigned. The first evidence that a plan is good is that a
person can read that output and know what is happening.

## Set the budget

`parallel` is how many items may be active at once. It is a property of the
machine more than the project: a laptop running three shared engines seats
fewer workers than a workstation. So it lives in `.agents/forester.local.yml`,
which is gitignored. A project may set `parallel` in the plan itself, and
then the project's value is followed and the local file is ignored. No
budget anywhere is an error, never a silent default.

## Keep the slots full

```bash
de-novo skills forester plan             # every item and why it is in its state
de-novo skills forester next             # what assign would seat now; changes nothing
de-novo skills forester assign --apply   # seat the chosen items through Dryad
de-novo skills forester status           # slots filled, items waiting
```

`assign --apply` creates one Dryad seat per chosen item, with the item id as
the seat id, a generated handoff as the seat's task, and the item's
revision, scope, and dependency inputs recorded on the seat. From there
Dryad's rules apply: the worker reports its own state, and `report --status
done` for this revision is the only thing that makes an item done. A done
report is a report, not an integration: an item whose result another item
needs stays `waiting` until a person merges its branch or records the
squash, and `plan` says which. Rerun `assign --apply` after a done report
or a merge to fill the freed slot. A seat that is finished without a done
report spends one of the item's attempts; the next attempt gets a branch of
its own. Editing an item's task, claims, or brief gives it a new revision,
and no earlier done is inherited.

`forester serve`, run in a terminal of its own, does the refill by itself
and starts each seated item's tool as a real interactive session that it
holds. Nothing is headless: every approval, the trust dialog included, is
still the tool's own prompt, and `status` shows which session needs a
person. serve grants no trust on its own; a machine that wants seat
worktrees pre-trusted says so in the local file. `forester attach <id>`
opens that session; Ctrl-] leaves it running. The tools and their launch
lines are machine facts and live in the local file, never in the plan.
Run `forester hooks --apply` once on a machine so Codex, Grok, Cursor, and
OpenCode sessions report their state the way Claude Code does; `--remove`
takes it back.

## Invariants — not weakenable

- **No model call in the CLI.** You analyse; the file is the interface.
- **Forester creates no environment or worktree itself.** It asks Dryad,
  which asks Grove.
- **A claim is not a lock.** `owns` constrains allocation, not the filesystem.
- **Order is declared, not inferred.** No estimate-based scheduling.
- **The project's budget wins; the local one is the fallback; none is an error.**
- **A done report is not an integration.** A result reaches a dependent item
  only through the baseline, by a person's merge or recorded integration.
  Forester never merges.
- **A done belongs to a revision.** An item edited after its seat was done
  is not done.

## Not this skill

- Verifying that an item's work is good enough to land. That is a separate gate.
- A screen. Canopy shows seats; `forester plan --json` is shaped for it to read.
- Merging, rebasing, or deciding who yields on an overlap.
