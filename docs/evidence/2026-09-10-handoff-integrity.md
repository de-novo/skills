# Handoff integrity: identity, results, integration gate, scope, trust

Date 2026-09-10. Audited base `3ccdbdaf5474bc688e0a3c56721c77e30124adb2`
(the checkout was exactly that commit and clean when the baseline ran).
This file records the work packages WP-00 to WP-04 of the improvement
brief: the baseline, the reproductions, what changed, what was executed,
and what was not measured. Later packages append their own sections.

## WP-00: baseline

Environment: macOS (Darwin 25.5.0), Node v26.8.1, npm 11.19.0. The
catalog's CI runs Node 24 on Linux; that matrix was not run here.

| Command | Observed |
| --- | --- |
| `npm test` | 286 tests, 286 pass, 0 fail |
| `node infra/bin/cli.mjs --help` | exit 0 |
| `node infra/bin/cli.mjs herbarium check` | links 229/229, anchors 19/19, pages 7/7 |
| `bash -n infra/bin/provision` | exit 0 |
| `validate` on both `skills/grove/examples/*.runtime-profile.yml` | 2/2 |

The four audit reproductions were moved from the brief's copied functions
into `infra/bin/integrity.test.mjs`, which runs the real CLI in a
throwaway repository. On the base the file fails to load (1 red: the
identity export does not exist), so every case was red before the change.

## What changed

- **Identity (F02).** Each item has a revision: a digest of its title,
  brief digest, claims, `read_only`, dependencies with their kinds, the
  result heads it starts from, `verify`, and the repository's root commit.
  Dryad stores the planner's `--revision` on the seat. An archived done
  counts only for the same revision; a record without one is shown and
  never reused. A slug is bound to one repository; another repository
  with the same slug is refused until `dryad rebind`.
- **Results and the integration gate (F01).** `report --status done`
  records the seat's own head, cleanliness, touched paths, and the
  `--evidence` file. A bare `depends_on` needs that result in the
  dependent's base: ancestry of the reported head, or of a commit a
  person recorded with `dryad integrate`. Until then the item is
  `waiting` and says what to do. `{ item, needs: order }` needs only the
  report. Forester merges nothing.
- **Attempts (F04).** Attempt n takes `<branch>-n`; earlier branches are
  kept; an existing branch is refused by name; `--resume` continues the
  previous attempt's branch.
- **Claims and scope (F07).** `owns` is normalized and validated
  (`infra/lib/claims.mjs`); a done that touched paths outside the seat's
  scope, rename sources and untracked files included, is refused until
  `--accept-outside-scope`.
- **Trust (F03, WP-01).** `serve` no longer writes Claude's state file by
  default; `tools.<name>.pretrust_worktrees: true` is the explicit opt-in.
- **Handoff (F06, WP-04).** Seats get a generated handoff: title,
  revision, base, scope, dependency inputs, `verify`, report line, and the
  `brief` file's text under its path and digest.

## What was executed

Working tree on branch `feat/handoff-integrity`, uncommitted at the time of
measurement.

```text
npm test                                  295/295 (286 before; 9 new in infra/bin/integrity.test.mjs)
node --test infra/bin/integrity.test.mjs  9/9
node infra/bin/cli.mjs herbarium check    links 229/229 · anchors 19/19 · pages 7/7
validate skills/grove/examples/*          2/2
bash -n infra/bin/provision               exit 0
git diff --check                          clean
```

Guard reversals, each reverted alone with the other changes in place,
`integrity.test.mjs` run, then restored:

| Guard reverted | Red |
| --- | --- |
| archived done must match the revision | 1 |
| a result must be an ancestor of the baseline HEAD | 2 |
| done with uncommitted changes is not a usable result | 1 |
| done outside the scope is refused | 1 |
| attempt n takes its own branch | 1 |
| serve seeds trust only when opted in | 1 |

The serve case launches a real pseudo-terminal session through a tool
named `claude` (a wrapper around the fixture tool) with `CLAUDE_CONFIG_DIR`
pointed at a throwaway state file, and hashes that file before and after.

## Not measured

