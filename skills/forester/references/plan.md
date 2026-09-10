# Forester — the plan, the budget, the allocator

The long facts of Forester: the fields, the allocation rule, the CLI, the
sessions. Pattern: [SKILL.md](../SKILL.md). The human page:
[README.md](../README.md). Reasons: [`docs/forester-design.md`](../../../docs/forester-design.md).

```
goal ──(an agent reading the skill)──▶ .agents/forester-plan.yml
                                              │
             .agents/forester.local.yml ──▶ allocate ──▶ dryad plan <id> --apply
             (parallel, this machine)          ▲                 │
                                               └── dryad report ─┘
```

## Plan

`.agents/forester-plan.yml`, tracked.

```yaml
version: 1
parallel: 2                       # optional; when set, this project's budget
tasks:
  define-shape:
    task: "Decide the response shape and write it into the reference"
    brief: briefs/define-shape.md   # optional; the full seat brief, tracked
    owns: [docs/reference/**]
    verify: ["npm run docs:check"]
  api-endpoint:
    task: "Add the endpoint returning that shape"
    owns: [src/api/**]
    depends_on: [define-shape]      # needs define-shape's result in its base
  web-panel:
    task: "Show it in the page"
    owns: [src/web/**]
    depends_on: [{ item: define-shape, needs: order }]   # only after its report
    retry: { max_attempts: 2 }
  review-notes:
    task: "Read the three seats and write the review"
    read_only: true
```

| Field | Meaning |
| --- | --- |
| `tasks.<id>` | The item id. It becomes the Dryad seat id, so it is a DNS label of at most 63 characters |
| `task` | The item's title, one line. Required. The seat is given the handoff below, which begins with it |
| `brief` | A file under the baseline checkout holding the full brief (outcome, boundary, verification, report, forbidden). Copied into the handoff with its path and digest; the file stays the one place to edit. Optional |
| `owns` | Paths or globs the item expects to edit, relative to the repository root, using only `**`, `*`, `?`. Spellings are normalized (`./src//api/` is `src/api`); absolute paths, `..`, backslashes, and `{}` `[]` `!` forms are rejected by name. A claim, not a lock. Default none, which means the seat's scope is unchecked |
| `read_only` | `true` for an item that edits nothing. Its seat's scope is empty and checked: a done that touched any path is refused. Excludes `owns` |
| `depends_on` | Items that come first. A bare id needs the item's **result** in this item's base (see Item states); `{ item: <id>, needs: order }` needs only its done report. Unknown ids, self-dependencies, duplicates, and cycles are rejected with the ids named |
| `verify` | Commands the worker runs and records in its evidence. Named in the handoff, not run by Forester |
| `tool` | The name of a template under `tools` in the local file, used by `serve` to start the item's session; other verbs pass it through. Omitted, the local file's `tool` applies |
| `retry.max_attempts` | How many seats for this revision of the item may be finished without a done report before the item is `failed`. Default 1 |
| `parallel` | The project's budget. Optional |

Unknown keys anywhere are rejected. Items are kept in declared order.

## Identity

An item's **revision** is a 16-hex digest of what makes the task this task:
the title (whitespace aside), the brief's digest, the sorted claims,
`read_only`, the dependencies with their kinds, the results it starts from
(each result dependency's head), `verify`, and the repository's root
commit. `forester plan --json` prints it per item; `assign` and `serve`
hand it to Dryad as the seat's `revision`. A seat, live or archived, counts
for an item only when its revision is the item's current one. Editing a
task, its claims, or a dependency's result changes the revision, so an
earlier done is not inherited by the new task. A finished seat planned
before revisions existed, or by hand without one, is shown as such and
never reused as done; it does spend an attempt.

## Handoff

`assign --apply` and `serve` seat an item with a generated text, readable
afterwards with `dryad seat <id> --task`: the title, the revision, the base
commit, the scope (`edit only …`, `read-only`, or `unchecked`), each
dependency with the result commit that is in the base or the note that only
its report was required, the `verify` commands, the report line, and the
brief's text under its path and digest. Dryad also records the scope
(`--owns` or `--read-only`), the revision, and the dependency inputs on the
seat.

## Local file

`.agents/forester.local.yml`, gitignored by the catalog's `*.local.yml` rule.

```yaml
version: 1
parallel: 3
tool: claude                      # default tool for items that name none
tools:
  claude:
    command: [claude, "{task}", "--permission-mode", "acceptEdits"]
    pretrust_worktrees: false     # default; true lets serve pre-trust seat worktrees
  codex:
    command: [codex, "{task}"]
```

Budget resolution: the plan's `parallel` if set, else the local file's, else
an error that names both files.

| Field | Meaning |
| --- | --- |
| `parallel` | This machine's budget |
| `tool` | The tool an item runs when it names none |
| `tools.<name>.command` | The tool's argv; `{task}` is replaced by the seat's handoff text. Only `serve` reads it. Which tools a machine has is a machine fact, so the templates live here and never in the plan |
| `tools.<name>.pretrust_worktrees` | `true` lets `serve` mark each seat's worktree as trusted in Claude Code's own state file before launch (see Sessions). Default `false`: nothing outside the state directory is written, and a trust dialog shows as `needs-input` |

## Item states

Computed from the plan, Dryad's live registry, its finished archive, and
the baseline's git facts (its HEAD, ancestry, each seat worktree's HEAD).
Dependencies resolve first, because an item's revision includes the
results it starts from.

