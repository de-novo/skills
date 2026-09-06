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
`runtime-profile.yml`. Allowed top-level keys: `version`, `worktrees`.

```yaml
version: 1                       # omitted = 1; other values rejected
worktrees:                       # omit when every seat adopts an existing worktree
  root: ../myproject-seats       # where plan creates worktrees; must be outside the checkout
  branch: "dryad/{id}"           # only {id} is substituted
```

Dryad reads the project slug and overlay mode from `runtime-profile.yml`.
There is no launcher configuration: which tool runs in a seat is the
launcher's own setting, not a Dryad value. Example: [examples/](examples/).

## Registry

`~/.dev-infra/dryads/<slug>.yml` (`GROVE_STATE_DIR/dryads/` when the override
is set). One record per seat: worktree, `owned` (created by Dryad or
adopted), branch, base commit, task, env (`null`, `pending`, or the env
name), `by`, `session`, `status`, and an append-only `journal` of what Dryad
did and what the worker reported. The registry mirrors state; it does not
repair it.

## CLI

```text
de-novo skills dryad plan   ID (--task TEXT | --task-file PATH) [--worktree PATH] [--by LABEL] [--apply]
de-novo skills dryad seat   ID [--json | --env | --shell]
de-novo skills dryad report ID --status working|blocked|done [--note TEXT] [--session REF]
de-novo skills dryad status [ID] [--json]
de-novo skills dryad finish ID [--apply]
```

| Verb | Without `--apply` | With `--apply` |
| --- | --- | --- |
| plan | prints worktree, branch, base, env; creates nothing | `git worktree add` (or adopt `--worktree`), `overlay create` when the profile has overlays, register the seat |
| seat | always read-only: the seat for a launcher | — |
| report | always writes the worker's status and a journal line | — |
| status | always read-only: counts and problems; non-zero on any problem | — |
| finish | prints what would be destroyed or removed | `overlay destroy`, remove a clean Dryad-created worktree, drop the seat; branches kept |

`--project ROOT` names the baseline checkout. Omitted, Dryad uses
`DRYAD_PROJECT`, then the nearest `.agents/dryad-profile.yml` above the cwd.
A worker inside a worktree must rely on `DRYAD_PROJECT`, because the worktree
carries its own copy of `.agents/`.

Seat environment: `DRYAD_ID`, `DRYAD_ENV` (empty without overlays),
`DRYAD_BRANCH`, `DRYAD_PROJECT`. The task text is not an environment
variable; launchers read it from `seat --json`.

## Handing a seat to a launcher

```bash
# a person in a terminal
eval "$(de-novo skills dryad seat w1 --shell)" && <your agent cli>

# a launcher that makes its own worktrees: adopt it
de-novo skills dryad plan w2 --worktree <path-the-launcher-made> --task-file tasks/w2.md --by codex --apply

# a script
de-novo skills dryad seat w3 --json | my-launcher --stdin
```

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
