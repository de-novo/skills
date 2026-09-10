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