| State | When |
| --- | --- |
| `done` | A seat with the item's id and its current revision reported done, live or in the finished archive, and its worktree still stands at the head the report recorded |
| `active` | A live seat with the item's id exists and has not reported done; or reported done and then moved (its `why` says `report again`); or holds another revision than the plan now has (`finish that seat`) |
| `waiting` | Every dependency reported done, and a result dependency is not usable yet: its head is not an ancestor of the baseline HEAD and no integration record names a commit that is, or it reported done with uncommitted changes, or with no result recorded. The `why` says what a person does next |
| `failed` | No live seat, no done, and as many finished seats for this revision (or without a revision) as `max_attempts` |
| `blocked` | Some `depends_on` is not done |
| `ready` | Everything else. A ready item carries `inputs`: each result dependency's head, which the seat records |

A **result** is what Dryad records at `report --status done`: the seat's
own head, whether the tree was clean, the paths touched, the evidence file.
It reaches a dependent item only through the baseline: a person merges the
branch (ancestry proves it), or, after a squash or rebase, records `dryad
integrate <id> --commit <sha> --apply` and that commit's ancestry proves
it. Forester never merges. `verification` per item is `unverified` (done
without evidence), `verified` (every check at exit 0), `failing` (a check
not at 0), or `accepted` (an integration is recorded).

## Allocation rule

1. Count the active items.
2. Walk the ready items in declared order.
3. Skip an item whose `owns` intersects an active or already chosen item's.
4. Stop when active plus chosen reaches `parallel`.

Two claims intersect when the path segments before the first wildcard of
one are a prefix of the other's: `src/api/**` and `src/web/**` do not,
`docs/**` and `docs/reference/**` do, `src/**/*.test.mjs` intersects
everything under `src/`. Conservative on purpose.

## CLI

```text
de-novo skills forester plan   [--json] [--project ROOT]
de-novo skills forester next   [--json] [--project ROOT]
de-novo skills forester assign [--apply] [--json] [--project ROOT]
de-novo skills forester status [--json | --watch] [--project ROOT]
de-novo skills forester serve  [--project ROOT]
de-novo skills forester attach ID [--project ROOT]
de-novo skills forester restart ID [--project ROOT]
de-novo skills forester hooks  [--apply | --remove --apply] [--json]
```

