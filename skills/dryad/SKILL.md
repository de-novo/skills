---
name: dryad
description: >-
  de-novo Dryad — one seat per worker on Grove's ground. A seat is a Git
  worktree, an overlay env when the project has overlays, and a task. Dryad
  launches no agent: the human picks the launcher (a terminal, a worktree
  app, tmux, an ACP client) and which worker sits where. Use when you wake up
  with DRYAD_ID set; when planning parallel work across worktrees; when
  counting who sits where and what they reported; when the user runs /dryad.
  Project values live in .agents/dryad-profile.yml. Launching, mailboxes,
  DAGs, and merging are out of scope.
---

# Dryad

Grove is the ground. Dryad puts one seat on one tree: a worktree, an overlay
env when the project has one, and a task. It counts who sits where and what
they reported, and clears the seat when the work is done. Dryad never starts
an agent process; the launcher and the assignment stay with the human.

This file owns the pattern. Values live in `.agents/dryad-profile.yml` next to
Grove's `runtime-profile.yml`; with Grove present, Dryad reads the project
slug and overlay mode from Grove's profile and keeps none of its own. A
project without Grove declares only its slug and gets seats without envs. Schema and CLI reference:
[references/seats.md](references/seats.md). Grove pattern: [grove](../grove/SKILL.md).

## You are a dryad when

`DRYAD_ID` is set in your environment. Then:

```bash
cat "$DRYAD_SKILL"                              # this file, wherever the catalog lives
de-novo skills dryad seat "$DRYAD_ID" --json    # your worktree, branch, env, task
de-novo skills dryad seat "$DRYAD_ID" --task    # the task text alone
```

`DRYAD_PROJECT` is the baseline checkout; every Dryad command you run from
the worktree resolves the project through it. `DRYAD_ENV` is empty when the
project has no overlays. If `DRYAD_ID` is unset, this section does not apply.

## Rules for a seated worker

1. Change nothing outside your worktree. Reading elsewhere is fine; writing
   to the baseline checkout, other seats' worktrees, or machine state is not.
2. Verify through the Grove procedure. Your env already exists; you `attach`
   your changed services, and `finish` destroys the env later. Shared-only
   services stay on baseline.
3. Report your own state. `report --status blocked --note …` when stuck,
   `report --status working --note …` at three moments at least: before the
   first edit (what you are about to change), before verification (what
   you will run), and before the commit (what changed). One line each,
   present tense. When Forester's `serve` holds your session, the person
   also sees your tool stream ("now Edit app/api/server.mjs"); your notes
   say *why*, which the stream cannot.
4. When done: commit on your branch, run `report --status done`, and stop.
   Do not push, merge, or call `finish`. Those belong to the human.
5. Before `report --status done`, check whether your tool exposes a session
   id or transcript path (Claude Code and Codex both do). If it does, include
   `--session <ref>` so a person can open the native log later. `report done`
   without one prints a reminder; it is not an error.

Completion is your report, not your process exit. A seat with no `done`
report is not done.

**Your done report is a handoff.** The next reader is a fresh agent or a
person who was not here, so the note says what now works and what is open,
in the fewest words that let them continue. Do not repeat what already
lives in a commit, a PR, a spec, or the plan; name it by path or id. A fact
that outlives the seat (a locked decision, a verified cause, an approach
that failed) is not a note: propose it to Mycelium when the project has
the log (Call the Skill tool with "mycelium"), and let the note carry the
id. Redact any secret before it reaches the journal.

## Seating others

Before planning a seat, write a brief the worker can complete independently.
Use [Writing a seat brief](references/seats.md#writing-a-seat-brief) for its shape,
rejection checks, and examples. It points back to the worker rules above for
reporting and completion; a task does not replace those rules.

For the human or an orchestrator, in order:

1. `de-novo skills dryad plan <id> --task … --by <label>` prints the plan;
   `--apply` creates the worktree, calls Grove's `overlay create` when the
   profile has overlays, and registers the seat. Pass
   `--worktree <path>` to adopt a worktree another launcher already made.
2. `de-novo skills dryad seat <id> --shell|--env|--json` hands the seat to
   any launcher. Dryad does not run the launcher.
3. `de-novo skills dryad status [<id>]` counts seats, worktrees present,
   envs tracked, and reported states. Non-zero when a worktree is missing, an
   env is untracked or pending, Grove's status fails, or a seat is blocked.
4. After the branch is reviewed and merged by a person:
   `de-novo skills dryad finish <id> --apply` destroys the env and removes
   only a clean, Dryad-created worktree. Adopted worktrees and all branches
   are kept. There is no `--force`. The seat's journal moves to the finished
   archive; `status --finished [<id>]` reads it for a later audit.

A failed `overlay create` leaves the seat with `env: pending`; rerun the same
`plan --apply` to retry. Dryad never repairs runtime state silently.

## Not this skill

Launching or steering agents, PTYs, hooks, mailboxes, task DAGs, supervision
loops, merging, pushing, and browser QA. Machine engines and overlay
lifecycle rules are Grove's.
