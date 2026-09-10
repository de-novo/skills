# Dryad — profile, registry, CLI, Canopy, the seat brief

The long facts of Dryad. Pattern: [SKILL.md](../SKILL.md). The human page:
[README.md](../README.md).

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


## Profile

`.agents/dryad-profile.yml` in the consuming project, next to Grove's
`runtime-profile.yml`. Allowed top-level keys: `version`, `project`,
`worktrees`.

```yaml
version: 1                       # omitted = 1; other values rejected
# project: { slug: myproject }   # only for a project WITHOUT Grove; with a
                                 # runtime-profile.yml the slug lives there and
                                 # declaring it here is rejected as a duplicate
worktrees:                       # omit when every seat adopts an existing worktree
  root: ../myproject-seats       # where plan creates worktrees; must be outside the checkout
  branch: "dryad/{id}"           # only {id} is substituted
```

With Grove, Dryad reads the project slug and overlay mode from
`runtime-profile.yml`. Without Grove there are no overlay envs; seats are
worktrees and reports only.
There is no launcher configuration: which tool runs in a seat is the
launcher's own setting, not a Dryad value. Example: [examples/](../examples/).

## Registry

`~/.dev-infra/dryads/<slug>.yml` (`GROVE_STATE_DIR/dryads/` when the override
is set). One record per seat: worktree, `owned` (created by Dryad or
adopted), branch, base commit, `attempt` (1 for the first seat at an id,
n+1 after n finished seats), `resumed_from` (the attempt whose branch
`--resume` continued, else null), task, `scope` (the claims given with
`--owns`, `[]` for `--read-only`, `null` when unchecked), `revision` (the
planner's label for which version of the task this seat is for; Dryad
stores it and never interprets it), `inputs` (`{ <seat id>: <sha> }` from
`--input`, the results this seat starts from), env (`null`, `pending`, or
the env name), `by`, `session`, `status`, `result` (recorded by a done
report, see below), `integration` (recorded by `integrate`), and an
append-only `journal` of what Dryad did and what the worker reported. The
registry also names the `repository` the slug is bound to: the root commit
of the baseline's history. Records planned before 2026-09-10 lack the new
fields; every reader treats absent as unknown. The registry mirrors state;
it does not repair it.

A done report's `result` is `{ head, base, ahead, clean, changed,
scope_checked, outside_scope, at, evidence }`: the seat's own HEAD at the
report, whether `git status` was empty, how many paths the seat touched
since its base (destinations, rename sources, deletions, untracked files),
which of them lay outside the scope, and the evidence file's content or
null. Evidence is `{ checks: [{ command, cwd, exit, observed }],
not_measured: [{ boundary, reason }] }`, both lists optional and each entry
whole; it is recorded as given and judged by nobody here. `integration` is
`{ commit, result_head, by, note, at }`: the commit a person says the
result landed as, resolved in this repository at record time.

Journal entries are `{ at, actor, event, detail }`. `actor` is `dryad` for
what the tooling did (`plan`, `plan.retry`, `finish…`) and `seat` for what
the worker did (`report`, `cli`). A `cli` entry also carries `exit`: whenever
a process with `DRYAD_ID` set runs a state-changing catalog verb — `overlay
create|attach|detach|destroy|touch|prune --apply`, `setup`, `infra
up|provision` — the CLI appends one line with the command as typed and its
exit code, so a failed attach is recorded as what the seat tried. Read-only
verbs (`status`, `seat`, `urls`, `validate`, `projects`, `canopy`) are never
recorded: a dashboard polling them must not bury the journal it reads, and
`report` writes its own event. Arguments after `--` belong to the project's
own command, so only their SHA-256 digest is kept. Recording is best effort:
a finished seat, an unresolvable project, or a busy registry records nothing
and never fails or delays the command it observes. `finish` moves the record to `<slug>.finished.yml` next to it;
`status --finished` reads that archive. It grows without bound; trim it by
hand when it stops being useful.

Next to the registries, `projects.yml` is the machine's project index:
`version: 1` and `projects: { <slug>: { root, updated_at } }`, one entry per
slug that has ever planned a seat on this machine, `root` being the baseline
checkout. Every `plan --apply` that registers a seat rewrites the slug's
entry (same lock and atomic write as the registry); when the root differs
from the recorded one, `plan` prints one warning line and keeps the latest.
`finish` leaves the index alone. `projects` reads it and joins each entry
with what exists now: whether the root is still there, live seats from the
registry, finished seats from the archive, and whether the project's Grove
profile has overlays on.

## CLI

```text
de-novo skills dryad plan   ID (--task TEXT | --task-file PATH) [--worktree PATH | --resume]
                            [--owns CLAIM ... | --read-only] [--revision TEXT] [--input ID=SHA ...] [--by LABEL] [--apply]