| Verb | Without `--apply` | With `--apply` |
| --- | --- | --- |
| plan | one line per item: id, state, why; then `items n · done a · active b · ready c · waiting w · blocked d · failed e` | — |
| next | `assign <id>` and `hold <id> <reason>` lines, then `would assign k/free; changes nothing` | — |
| assign | same as next | runs `dryad plan <id> --task <handoff> --by forester --revision <rev> [--owns … | --read-only] [--input <dep>=<sha> …] --apply` for each chosen item; prints `assigned k/n · slots a/parallel`; non-zero if any seat failed to plan |
| status | `slots a/parallel`, `waiting r ready · w waiting for integration · b blocked`, `done d/n`, `failed f`, `outside n` seats the plan does not name, and `serve` with one line per live session: tool, state, and what it is doing with its age; non-zero when any item is failed. `--watch` redraws the text form every two seconds until Ctrl-C | — |
| serve | foreground daemon: every poll it does what `assign --apply` does, starts the tool of each active item as a real interactive session in a pseudo-terminal it holds, reads the tool's hook events, closes a session whose seat reported done, and serves `attach` and `restart`. Before a launch it checks the tool is declared and on PATH, the worktree exists, and the seat's env is not pending; a failed check is a `failed` session naming its kind and nothing is spawned. A seat whose env is pending is planned again with a doubling wait (capped at a minute) up to five times, then marked `failed` (`env-pending`). Ctrl-C closes every session and removes its snapshot, socket, and lock. One serve per project: the second start stops at the lock (`<snapshot>.serve.lock`, reclaimed only from a dead pid) and removes nothing; a socket that answers is never unlinked. Started after a crash, it says which sessions the previous daemon held and launches them again as fresh contexts, never as native resumes | — |
| attach | connects to one live session: recent output is replayed, keys go to the tool, Ctrl-] detaches and the session keeps running. A closed session is refused by name | — |
| restart | asks serve to drop a `failed` or `exited` session so its next poll launches the item again (a pending env's retry count starts over). A live session is refused by name: nobody's work is restarted underneath them | — |
| hooks | one row per tool store: `codex`, `grok`, `cursor-agent`, `opencode`; whether it is present, installed, or absent, and what `--apply` would do. A tool whose home is missing is skipped. `--remove --apply` takes back exactly the marked entries | writes one marked entry per event into each present store, keeping the person's own entries, atomically; a store that is not JSON is refused by name |

## Sessions

`serve` records a snapshot at `~/.dev-infra/foresters/<slug>.yml`
(`GROVE_STATE_DIR/foresters/` under the override) with its pid, its socket,
and one record per session: `tool`, `state`, `since`, `pid`, `exit`,
`events`, `note`, `failure`, `doing`, `doing_since`. `doing` is the last tool event's name and target (`Edit app/api/server.mjs`, `Bash node tools/overlay.mjs attach …`), read from the session's hook events and never from the worker's own report; `doing_since` is when it last changed. `status` prints it after the state with its age. `status` reads it and shows `stale snapshot` when that pid
is gone. The socket is a short hashed name under the OS temp dir, because a
unix socket path is capped near 100 bytes.

| Session state | Evidence |
| --- | --- |
| `starting` | Spawned; no hook event yet |
| `running` | A `UserPromptSubmit`, `PreToolUse`, or `PostToolUse` hook |
| `idle` | A `Stop` or `StopFailure` hook: the turn ended |
| `needs-input` | A `Notification` hook whose type is `permission_prompt`, `idle_prompt`, or `elicitation_dialog`; a `PermissionRequest` hook; or, while still `starting`, a screen whose last lines ask to confirm or cancel (a dialog before the first prompt, where no hook can fire) |
| `exited` | The process ended on its own; `exit` carries the code, and `note` says `forester restart` launches it again |
| `closed` | serve ended it: the seat reported done, or serve stopped |
| `failed` | Nothing was spawned; `failure: { kind, note, at }` says why: `no-tool`, `tool-missing`, `env-pending`, `worktree-missing`, or `spawn-failed` |

Each session's events go to the seat's own file, `DRYAD_EVENTS`, laid by Dryad at `plan --apply` and read back by `dryad status`, so a session serve holds and one another launcher started look the same. Claude Code sessions get their hooks through `--settings <file>`, the seat's `DRYAD_CLAUDE_SETTINGS`, never into the worktree or the person's own settings.

Trusting a folder is a person's decision, not a launch's side effect. By
default serve writes nothing to Claude's own state file; a session parked
on the trust dialog shows as `needs-input`, and `forester attach <id>`
answers it. A machine that wants seat worktrees pre-trusted sets
`tools.<name>.pretrust_worktrees: true` in the local file; then, before
launch, only the seat's worktree is marked
(`projects[<path>].hasTrustDialogAccepted`, honouring `CLAUDE_CONFIG_DIR`),
the way Claude's own error message says to, atomically, and never when
that file does not exist. The serve log says `trust seeded` or `trust not
seeded` per launch.

Every other tool reads hooks from a store that is global to the person's
account, so `hooks --apply` writes them once, and every entry is gated on
`FORESTER_EVENTS`: outside a serve session the hook consumes its input and
does nothing. The hook command appends one JSON line naming the event to
the seat's events file, which starts empty at every launch. Event names
are compared on letters only, because Grok writes `user_prompt_submit`
where the others write `UserPromptSubmit`.

| Tool | Store | Hooks | Once per store |
| --- | --- | --- | --- |
| claude | per-session `--settings` file | UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd, Notification | trust dialog is a person's answer unless `pretrust_worktrees`; "external CLAUDE.md imports" dialog is a person's answer |
| codex | `$CODEX_HOME/hooks.json`, else `~/.codex/hooks.json` | UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop | Codex asks to review new hooks on the next launch ("Trust all and continue"); the screen fallback shows it as needs-input |
| grok | `~/.grok/hooks/de-novo-forester.json` (a file of its own) | the Claude set | none seen |
| cursor-agent | `~/.cursor/hooks.json` | beforeSubmitPrompt, preToolUse, postToolUse, stop, each writing the Claude-style name | none seen |
| opencode | `$OPENCODE_CONFIG_DIR/plugins/de-novo-forester.js`, else `~/.config/opencode/plugins/` | a plugin mapping session status and permission events to the same names | none seen |

Each session runs in the seat's worktree with `DRYAD_ID`, `DRYAD_ENV`,
`DRYAD_BRANCH`, `DRYAD_PROJECT`, `DRYAD_SKILL`, `FORESTER_SEAT`, and
`FORESTER_EVENTS`.

`--project ROOT` names the baseline checkout, as for Dryad; omitted, Forester
uses `DRYAD_PROJECT`, then the nearest `.agents/dryad-profile.yml` above the
cwd. A Dryad profile is required because seats are Dryad seats.

`--json` on any verb prints `{ project, budget: { parallel, source }, counts,
items: [{ id, state, why, task, brief, owns, read_only, depends_on, needs:
{ <id>: result|order }, verify, tool, revision, inputs: { <id>: sha },
attempts, max_attempts, result, integration, verification, seat, session:
{ tool, state, since, pid, exit, events, note, failure, doing, doing_since } | null
}], next: [id], held: [{ id, reason }], slots: { active, free, parallel },
seats_outside_plan: [id], serve: { pid, alive, socket } | null }`. `result`
and `integration` are the done seat's records as Dryad keeps them.
`assign --apply --json` adds `assigned` and `failed`.
