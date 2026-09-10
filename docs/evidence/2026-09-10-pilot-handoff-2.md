# The second handoff pilot: a Codex seat, a squash integration, a mismatched claim, a second attempt — 2026-09-10

The second cold run on the playground sample, after the first
([pilot 1](2026-09-10-pilot-handoff.md)) had been merged as PR #22. Three
items this time, one of them a Codex seat and one with a plan claim that
disagrees with its brief, the api integrated by a squash instead of a
merge, and serve stopped and started in the middle. Catalog at `main`
`a26aafd` plus the fixes this run found.

## Harness

| Piece | Value |
| --- | --- |
| Plan | `api-count` (Claude, owns `app/api/**`); `web-title` (Claude, brief asks for a change in `app/web/server.mjs`, plan claims `docs/**`); `docs-count` (Codex, `depends_on: [api-count]`, owns `docs/**`) |
| Tools | `claude … --permission-mode acceptEdits` with an allow list; `codex -a on-request -s workspace-write --add-dir <sandbox>` |
| Hooks | `forester hooks --apply` before, `--remove --apply` after (3 stores written, 3 taken back) |
| Budget, cap | `parallel: 2`, machine cap 2 |
| Driver | attached through `forester attach` in Orca terminals; answered trust dialogs and prompts; merged, squashed, integrated, finished |

## What happened, in order

1. **Two seats at once.** serve seated `api-count` and `web-title`
   (Claude Code), both parked on the trust dialog; the driver answered
   both through attach. Each seat's first command,
   `de-novo skills dryad seat "$DRYAD_ID" --json`, stopped on a
   permission prompt marked "Contains simple_expansion": Claude Code asks
   about a `$VARIABLE` in a command even when the command's prefix is
   allowed and even in auto mode. One command per line, the lesson of
   pilot 1, was not enough.
2. **`api-count` done** in about 2 min 20 s: three working reports, one
   file in scope, commit `96df15a`, image built, overlay attached, 200 on
   its overlay name and 404 on the baseline name, evidence written at
   `$DRYAD_EVIDENCE`, report done with no `--evidence` flag.
3. **`web-title` blocked itself.** Reading the plan's claim (`docs/**`)
   against the brief (a title in `app/web/server.mjs`), it edited nothing,
   ran the named check on the unchanged file, wrote its evidence, and
   reported blocked with the two sentences a person needs: what disagrees,
   and the two ways out. The out-of-scope refusal at `report done` was not
   exercised, because the seat never went out of scope.
4. **The squash.** The driver squashed `seat/api-count` onto the baseline
   (`a880f3b`). `docs-count` stayed `waiting` (the original head is not an
   ancestor). `dryad integrate api-count --commit a880f3b --by human:driver
   --apply` recorded it; within one poll `docs-count` was `ready ·
   api-count done and in the baseline (api-count integrated as
   a880f3b7027a)` and serve seated it on base `a880f3b` with `inputs`
   naming the original head `96df15a`.
5. **The widened claim.** The driver changed `web-title`'s `owns` to
   `app/web/**` in the plan. `forester plan` showed the live seat as
   `active · seat blocked for revision fa7dfa86…; the plan is now
   b2801dde…; finish that seat`. The driver finished it; serve seated
   attempt 2 on branch `seat/web-title-2` with the new scope, the blocked
   attempt's branch kept.
6. **Defect: the old session stayed.** The first attempt's Claude session
   was still alive after the finish (it had reported blocked, not done), so
   serve neither closed it nor launched attempt 2's seat: `status` showed
   attempt 2 seated and attempt 1's session `needs-input`. Fixed below.
7. **serve stopped and started** (Ctrl-C, then the same command): both
   sessions closed on stop; the new daemon launched `web-title` attempt 2
   and `docs-count` (Codex) as fresh sessions.
8. **Codex.** Its directory-trust prompt was answered through attach. Its
   first `dryad seat` call failed inside Codex's sandbox: the playground's
   process guard runs `ps` and Codex's `workspace-write` sandbox refused
   it. Codex asked to run the command outside the sandbox; the driver
   confirmed that and every later escalation (three distinct commands:
   `dryad seat`, `dryad report … working`, `dryad report … done`). Codex's
   hooks fired nothing: the seat's events file stayed empty, so its
   session state came from the screen fallback only. It reported working
   four times, verified the squash itself (`git diff 96df15a HEAD --
   app/api` empty, listed as a check), wrote `docs/api.md` (139 lines),
   and reported done with 22 checks and 2 `not_measured`, its session id
   from `$CODEX_THREAD_ID`.
9. **`web-title` attempt 2** stopped on a prompt for nearly every command
   (`$DRYAD_EVENTS`, `$DRYAD_PROJECT`, and then the Write of its evidence
   file outside the worktree, which `acceptEdits` does not cover). Seven
   prompts answered by the driver. Done: one file in scope, commit
   `a7423e5`, served page title observed as `notes` by running the server
   directly.
10. **Merge, finish, down.** Both branches merged; three seats finished;
    `forester machine` showed `held 0/2` with no stale entry (the per-poll
    reclaim from pilot 1 held); hooks removed 3/4 (opencode's plugin was
    the machine's own and stayed); serve stopped; `playground down`:
    processes 0, ports 0, machine mentions 0.

## Counts

| | |
| --- | --- |
| Items, seats, attempts | 3, 4 (one item twice), Claude ×3 and Codex ×1 |
| Prompts a person answered | trust 2 (Claude) + 1 (Codex); Claude permission prompts 2 + 7; Codex escalations 3 distinct commands |
| Working reports before done or blocked | 3, 1, 3, 4 |
| Evidence checks | 8; 1 (blocked); 2; 22 |
| Paths outside scope | 0 in every done report |
| Dependent seated before its input was integrated | 0 |
| Codex hook events recorded | 0 |
| Machine mentions after down | 0 |

## Found on the way

- **Defect, fixed.** A session belongs to one seat: when a seat is
  finished while its session is live, serve now closes it (`seat
  finished`), and when a new attempt is seated it closes or drops the old
  attempt's session and launches the new seat. The regression finishes a
  parked seat and expects attempt 2 launched as its own session; reverting
  the rule turns it red (1).
- **`$VARIABLE` is a prompt.** Claude Code prompts on variable expansion
  regardless of the allow list. The handoff now names the seat id and the
  evidence file literally and says to use them as written; the Dryad skill
  says so too.
- **Writing the evidence file is a prompt** under `acceptEdits`, because
  the file is outside the worktree by design. `report --status done
  --evidence -` now takes the YAML on stdin, so a seat hands its evidence
  in with the report through one allowed command and writes no file; the
  handoff and the skill lead with that form.
- **Codex hooks did not fire** in Codex 0.154.0 under this machine's Orca
  Codex home; the events file stayed empty and the session state came
  from the screen fallback. Not diagnosed here.
- **Codex's sandbox and the playground guard** disagree on `ps`: the guard
  is the sandbox's, not the catalog's; Codex's escalation path handled it
  at the cost of one prompt per command.
- **A worktree's plan copy is stale.** The `web-title` seat noticed its
  worktree's `.agents/forester-plan.yml` (from the base commit) still said
  `docs/**` while the baseline and its scope said `app/web/**`, and said so
  in its working report. The seat's `scope` is the fact; the copy is not.

## Not measured

An out-of-scope done in a live session (the seat refused itself first);
why Codex's hooks stay silent; a second machine sharing the state
directory.