de-novo skills dryad seat   ID [--json | --env | --shell | --task]
de-novo skills dryad report ID --status working|blocked|done [--note TEXT] [--session REF]
                            [--evidence PATH] [--accept-outside-scope]
de-novo skills dryad integrate ID --commit SHA [--by LABEL] [--note TEXT] [--apply]
de-novo skills dryad status [ID] [--json] [--finished]
de-novo skills dryad diff   ID [--json]
de-novo skills dryad finish ID [--apply]
de-novo skills dryad rebind [--apply]
de-novo skills dryad projects [--json]
```

| Verb | Without `--apply` | With `--apply` |
| --- | --- | --- |
| plan | prints worktree, branch, base, attempt, scope, env; creates nothing | `git worktree add` (or adopt `--worktree`), `overlay create` when the profile has overlays, register the seat. Attempt 1 takes the profile's branch template; attempt n takes `<template>-n`, and earlier branches are kept. A branch that already exists is refused by name, never overwritten. `--resume` continues the previous attempt on its own branch with its base unchanged. The slug must be bound to this repository (below) |
| seat | always read-only: the seat for a launcher | — |
| report | always writes the worker's status and a journal line. `done` also reads the seat's head, cleanliness, and touched paths into `result`, records `--evidence`, and holds the paths against the scope: a done that touched a path outside it is refused with the paths named (journalled as `report.refused`, status unchanged) until a person passes `--accept-outside-scope`. Done with uncommitted changes, or without evidence, is recorded and warned about, not refused | — |
| integrate | prints what would be recorded | records on the live seat, or the latest finished record of that id, the commit a squash or rebase gave its done result. A ref that is not a commit of this repository is refused |
| status | always read-only: counts and problems; non-zero on any problem. `--finished --tail N` reads the newest N archived records and says the total, so a reader knows the view is partial. Counts every worktree of the repository (`worktrees n (m unseated)`) and the paths two seats both hold (`overlaps n`, then one `overlap <path> <id> · <id>` line each). With `overlay.create_on: attach` a seat's env shows `unattached` until its first attach and is not a problem. Another seat's in-flight overlay mutation is shown as `in-flight`, not counted as a problem; a stalled one is. An overlap is a fact, not a problem: it never changes the exit code | — |
| diff | always read-only: the seat's whole difference from its base as one patch (`git diff <base>` in the worktree, so committed and uncommitted alike), then `untracked: <path>` lines; `--json` prints `{ id, worktree, base, head, patch, untracked, truncated }`, the patch capped at 512 KiB | — |
| finish | prints what would be destroyed or removed | `overlay destroy`, remove a clean Dryad-created worktree, move the seat and its journal to `<slug>.finished.yml`; branches kept |
| rebind | prints which repository the slug is bound to and which this checkout is | binds the slug to this checkout's repository. Refused while live seats from the other repository exist; the finished archive is kept as it was |
| projects | always read-only, machine-wide (no project needed): one counted line per indexed project — root, present or missing, `seats n`, `finished n`, `overlay on|off`; `--json` prints `{ projects: [ { slug, root, root_present, seats, finished, overlay, updated_at } ] }`; a missing index prints `projects 0` | — |

A slug is bound to one repository on this machine, identified by the root
commit of its history: `plan --apply` records it in the registry and the
project index. A different repository that borrowed the slug is refused by
name, so two projects never share one registry and archive by accident. A
moved checkout of the same history is not a different repository; `plan`
warns once about the moved root and carries on. `status --json` prints
`repository: { bound, checkout }` and lists a mismatch as a problem.


`status --json` adds four fields that no new tracking pays for — git and
Grove already know all of it:

| Field | Where | Shape |
| --- | --- | --- |
| `hostnames` | per seat | `[{ host, service, attached }]` — the overlay hostnames of the seat's env, read from Grove's `urls --env <id> --json` (Dryad renders no hostname itself). A project renders a hostname for every service; `attached` says which of them the overlay status inventory actually holds. Empty without a Grove profile, with overlays off, or while the env is pending; `attached` is `false` when the env is not tracked |
| `changes` | per seat | `{ base, committed: [{path, status, from?}], uncommitted: [{path, status, from?}], counts: { committed, uncommitted, ahead }, truncated }` from `git diff --name-status <base>..HEAD` and `git status --porcelain --untracked-files=all` in the seat's worktree; a rename or copy carries its source as `from`. The lists stop at 200 entries with `truncated: true`; the counts stay whole. `null` when the worktree is missing |
| `worktrees` | project | `[{ path, branch, head, seat, baseline }]` from the baseline's `git worktree list --porcelain`. `seat` is the seat id holding that path, or `null` — somebody works in parallel and Dryad does not know it. `changes` is computed for seats only: reading another person's worktree is not Dryad's business |
| `overlaps` | project | `[{ path, seats: [id, …] }]` for every path two or more of the listed seats have committed or uncommitted. Shown, never judged — who merges first is a person's call |
| `activity` | per seat | `{ state, doing, changed_at, events, transcript, session_id }` from the seat's events file: `state` is `running`, `idle`, `needs-input`, or `exited` from the last hook event; `doing` is the last tool event's name and target (`Edit app/api/server.mjs`); `changed_at` is the file's last write; `transcript` and `session_id` are what the tool's own hook payload named (Claude Code names both in every payload; a tool that does not leaves them `null`). `null` until a session has written. The text form appends `· now <doing>` to the seat line |

`status --json` also carries `overlay_report`: Grove's `overlay status
--json` report as Dryad read it for this status, or `null` when overlays
are off or no seat wanted an env, so a reader that needs Grove's view
takes Dryad's one observation instead of probing again.

Each seat in `status --json` and `seat --json` also carries `attempt`,
`resumed_from`, `scope`, `revision`, `inputs`, `result`, and `integration`
as the registry holds them.

`--project ROOT` names the baseline checkout. Omitted, Dryad uses
`DRYAD_PROJECT`, then the nearest `.agents/dryad-profile.yml` above the cwd.
A worker inside a worktree must rely on `DRYAD_PROJECT`, because the worktree
carries its own copy of `.agents/`.

Seat environment: `DRYAD_ID`, `DRYAD_ENV` (empty without overlays),
`DRYAD_BRANCH`, `DRYAD_PROJECT`, `DRYAD_SKILL` (the path to this skill's
SKILL.md inside the installed catalog, so the project need not vendor or
symlink it), `DRYAD_EVENTS` (the seat's events file, which the agent
tools' hooks append to), and `DRYAD_CLAUDE_SETTINGS` (a hooks file a
Claude Code launcher passes as `--settings`). `plan --apply` lays the two
files under `<state>/dryads/events/<slug>/`; `finish` removes them. Any
launcher that starts a tool with this environment, and `forester hooks
--apply` once per machine for tools other than Claude Code, gets the
seat's activity read back by `status`. The task text is not an environment variable; launchers read it
from `seat --json` or `seat --task`.

## Canopy

`de-novo skills canopy` serves a local overview at `http://127.0.0.1:7420/`.
Use `--port N` to choose another port, or `--once` to print the same state JSON
and exit. The page refreshes every five seconds; without JavaScript, reload
to refresh its server-rendered first view.

