# Mycelium — the envelope, the transitions, the query

Pattern: [SKILL.md](SKILL.md). This file owns the fields, the three
transitions, the query, and the CLI. Reasons:
[`docs/mycelium-design.md`](../../docs/mycelium-design.md).

```
worker (any seat) ──▶ propose ──▶ staging ──▶ commit (judge) ──▶ active
                                     ▲            │                │
              amend <id> (a corrected copy) ──────┘   invalidate ◀─┘
                                                      (valid_to = now, reason kept)

dryad report --status done ──▶ propose --from-seat <id>   (the Forester seam, read-only)
```

## Values

`.agents/mycelium.yml`, tracked. The project's vocabulary.

```yaml
version: 1
domains: [sprint, auth, payments]
types: [spec, sprint, issue, decision, module, blocker, agent, check]
judges: [human:jane, agent:judge]     # optional
```

| Field | Meaning |
| --- | --- |
| `domains` | Where a fact belongs. Every assertion names exactly one. Non-empty list of lower-case tokens |
| `types` | The entity types a subject or object may have. Non-empty list of lower-case tokens |
| `judges` | Writer ids that may `commit` and `invalidate`. Omitted, any named writer may. Everyone may `propose` and `amend` |

Unknown keys are rejected. Start with five to ten types; add one when a
proposal is refused for lacking it, not before.

## Writers

Every line names who wrote it. A writer id is a short handle such as
`human:jane`, `seat:api-endpoint`, or `agent:judge`. The writer is found
in this order, and a run that reaches the end is refused:

1. `--by <id>`.
2. `seat:<DRYAD_ID>`, when the environment carries it.
3. `seat:<id>` for the seat whose worktree holds the current directory,
   read from the Dryad registry. A worker standing in its own worktree
   needs nothing else.

An id with spaces or capitals is refused wherever it comes from.

The id is declared, not authenticated. `judges` says who the project
trusts to promote; it does not stop a process from claiming an id. On a
shared machine that trust is the same trust Dryad's registry already
rests on.

Inside a playground sandbox the catalog's guard strips every `DRYAD_*`
variable from a verb aimed at the sandbox; a seat there is still found
by its worktree. Measured 2026-09-08:
[evidence](../../docs/evidence/2026-09-08-mycelium-sandbox.md).

## Log

`<state>/mycelium/<slug>.jsonl`. `<state>` is `GROVE_STATE_DIR` when set,
otherwise `~/.dev-infra`, the same root Dryad's registry lives under; the
slug is the project's Dryad slug. One JSON object per line, append-only:

| `op` | Fields | Effect in the fold |
| --- | --- | --- |
| `propose` | `at`, `by`, `assertion` | the assertion exists, status `staging` |
| `commit` | `at`, `by`, `id`, `supersedes`, `amends` | `id` becomes `active`; each id in `supersedes` becomes `invalid`, closed at the new fact's `valid_from` (or `at` when that is earlier); `amends`, if set, becomes `invalid` with `valid_to = valid_from`, an empty interval |
| `invalidate` | `at`, `by`, `id`, `reason` | `id` becomes `invalid` with `valid_to = at` and the reason kept |

Every line carries `v: 1`. The graph is the fold of the lines in order and
nothing else.

## Envelope

| Field | Meaning | Default |
| --- | --- | --- |
| `id` | Stable id, `a-` and ten hex digits | generated |
| `s` | Subject. Always an entity | required |
| `p` | Predicate. A short verb phrase | required |
| `o` | Object. An entity when `o_type` is set, otherwise a literal | required |
| `s_type` | The subject's type, from `types` | required |
| `o_type` | The object's type, from `types` | null (literal) |
| `domain` | From `domains` | required |
| `confidence` | 0 to 1 | 0.5 |
| `valid_from` | When the fact became true (ISO-8601) | `tx_at` |
| `valid_to` | When it stopped; null while it holds | null |
| `tx_at` | When it was written | now |
| `source` | Where it was read: a path and line, a PR, a seat report, a check line | required |
| `agent_id` | Who proposed it | `--by`, or `seat:<DRYAD_ID>` |
| `model` | The model behind the agent, when there is one | null |
| `amends` | The id this assertion corrects, set by `amend` | null |
| `status` | `staging`, `active`, `invalid` | `staging` |

