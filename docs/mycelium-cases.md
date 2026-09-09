# Mycelium — the cases it must carry

Mycelium keeps a project's assertions in an append-only log. These cases
track its coverage as of 2026-09-09, including two implementation rounds
and the later notes pilot in a disposable sandbox. They describe observed
coverage and remaining limits, rather than a guarantee for every project.
Start with the [Mycelium introduction](../skills/mycelium/README.md);
the [reference](../skills/mycelium/references/log.md) owns the CLI and log
contract, and the [design](mycelium-design.md) explains the choices.

A **seat** is a worker's Git worktree and task, managed by Dryad. A
**judge** is a declared writer allowed to promote or invalidate assertions.
Forester holds the work plan; Understory renders its progress and links to
facts. A **slug** identifies a project's local state files.

Each row uses one of four marks:

| Mark | Meaning |
| --- | --- |
| **measured** | executed with readback in a sandbox seat, pilot, or catalog log; the source names the boundary |
| **tested** | exercised in automated library or CLI fixtures; no seat execution is claimed |
| **pattern** | supported by the documented workflow or implementation, without a dedicated execution claim |
| **gap** | the requested capability or evidence is missing; the row states the limit |

Evidence sources:

- [First-round sandbox record](evidence/2026-09-08-mycelium-sandbox.md):
  initial lifecycle, writer identity, and isolation observations.
- [Second-round record](evidence/2026-09-09-mycelium-round-2.md):
  case-numbered results, concurrency counts, and guard-reversal evidence.
- [Notes pilot](evidence/2026-09-09-notes-pilot.md): C8 and C10, including
  the human prompt that directed the blocked worker to a recorded fact.
- [Automated sandbox arc](../infra/bin/mycelium-arc.test.mjs) and
  [library and CLI tests](../infra/bin/mycelium.test.mjs): executable checks.
  The arc covers a subset of these rows; it does not replay the agent pilot.

## A. One fact's life

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| A1 | A seat finds something worth keeping | `propose` with source, type, domain | measured |
| A2 | The fact was wrong | `amend`: a copy that points back; original closed with an empty interval on commit | measured |
| A3 | The fact was true and stopped being true | `invalidate --reason`; interval kept | measured |
| A4 | A newer fact replaces an older one on the same subject and predicate | `commit --supersede`; old closed at the new `valid_from`, or commit time if the replacement predates the old fact | measured |
| A5 | The same fact is proposed twice by two seats | second `commit` refused as a duplicate | measured |
| A6 | Two seats propose contradicting objects, neither committed yet | both sit in staging; the judge sees both with `query --status staging`; conflict is judged at commit | tested |
| A7 | The fact became true before it was written | `--valid-from` | measured |
| A8 | The fact is known now to stop at a future time | no scheduled end-time input at propose; invalidate, amend, and supersede close intervals | gap |
| A9 | Evidence raises confidence | `amend --confidence --source` | measured |
| A10 | The predicate holds many objects at once (`depends-on`, `owns`, `blocked-by`) | round 2: `predicates` declares `one` or `many`; the conflict rule applies to `one` only | measured |
| A11 | The object is another entity | `--o-type`; exercised by the second-round entity edges (C4) | measured |
| A12 | The object is a literal | `o_type` null | measured |
| A13 | Two writers misspell one predicate (`caused-by`, `caused_by`) | round 2: a predicate not in `predicates` is refused at propose, and at commit if removed since | measured |
| A14 | A type or domain is missing from the vocabulary | refused at propose with the list named | measured |
| A15 | A type is renamed later | old lines keep the old name; the fold does not re-validate | pattern |

## B. Who writes

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| B1 | A seat writes from its worktree with nothing set | writer from the Dryad registry by worktree | measured |
| B2 | A seat writes with `DRYAD_ID` | `seat:<id>` | tested |
| B3 | A person writes | `--by human:<name>` | measured |
| B4 | A judging agent commits | `judges` accepts `agent:<name>`; recorded judge runs used human ids, so agent execution is not measured | pattern |
| B5 | A non-judge tries to commit or invalidate | refused, judges named | measured |
| B6 | A judge commits its own proposal | allowed; the log shows the same writer on both lines | pattern |
| B7 | The model behind an agent must be attributable | `--model` | tested |
| B8 | A seat has been finished; its worktree is gone | `--from-seat` still reads the finished archive; writer resolution still applies; the finished-archive fixture supplies the report | tested |
| B9 | Inside a playground sandbox, where `DRYAD_*` is stripped | worktree fallback | measured |
| B10 | A writer claims an id that is not theirs | not prevented; declared trust, same as Dryad's registry | pattern |

