---
name: seat
description: >-
  de-novo Seat — one agent seat on Ground. A seat is a Git
  worktree, an overlay env when the project has overlays, and a task. Seat
  launches no agent: the human picks the launcher (a terminal, a worktree
  app, tmux, an ACP client) and which worker sits where. Use when you wake up
  with SEAT_ID set; when planning parallel work across worktrees; when
  counting who sits where and what they reported; when the user runs /seat.
  Project values live in .agents/seat-profile.yml. Launching, mailboxes,
  DAGs, and merging are out of scope.
---

# Seat

Ground is the base. Seat puts one worker on it: a worktree, an overlay
env when the project has one, and a task. It counts who sits where and what
they reported, and clears the seat when the work is done. Seat never starts
an agent process; the launcher and the assignment stay with the human.
See [docs/glossary.md](../../docs/glossary.md).

This file owns the pattern. Values live in `.agents/seat-profile.yml` next to
Ground's `runtime-profile.yml`; with Ground present, Seat reads the project
slug and overlay mode from Ground's profile and keeps none of its own. A
project without Ground declares only its slug and gets seats without envs. Schema and CLI reference:
[references/seats.md](references/seats.md). Ground pattern: [ground](../ground/SKILL.md).

## You are seated when

`SEAT_ID` is set in your environment. Then:

```bash
cat "$SEAT_SKILL"                              # this file, wherever the catalog lives
de-novo skills seat seat "$SEAT_ID" --json    # your worktree, branch, env, task
de-novo skills seat seat "$SEAT_ID" --task    # the task text alone
```

`SEAT_PROJECT` is the baseline checkout; every Seat command you run from
the worktree resolves the project through it. `SEAT_ENV` is empty when the
project has no overlays. `SEAT_EVIDENCE` is the file your done report
reads. If `SEAT_ID` is unset, this section does not apply.

Run each of these as its own command, and keep doing so: a launcher's
allow list matches one command, and a line that chains several with `;`
or `&&` stops you on a prompt a person has to answer. So does a
`$VARIABLE` in the line: your handoff names your seat id and your paths
literally; use them as written.

## Rules for a seated worker

1. Change no source outside your worktree: not the baseline checkout, not
   another seat's worktree, not a shared engine. Reading elsewhere is fine.
   Writing through an owner's own verb is not "outside": `report`, a
   Facts `propose`, an `overlay attach` on your own env, and the journal
   those write are the seat's voice, and the owner keeps the file.
2. Verify through the Ground procedure. Your env already exists; you `attach`
   your changed services, and `finish` destroys the env later. Shared-only
   services stay on baseline.
3. Report your own state. `report --status blocked --note …` when stuck,
   `report --status working --note …` at three moments at least: before the
   first edit (what you are about to change), before verification (what
   you will run), and before the commit (what changed). One line each,
   present tense. When Plan's `serve` holds your session, the person
   also sees your tool stream ("now Edit app/api/server.mjs"); your notes
   say *why*, which the stream cannot.
4. When done: commit on your branch, then hand in your evidence with the
   report and stop: `report --status done --evidence -` with the YAML on
   stdin (each check you ran with command, cwd, exit, observed count; each
   boundary you did not measure with its reason). Writing it to the seat's
   evidence file first and reporting without `--evidence` is the same
   thing with one file write a launcher may ask about. Done records your head and holds the paths you
   touched against the seat's scope, so a change outside it is refused
   until a person accepts it. Only what is committed reaches anyone else.
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
that failed) is not a note: propose it to Facts when the project has
the log (Call the Skill tool with "facts"), and let the note carry the
id. Redact any secret before it reaches the journal.

## Seating others

Before planning a seat, write a brief the worker can complete independently.
Use [Writing a seat brief](references/seats.md#writing-a-seat-brief) for its shape,
rejection checks, and examples. It points back to the worker rules above for
reporting and completion; a task does not replace those rules.

For the human or an orchestrator, in order:

1. `de-novo skills seat plan <id> --task … --owns <claim> … --by <label>`
   prints the plan; `--apply` creates the worktree, calls Ground's
   `overlay create` when the profile has overlays, and registers the seat
   with its scope. Pass `--worktree <path>` to adopt a worktree another
   launcher already made, `--read-only` for a seat that edits nothing.
2. `de-novo skills seat seat <id> --shell|--env|--json` hands the seat to
   any launcher. Seat does not run the launcher.
3. `de-novo skills seat status [<id>]` counts seats, worktrees present,
   envs tracked, and reported states. Non-zero when a worktree is missing, an
   env is untracked or pending, Ground's status fails, or a seat is blocked.
4. After the branch is reviewed and merged by a person: when the merge
   was a squash or a rebase, `de-novo skills seat integrate <id> --commit
   <sha> --apply` records where the result landed, so a dependent item can
   prove its base holds it. Then `de-novo skills seat finish <id> --apply`
   destroys the env and removes only a clean, Seat-created worktree.
   Adopted worktrees and all branches are kept. There is no `--force`. The
   seat's journal moves to the finished archive; `status --finished [<id>]`
   reads it for a later audit. The next attempt at the same id gets a
   branch of its own, or continues this one with `--resume`.

A failed `overlay create` leaves the seat with `env: pending`; rerun the same
`plan --apply` to retry. Seat never repairs runtime state silently.

## Not this skill

Launching or steering agents, PTYs, hooks, mailboxes, task DAGs, supervision
loops, merging, pushing, and browser QA. Machine engines and overlay
lifecycle rules are Ground's.