## Transitions

| From | To | Verb | Rule |
| --- | --- | --- | --- |
| — | staging | `propose` | domain and types must be declared; source and agent must be named |
| staging, active | staging (a new id) | `amend` | a copy with the passed fields changed and `amends` set; the original is untouched until the copy is committed |
| staging | active | `commit` | an active fact with the same domain, subject, predicate and a different object is a conflict, refused unless `--supersede`, which invalidates it in the same line; the same object is a duplicate and is refused; the fact named in `amends` is not a conflict and is closed by the commit |
| staging, active | invalid | `invalidate` | requires `--reason`; sets `valid_to` to now |

There is no transition out of `invalid`. Propose again. `commit` and
`invalidate` are the judge's when `judges` is declared.

Correction versus replacement: a fact that was **wrong** is amended, and
its interval is emptied, so no moment ever answers with it. A fact that
**stopped being true** is superseded or invalidated, and its interval is
kept, so the moment it held still answers with it.

## Commit rules

What a person or the judge promotes, and what stays out of the log.

Kept:

- A locked design decision or constraint.
- A sprint goal, a definition of done, a ticket's state change.
- A verified cause of a bug, and a regression risk.
- A dependency or a blocker between lanes.
- A check's pass or fail, as one line, not the output.
- An approach that was tried and failed, so it is not tried twice.

Not kept:

- Listings, formatting, build output.
- A file hunk, a sketch, a draft.
- A chat transcript or a token count.
- A seat's heartbeat; Dryad's journal has it. Point at the seat instead.

## Query

| Filter | Meaning |
| --- | --- |
| `--s`, `--p`, `--o`, `--domain` | exact match |
| `--type T` | subject or object has type T |
| `--status` | one status; default `active` |
| `--at ISO` | what was held at that moment: `valid_from <= at < valid_to`, over facts that were committed, invalidated since or not. Staging never answers `--at` |
| `--below N` | confidence below N |

Rows come back in `tx_at` order. `--json` prints the envelopes; `--ids`
prints one id per line for a shell loop.

## CLI

`de-novo skills mycelium <verb>`. Every verb takes `--project ROOT`;
without it the Dryad profile above the current directory names the project.

| Verb | Writes | Prints |
| --- | --- | --- |
| `propose --s --p --o --s-type --domain --source [--o-type] [--confidence] [--model] [--valid-from] [--by]` | one `propose` line | the id and one row |
| `propose --from-seat ID --s-type --domain [--by]` | one `propose` line: `s` is the seat id, `p` is `reported`, `o` is the done report, `source` and `valid_from` are that report | the id and one row |
| `amend <id> [any envelope field] [--by]` | one `propose` line whose assertion copies `<id>` with the passed fields changed and `amends` set; refuses an invalid `<id>` and a call that changes nothing | the new id and one row |
| `commit <id> [--supersede] [--by]` | one `commit` line | the id, what it superseded, what it amended |
| `invalidate <id> --reason TEXT [--by]` | one `invalidate` line | the id and the reason |
| `query [filters] [--json]` | — | `n assertions`, one row each |
| `status [--json]` | — | the log path, the vocabulary, the judges, `assertions n · active a · staging s · invalid i`, and how many staging rows sit below 0.5 |

The writer is found as Writers above says.

## Apply to a project

1. Write `.agents/mycelium.yml` with the domains and the first types.
   Copy [examples/mycelium.yml](examples/mycelium.yml) and cut it down.
2. Load the skill through `.agents/skills/mycelium` the way the project
   loads the others.
3. Run `mycelium status`. It prints the log path and zero counts.
4. Propose one fact from a source you can point at, commit it as a person,
   query it back. That cycle is the evidence the project has the skill.

## Not measured yet

Two writers appending in the same instant on one machine, the log on a
second machine, and the fold over more lines than fit in memory. The design
note names them as later work.