- A real Claude Code or Codex session on the trust dialog: the wrapper
  stands in for the tool at the seams serve reads, not for the dialog.
- Node 24 on Linux (the CI matrix) and Windows paths.
- The existing serve test now refills with `docs-pass` rather than
  `api-endpoint`, because the fixture's done commits inside its scope and
  `api-endpoint` waits for a merge; a person merging in the middle of a
  serve run was not exercised.
- Registries written before this date: read as before, with the new
  fields absent; no migration was run against one.

## WP-05: a launch that can fail names its failure and waits for a person

`infra/lib/forester-serve.mjs`: readiness is checked before anything is
spawned (tool declared, executable on PATH, worktree present, env not
pending) and a failed check is a `failed` session with `failure.kind`; a
pending overlay env is planned again with a doubling wait, capped, five
times, then marked failed; `forester restart <id>` drops a failed or
exited session so the next poll launches it, and refuses a live one; the
daemon holds a lock for its lifetime, linked into place with its pid
already written and reclaimed only from a dead pid; a socket that answers
is never unlinked; a daemon started after a crash names the sessions the
previous one held and launches them again as fresh contexts.

```text
node --test infra/bin/forester-serve.test.mjs   6/6 (real pseudo-terminals; the pending case drives the process overlay backend)
npm test                                        301/301
```

| Guard reverted | Red |
| --- | --- |
| readiness check before spawn | 1 |
| a pending env is not launched into | 1 |
| the serve lock (unit) | 1 |
| fresh-context note after a crash | 1 |
| restart refuses a live session | 1 |

One full-suite run timed out the existing serve viewer at sixty seconds
under parallel load; the same file passes alone and with the other
pseudo-terminal files, and the next full run passed 301/301. The viewer
timeout is now two minutes. Not measured: a real agent tool exiting on
its own mid-task; the lock across two machines sharing a state directory
(the lock trusts its hostname).

## WP-06: one machine cap over every project

`infra/lib/forester.mjs`: the cap, the reservations taken under one lock
before seating, what holds a reservation and what makes it stale, and the
unmanaged seats are specified in the Forester reference's machine-cap
section; the plan's own `parallel` still bounds the plan.

```text
node --test infra/bin/forester-machine.test.mjs   3/3 (two projects on one state directory; three rounds of two assigns at the same instant)
npm test                                          304/304
```

| Guard reverted | Red |
| --- | --- |
| allocate stops at the cap | 2 |
| reserve refuses at the cap | 2 |
| reserve takes the lock | 1 |
| an in-flight reservation is held while its owner lives | 2 |
| stale reservations are dropped | 3 |

The concurrent case found a defect in the first draft: a reservation was
reclaimed as stale in the window between reserving and planning the
seat, so two projects each got the one slot. Held reservations now carry
the reserving pid and host and are kept while that process lives. Not
measured: two machines sharing one state directory (the liveness check
trusts its hostname); a cap on anything other than seats.

## WP-07: one statement of each boundary

Root README: seven skills, Clearing and Herbarium in the flow diagram;
launching named as one explicit boundary (`forester serve` is the one
launcher here; Dryad never launches); merging and integration named as a
person's; the no-Skill-tool fallback stated once. Forester: the allocator
is pure, the runner stateful; "Specify first" replaces "Grill first": a
brief that settles goal, scope, verification, and permissions is used as
written, and only destructive, costly, irreversible, or ambiguous choices
are questions; the split is confirmed, not re-interviewed, when the person
gave the items. Dryad: rule 1 separates source writes from writes through
an owner's own verb. Mycelium: the seam takes done or blocked; the lock
wait reads fifteen seconds, as the code has since 2026-09-09. The catalog
test now requires exactly the seven skills the README names.

```text
node --test infra/bin/catalog.test.mjs infra/bin/herbarium.test.mjs   14/14
node infra/bin/cli.mjs herbarium check                                  links 230/230 · anchors 19/19 · copies 0 near
```

Not measured: whether an agent reading the new Forester text asks fewer
questions on a complete brief; that is the evaluation package's to
measure with a cold session.
