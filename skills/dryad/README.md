# Dryad

A de-novo skill. One seat per worker on Grove's ground.

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

Pattern: [SKILL.md](SKILL.md). Grove: [../grove/](../grove/README.md).
Dryad launches no agent. It prepares the seat, hands it to whatever launcher
the human uses, counts what workers report, and clears the seat afterwards.

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
launcher's own setting, not a Dryad value. Example: [examples/](examples/).

## Registry

`~/.dev-infra/dryads/<slug>.yml` (`GROVE_STATE_DIR/dryads/` when the override
is set). One record per seat: worktree, `owned` (created by Dryad or
adopted), branch, base commit, task, env (`null`, `pending`, or the env
name), `by`, `session`, `status`, and an append-only `journal` of what Dryad
did and what the worker reported. The registry mirrors state; it does not
repair it. `finish` moves the record to `<slug>.finished.yml` next to it;
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
de-novo skills dryad plan   ID (--task TEXT | --task-file PATH) [--worktree PATH] [--by LABEL] [--apply]
de-novo skills dryad seat   ID [--json | --env | --shell | --task]
de-novo skills dryad report ID --status working|blocked|done [--note TEXT] [--session REF]
de-novo skills dryad status [ID] [--json] [--finished]
de-novo skills dryad finish ID [--apply]
de-novo skills dryad projects [--json]
```

| Verb | Without `--apply` | With `--apply` |
| --- | --- | --- |
| plan | prints worktree, branch, base, env; creates nothing | `git worktree add` (or adopt `--worktree`), `overlay create` when the profile has overlays, register the seat |
| seat | always read-only: the seat for a launcher | — |
| report | always writes the worker's status and a journal line | — |
| status | always read-only: counts and problems; non-zero on any problem. With `overlay.create_on: attach` a seat's env shows `unattached` until its first attach and is not a problem. Another seat's in-flight overlay mutation is shown as `in-flight`, not counted as a problem; a stalled one is | — |
| finish | prints what would be destroyed or removed | `overlay destroy`, remove a clean Dryad-created worktree, move the seat and its journal to `<slug>.finished.yml`; branches kept |
| projects | always read-only, machine-wide (no project needed): one counted line per indexed project — root, present or missing, `seats n`, `finished n`, `overlay on|off`; `--json` prints `{ projects: [ { slug, root, root_present, seats, finished, overlay, updated_at } ] }`; a missing index prints `projects 0` | — |

`status --json` gives every seat a `hostnames` list: the overlay hostnames of
its env, read from Grove's `urls --env <id> --json` (Dryad renders no
hostname itself). The list is empty when the project has no Grove profile,
overlays are off, or the seat's env is pending.

`--project ROOT` names the baseline checkout. Omitted, Dryad uses
`DRYAD_PROJECT`, then the nearest `.agents/dryad-profile.yml` above the cwd.
A worker inside a worktree must rely on `DRYAD_PROJECT`, because the worktree
carries its own copy of `.agents/`.

Seat environment: `DRYAD_ID`, `DRYAD_ENV` (empty without overlays),
`DRYAD_BRANCH`, `DRYAD_PROJECT`, and `DRYAD_SKILL` (the path to this skill's
SKILL.md inside the installed catalog, so the project need not vendor or
symlink it). The task text is not an environment variable; launchers read it
from `seat --json` or `seat --task`.

## Canopy

`de-novo skills canopy` serves a local overview at `http://127.0.0.1:7420/`.
Use `--port N` to choose another port, or `--once` to print the same state JSON
and exit. The page refreshes every five seconds; without JavaScript, reload
to refresh its server-rendered first view.

It reads only public CLI JSON: `dryad projects --json`, each project's
`dryad status --json` and `dryad status --finished --json`, and
`overlay status --json` for projects with overlays. The page shows counts,
seats, journals, sessions, hostname links, Grove reports, and problems.
Finished seats expand to show their journals. Failed or timed-out commands
appear as errors while other projects remain visible.

Canopy never reads registry files directly, launches workers, writes reports,
changes worktrees, renews leases, or mutates environments or shared engines.
It accepts only GET requests, binds only to `127.0.0.1`, and refuses `--host`.

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

## Apply to a project

1. Plant Grove first ([grove README](../grove/README.md#apply-to-a-project)).
   Dryad needs `project.slug` from `runtime-profile.yml`.
2. Write `.agents/dryad-profile.yml` with a `worktrees` section, or none if
   every seat will be adopted.
3. Symlink the skill: keep the canonical copy under `.agents/skills/dryad`
   and symlink tool-specific dirs to it. Never copy the body.
4. `de-novo skills dryad plan <id> --task … ` to see the plan, then `--apply`.

Design record and the reasons behind "no launcher": [docs/dryad-design.md](../../docs/dryad-design.md).
Contributing: [root AGENTS.md](../../AGENTS.md).