It reads only public CLI JSON: `dryad projects --json`, then per project
`dryad status --json` and `dryad status --finished --json --tail 20`. The
Grove report comes from the `overlay_report` that Dryad's status carries
(the one observation Dryad made, marked `observed_by: dryad status`);
`overlay status --json` is asked only when a Dryad old enough not to
carry it answered. A full view therefore costs one discovery and two
processes per project. The finished section shows the newest twenty
records and, when the archive is longer, `finished 20 of n (newest)`.
Each project shows its counts, Grove report and problems, then one card
per worktree: seats in
most-recent-journal order, followed by unseated worktrees. Seat cards show
the task's first line, status and last report, elapsed activity time, env
state, hostname links (unattached hosts are marked and not linked), journal
verb counts and last event, and committed/open file counts. Overlapping
paths appear first and are marked; each card lists at most 12 paths with a
remaining count. Project overlap lines name the seats sharing each path.
Unseated cards show only path, branch and HEAD, with no file inspection.
Older status JSON still renders the available seat cards and omits missing
fields. Sessions remain plain text.
Finished seats expand to show their journals. Failed or timed-out commands
appear as errors while other projects remain visible.

Every live seat card links to `/diff/<slug>/<id>`: the seat's work as
`dryad diff --json` reports it, one fold per file, additions and deletions
coloured, untracked files named, refreshed every five seconds; the chat
page and the diff page link to each other.

