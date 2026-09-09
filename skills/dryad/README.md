# Dryad

One seat per worker on Grove's ground. A seat is a worktree, an overlay env
when the project has one, a task, and a journal of what the worker
reported. Dryad launches no agent: the person picks the launcher and who
sits where.

```
  human decides                    Dryad owns                     Grove owns
  -------------                    ----------                     ----------
  which task → which seat          worktree per seat              overlay env + lease
  which launcher (terminal,        registry + journal             names, engines
    worktree app, tmux, ACP)       counts: seats, worktrees,      readiness verdict
  when to merge                      envs, reported states
                                   seat handoff (--shell/--json)

     plan ──► seat ──► (launcher, not Dryad) ──► worker reports ──► finish
```

## What it does

Prepares a seat, hands it to whatever launcher you use, counts what the
workers report, and clears the seat when a person says the work is merged.
The defining constraint: completion is the worker's own `report --status
done`, never a process exit, and Dryad never repairs runtime state silently.

## When to reach for it

A seat reaches for it on its own when it wakes with `DRYAD_ID` set. A person
reaches for it to seat parallel work across worktrees, or to count who sits
where. For deciding *what* the work is and how many run at once, use
[forester](../forester/README.md).

## It's working if

- `dryad status` exits zero and its counts match what you see in `git worktree list`.
- Every live seat has a task a stranger could start from, and its last journal line says what the worker did.
- Nobody merges, pushes, or runs `finish` from inside a seat.

## Where it fits

Forester assigns into it; Grove stands under it; Mycelium reads its done
and blocked reports; Canopy (`de-novo skills canopy`) is the live screen
over its JSON. Root map: [How the skills fit](../../README.md#how-the-skills-fit).

## Apply to a project

1. Plant Grove first ([grove planting](../grove/references/planting.md#apply-to-a-project)).
   Dryad needs `project.slug` from `runtime-profile.yml`.
2. Write `.agents/dryad-profile.yml` with a `worktrees` section, or none if
   every seat will be adopted.
3. Symlink the skill: keep the canonical copy under `.agents/skills/dryad`
   and symlink tool-specific dirs to it. Never copy the body.
4. `de-novo skills dryad plan <id> --task … ` to see the plan, then `--apply`.

Design record and the reasons behind "no launcher": [docs/dryad-design.md](../../docs/dryad-design.md).
Contributing: [root AGENTS.md](../../AGENTS.md).

## Pointers

Fields, registry, CLI, Canopy, the seat brief, launcher handoff:
[references/seats.md](references/seats.md). Pattern: [SKILL.md](SKILL.md).
