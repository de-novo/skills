---
name: forester
description: >-
  de-novo Forester — analyse a body of work into a plan of items with
  dependencies and file claims, set how many may run at once on this
  machine, and keep that many seated as Dryad seats. Use when a person asks
  to break work into parallel items, to decide what to assign next, or to
  fill free slots; when the user runs /forester. Values live in
  .agents/forester-plan.yml (the plan, tracked) and
  .agents/forester.local.yml (this machine's budget, never committed). The
  CLI never calls a model; the analysis is yours.
---

# Forester

Grove is the ground and Dryad seats one worker on it. Forester decides which
work exists, in what order, and how much of it this machine runs at once.
The CLI is a pure function of three inputs: the plan, the Dryad seats, and
the budget. The same inputs give the same assignment every time.

This file owns the pattern. The fields, the allocation rule, and the CLI are
in [README.md](README.md). Dryad pattern: [dryad](../dryad/SKILL.md).

## Analyse the work

You write the plan. The CLI reads it. When a person hands you a goal:

1. **Split it into items a single worker can finish alone**, each with one
   task line that a stranger could start from. An item is too big when its
   task line needs "and". It is too small when its worktree would hold one
   trivial change.
2. **Name what each item will touch** in `owns`, as paths or globs. This is
   a claim, not a lock: the allocator refuses to run two items whose claims
   intersect, and nothing else enforces it. Claim what you honestly expect
   the worker to edit. Two items that must edit the same file are one item,
   or one depends on the other.
3. **Declare `depends_on`** only where the second item cannot start until
   the first is done. A shared reference that both read is a dependency on
   the item that writes it. Sharing an opinion is not.
4. **Order matters.** Items are walked in declared order and ties are broken
   by it. Put the item that unblocks the most first. Do not encode priority
   any other way; there is no estimate field on purpose.
5. Give `retry.max_attempts` above one only to an item whose failure is
   likely to be the worker's, not the plan's.

Write the result to `.agents/forester-plan.yml`, validate it with
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
the seat id and the task line as the seat's task. From there Dryad's rules
apply: the worker reports its own state, and `report --status done` is the
only thing that makes an item done. Rerun `assign --apply` after a done
report to fill the freed slot. A seat that is finished without a done report
spends one of the item's attempts.

`forester serve`, run in a terminal of its own, does the refill by itself
and starts each seated item's tool as a real interactive session that it
holds. Nothing is headless: every approval is still the tool's own prompt,
and `status` shows which session needs a person. `forester attach <id>`
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

## Not this skill

- Verifying that an item's work is good enough to land. That is a separate gate.
- A screen. Canopy shows seats; `forester plan --json` is shaped for it to read.
- Merging, rebasing, or deciding who yields on an overlap.