The chat and diff pages read one seat of one project (discovery, then
`dryad status <id> --json`), never every project on the machine, and
cannot show a seat the front page would not.

A seat card whose activity names a transcript links to `/chat/<slug>/<id>`:
the session's own transcript read where the tool left it and shown as a
chat, the person's turns and the agent's, each tool call one line that
opens to its input and result, newest at the bottom, refreshed every five
seconds. Nothing is copied; the page reads the file the tool named and
shows only seats the front page shows. A seat whose tool named no
transcript, or whose transcript is gone, answers 404 and says which.

Canopy never reads registry files directly, launches workers, writes reports,
changes worktrees, renews leases, or mutates environments or shared engines.
It accepts only GET requests, binds only to `127.0.0.1`, and refuses `--host`.

## Writing a seat brief

Before `plan`, read the project's working rules and verification instructions.
Inspect live seats with `de-novo skills dryad status --json` and read their
briefs with `de-novo skills dryad seat <id> --task`. Compare intended scope,
not just paths already changed: an empty diff does not mean its scope is free.

Write the brief with these fields, replacing placeholders with facts from the
project:

- **Outcome:** an observable result the worker can finish, with any necessary
  product decisions already settled.
- **Boundary:** the allowed paths and behavior in this seat's worktree, plus
  exclusions that keep it separate from other live seats.
- **Verification:** name the project's check or give its existing command and
  working directory, prerequisites, and expected counted result. Confirm the
  worker can run it alone with the seat's available resources. With no Grove
  environment, use the project's own applicable checks.
- **Report:** point to [Rules for a seated worker](../SKILL.md#rules-for-a-seated-worker)
  as the report and completion contract. The evidence goes in the file
  `report --status done --evidence <path>` takes: each check with its
  command, cwd, exit, and counted result; each unmeasured boundary with its
  reason; and the session id or transcript path through `--session`.
- **Forbidden actions:** reference those same worker rules for pushing,
  merging, `finish`, and writes to other worktrees; add any project-specific
  exclusions. Do not turn a task brief into a second lifecycle contract.

Reject the brief before seating if there is no verification the worker can
run alone, its allowed boundary overlaps another live seat, or its outcome
needs a decision the worker cannot make. Narrow or resequence overlapping
work, provide the missing verification resources, or resolve the decision
before assigning it. These are assignment checks, not new CLI guards.

These examples show the shape only. Replace every placeholder with a measured
project fact; each uses the report and forbidden-action references above.

> Outcome: correct the documented setup sequence. Boundary: `<guide path>`
> only. Verification: `<project documentation check>` from `<directory>`;
> record checked links and failures. Report: revision and check counts under
> the worker rules, with the session reference. Forbidden: worker-rule
> restrictions plus changes to runtime files.

> Outcome: reproduce and fix `<already specified input behavior>`. Boundary:
> `<module path>` and `<its test path>`, disjoint from live seats. Verification:
> `<focused project check>` with `<seat-local fixture>`; observe the specified
> result before and after. Report: revision, reproduction and check counts
> under the worker rules, with the session reference. Forbidden: worker-rule
> restrictions plus changes to the public interface.

Save the completed brief as a task file and pass it through `--task-file`, or
use `--task` for a short brief; give the boundary to Dryad as well with
`--owns` (or `--read-only`), so the done report is held against it. Under
Forester the brief is the item's `brief` file and the handoff is generated.
Review the printed plan against its boundary before applying it; launcher
handoff follows below.

## Handing a seat to a launcher

```bash
# a person in a terminal
eval "$(de-novo skills dryad seat w1 --shell)" && <your agent cli>

# a launcher that makes its own worktrees: adopt it
de-novo skills dryad plan w2 --worktree <path-the-launcher-made> --task-file tasks/w2.md --by codex --apply

# a script
de-novo skills dryad seat w3 --json | my-launcher --stdin

# an agent CLI that takes the first prompt as an argument
eval "$(de-novo skills dryad seat w1 --shell)" && <agent> "$(de-novo skills dryad seat w1 --task)"
```

First-run prompts belong to the launcher. Claude Code and Codex both ask
whether to trust a directory the first time they open it; a person or the
launcher answers that, not Dryad.
