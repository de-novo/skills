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
    owns: [docs/reference/**]
  api-endpoint:
    task: "Add the endpoint returning that shape"
    owns: [src/api/**]
    depends_on: [define-shape]
  web-panel:
    task: "Show it in the page"
    owns: [src/web/**]
    depends_on: [define-shape]
    retry: { max_attempts: 2 }
```

| Field | Meaning |
| --- | --- |
| `tasks.<id>` | The item id. It becomes the Dryad seat id, so it is a DNS label of at most 63 characters |
| `task` | One line a worker is seated with. Required |
| `owns` | Paths or globs the item expects to edit. A claim, not a lock. Default none |
| `depends_on` | Item ids that must be done first. Unknown ids, self-dependencies, and cycles are rejected with the ids named |
| `tool` | The name of a template under `tools` in the local file, used by `serve` to start the item's session; other verbs pass it through. Omitted, the local file's `tool` applies |
| `retry.max_attempts` | How many seats may be finished without a done report before the item is `failed`. Default 1 |
| `parallel` | The project's budget. Optional |

Unknown keys anywhere are rejected. Items are kept in declared order.

## Local file

`.agents/forester.local.yml`, gitignored by the catalog's `*.local.yml` rule.

```yaml
version: 1
parallel: 3
tool: claude                      # default tool for items that name none
tools:
  claude:
    command: [claude, "{task}", "--permission-mode", "acceptEdits"]
  codex:
    command: [codex, "{task}"]
```

Budget resolution: the plan's `parallel` if set, else the local file's, else
an error that names both files.

| Field | Meaning |
| --- | --- |
| `parallel` | This machine's budget |
| `tool` | The tool an item runs when it names none |
| `tools.<name>.command` | The tool's argv; `{task}` is replaced by the item's task line. Only `serve` reads it. Which tools a machine has is a machine fact, so the templates live here and never in the plan |

## Item states

Computed from the plan, Dryad's live registry, and its finished archive.

| State | When |
| --- | --- |
| `done` | The seat with the item's id reported done, live or in the finished archive |
| `active` | A live seat with the item's id exists and has not reported done |
| `failed` | No live seat, no done, and as many finished seats as `max_attempts` |
| `blocked` | Some `depends_on` is not done |
| `ready` | Everything else |

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
de-novo skills forester hooks  [--apply | --remove --apply] [--json]
```

| Verb | Without `--apply` | With `--apply` |
| --- | --- | --- |
| plan | one line per item: id, state, why; then `items n · done a · active b · ready c · blocked d · failed e` | — |
| next | `assign <id>` and `hold <id> <reason>` lines, then `would assign k/free; changes nothing` | — |
| assign | same as next | runs `dryad plan <id> --task <task> --by forester --apply` for each chosen item; prints `assigned k/n · slots a/parallel`; non-zero if any seat failed to plan |
| status | `slots a/parallel`, `waiting r ready · b blocked`, `done d/n`, `failed f`, `outside n` seats the plan does not name, and `serve` with one line per live session: tool, state, and what it is doing with its age; non-zero when any item is failed. `--watch` redraws the text form every two seconds until Ctrl-C | — |
| serve | foreground daemon: every poll it does what `assign --apply` does, starts the tool of each active item as a real interactive session in a pseudo-terminal it holds, reads the tool's hook events, closes a session whose seat reported done, and serves `attach`. Ctrl-C closes every session and removes its snapshot and socket. Refuses to start when another serve runs for the project | — |
| attach | connects to one live session: recent output is replayed, keys go to the tool, Ctrl-] detaches and the session keeps running. A closed session is refused by name | — |
| hooks | one row per tool store: `codex`, `grok`, `cursor-agent`, `opencode`; whether it is present, installed, or absent, and what `--apply` would do. A tool whose home is missing is skipped. `--remove --apply` takes back exactly the marked entries | writes one marked entry per event into each present store, keeping the person's own entries, atomically; a store that is not JSON is refused by name |

## Sessions

`serve` records a snapshot at `~/.dev-infra/foresters/<slug>.yml`
(`GROVE_STATE_DIR/foresters/` under the override) with its pid, its socket,
and one record per session: `tool`, `state`, `since`, `pid`, `exit`,
`events`, `note`, `doing`, `doing_since`. `doing` is the last tool event's name and target (`Edit app/api/server.mjs`, `Bash node tools/overlay.mjs attach …`), read from the session's hook events and never from the worker's own report; `doing_since` is when it last changed. `status` prints it after the state with its age. `status` reads it and shows `stale snapshot` when that pid
is gone. The socket is a short hashed name under the OS temp dir, because a
unix socket path is capped near 100 bytes.

| Session state | Evidence |
| --- | --- |
| `starting` | Spawned; no hook event yet |
| `running` | A `UserPromptSubmit`, `PreToolUse`, or `PostToolUse` hook |
| `idle` | A `Stop` or `StopFailure` hook: the turn ended |
| `needs-input` | A `Notification` hook whose type is `permission_prompt`, `idle_prompt`, or `elicitation_dialog`; a `PermissionRequest` hook; or, while still `starting`, a screen whose last lines ask to confirm or cancel (a dialog before the first prompt, where no hook can fire) |
| `exited` | The process ended on its own; `exit` carries the code |
| `closed` | serve ended it: the seat reported done, or serve stopped |

Each session's events go to the seat's own file, `DRYAD_EVENTS`, laid by Dryad at `plan --apply` and read back by `dryad status`, so a session serve holds and one another launcher started look the same. Claude Code sessions get their hooks through `--settings <file>`, the seat's `DRYAD_CLAUDE_SETTINGS`, never into the worktree or the person's own settings.
Before launch the seat's worktree is pre-trusted in Claude's own state file
(`projects[<path>].hasTrustDialogAccepted`, honouring `CLAUDE_CONFIG_DIR`),
the way Claude's own error message says to; nothing is written when that
file does not exist.

Every other tool reads hooks from a store that is global to the person's
account, so `hooks --apply` writes them once, and every entry is gated on
`FORESTER_EVENTS`: outside a serve session the hook consumes its input and
does nothing. The hook command appends one JSON line naming the event to
the seat's events file, which starts empty at every launch. Event names
are compared on letters only, because Grok writes `user_prompt_submit`
where the others write `UserPromptSubmit`.

| Tool | Store | Hooks | Once per store |
| --- | --- | --- | --- |
| claude | per-session `--settings` file | UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd, Notification | trust dialog seeded; "external CLAUDE.md imports" dialog is a person's answer |
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
items: [{ id, state, why, task, owns, depends_on, tool, attempts,
max_attempts, seat, session: { tool, state, since, pid, exit, events, note, doing, doing_since } | null }], next: [id], held: [{ id, reason }], slots: {
active, free, parallel }, seats_outside_plan: [id], serve: { pid, alive,
socket } | null }`. `assign --apply --json` adds `assigned` and `failed`.