## C. The seams to the work graph

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| C1 | An item reports done | `propose --from-seat` reads the last done report | measured |
| C2 | An item reports blocked | round 2: `--from-seat ID --report blocked` | measured |
| C3 | An item is retried; a later seat has the same id | implementation searches the finished archive in reverse order before the live record; retry precedence has no dedicated test | gap |
| C4 | A dependency or blocker between lanes | a fact with `o_type` set on a `many` predicate | measured |
| C5 | A local check passed or failed | a `check` fact, one line, no output | measured |
| C6 | A new seat's brief should start from the facts | round 2: `query --brief` prints the block a Dryad brief takes | measured |
| C7 | Understory should point at what was proven | round 2: `understory reading` lists the active fact ids per item, through Mycelium's query | measured |
| C8 | A seat reports done and the fact should exist without a person typing | not automated by decision; in the notes pilot every seat proposed its own facts from the skill text, with human judging; automatic proposal remains absent | gap |
| C9 | Forester's plan keeps work structure; Mycelium keeps world facts | separate files for the same project slug; report import reads the registry without changing it | tested |
| C10 | A blocked seat reads what another seat already found | the notes pilot: a Codex seat blocked on a build refusal was pointed at one `tried-and-failed` fact and finished | measured |

## D. Reading

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| D1 | What is held now, in one domain | `query --domain` | measured |
| D2 | What was held at a moment | `query --at` | measured |
| D3 | Everything about one entity, including what is no longer true | round 2: `query --all` | measured |
| D4 | The candidates least sure of themselves | `query --status staging --below` | tested |
| D5 | Where a fact came from, through its corrections | round 2: `trace <id>` walks `amends` and `supersedes` both ways, in chain order | measured |
| D6 | What changed since I last looked | round 2: `query --since` on `changed_at`, the last line that touched the row | measured |
| D7 | Ids for a shell loop | `query --ids` | measured |
| D8 | Machine-readable envelopes | `query --json` | measured |

## E. Storage under load

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| E1 | Two seats propose in the same instant | round 2: every write under the log lock; twelve proposers raced, twelve whole lines read back | tested |
| E2 | Two judges commit conflicting facts in the same instant | round 2: commit re-reads under the lock; four committers raced on a `one` predicate, one won | tested |
| E3 | A line is cut short by a crash | `readLog` rejects malformed JSON with a line number; the existing test covers a missing version, not a crash-truncated line | pattern |
| E4 | The log outgrows memory | whole-log fold | gap |
| E5 | A second machine | machine-local by design | gap |
| E6 | The log format changes | every line carries `v: 1`; no migration path | gap |
| E7 | The values file changes after lines exist | old lines are not re-validated; new proposes are | pattern |

## F. Isolation

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| F1 | A sandbox run must not reach the machine log | state root from `GROVE_STATE_DIR`; dated records and the arc check for sandbox paths in machine registries | measured |
| F2 | The catalog's own facts | its own slug, `.agents/mycelium.yml` here | measured |
| F3 | A stray line written by mistake | invalidated with the reason; the line stays | measured |

## Remaining limits and verification

A8 has no scheduled expiry input. C3 needs a dedicated retry-precedence
check before readers can rely on which reused seat record supplies a
report. Agent judging (B4) has no recorded agent execution. Self-commit
(B6) and declared identity (B10) rely on project trust; adding another
judge alone does not enforce independent review. C8 remains a manual
workflow. E4–E6 leave large logs, multiple machines, and format migration
outside the demonstrated coverage.

For a fresh checkout review, run `node infra/bin/cli.mjs herbarium check`
to check document links and catalog conventions, then `npm test` to run
the repository suite, including the sandbox arc. Record the candidate
revision, exact commands, observed counts, and skipped boundaries with
the review. Historical execution counts stay in the evidence records
linked above; a passing suite does not establish the remaining limits.
