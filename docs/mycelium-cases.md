# Mycelium — the cases it must carry

Written 2026-09-09; marks updated the same day for the second round. The
first round landed 2026-09-08 (`7047aa0`, [design](mycelium-design.md),
[evidence](evidence/2026-09-08-mycelium-sandbox.md)); the second round's
evidence is [here](evidence/2026-09-09-mycelium-round-2.md). Before a pilot
on a real project, this note walks every situation a shared fact store
meets during a multi-worker sprint and says, for each, which mechanism
carries it today, whether that mechanism has been measured, and what is
missing.

Each row has one of four marks:

| Mark | Meaning |
| --- | --- |
| **measured** | executed at a real boundary (a sandbox seat or the catalog's own slug) and read back |
| **tested** | covered by a unit test at the CLI or library boundary, not yet at a seat |
| **pattern** | the skill text tells the agent what to do; the CLI does not enforce it |
| **gap** | nothing carries it; the last section says what would |

The marks are dated claims about the second-round tree, not guarantees.
A row that changed in the second round says so in its mechanism column.

## A. One fact's life

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| A1 | A seat finds something worth keeping | `propose` with source, type, domain | measured |
| A2 | The fact was wrong | `amend`: a copy that points back; original closed with an empty interval on commit | measured |
| A3 | The fact was true and stopped being true | `invalidate --reason`; interval kept | measured |
| A4 | A newer fact replaces an older one on the same subject and predicate | `commit --supersede`; old closed at the new `valid_from` | measured |
| A5 | The same fact is proposed twice by two seats | second `commit` refused as a duplicate | measured |
| A6 | Two seats propose contradicting objects, neither committed yet | both sit in staging; the judge sees both with `query --status staging`; conflict is judged at commit | tested |
| A7 | The fact became true before it was written | `--valid-from` | measured |
| A8 | The fact is known now to stop at a future time | no `--valid-to` at propose; only `invalidate` sets it | gap, low |
| A9 | Evidence raises confidence | `amend --confidence --source` | measured |
| A10 | The predicate holds many objects at once (`depends-on`, `owns`, `blocked-by`) | round 2: `predicates` declares `one` or `many`; the conflict rule applies to `one` only | measured |
| A11 | The object is another entity | `--o-type` | tested |
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
| B4 | A judging agent commits | `judges` in the values file; `--by agent:<name>` | measured with `human:reader` |
| B5 | A non-judge tries to commit or invalidate | refused, judges named | measured |
| B6 | A judge commits its own proposal | allowed; the log shows the same writer on both lines | pattern |
| B7 | The model behind an agent must be attributable | `--model` | tested |
| B8 | A seat has been finished; its worktree is gone | `--from-seat` still reads the finished archive; a writer must pass `--by` | measured |
| B9 | Inside a playground sandbox, where `DRYAD_*` is stripped | worktree fallback | measured |
| B10 | A writer claims an id that is not theirs | not prevented; declared trust, same as Dryad's registry | pattern |

## C. The seams to the work graph

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| C1 | An item reports done | `propose --from-seat` reads the last done report | measured |
| C2 | An item reports blocked | round 2: `--from-seat ID --report blocked` | measured |
| C3 | An item is retried; a later seat has the same id | the newest record wins, live before finished | tested |
| C4 | A dependency or blocker between lanes | a fact with `o_type` set on a `many` predicate | measured |
| C5 | A local check passed or failed | a `check` fact, one line, no output | measured |
| C6 | A new seat's brief should start from the facts | round 2: `query --brief` prints the block a Dryad brief takes | measured |
| C7 | Understory should point at what was proven | round 2: `understory reading` lists the active fact ids per item, through Mycelium's query | measured |
| C8 | A seat reports done and the fact should exist without a person typing | not automated by decision; see the design note | deferred |
| C9 | Forester's plan must never hold world facts | separate files, separate slugs, read-only seam | measured |

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
| E3 | A line is cut short by a crash | `readLog` refuses with the line number | tested |
| E4 | The log outgrows memory | whole-log fold | deferred |
| E5 | A second machine | machine-local by design | deferred |
| E6 | The log format changes | every line carries `v: 1`; no migration path | deferred |
| E7 | The values file changes after lines exist | old lines are not re-validated; new proposes are | pattern |

## F. Isolation

| # | Case | Mechanism today | Mark |
| --- | --- | --- | --- |
| F1 | A sandbox run must not reach the machine log | state root from `GROVE_STATE_DIR`; 0 mentions after five runs | measured |
| F2 | The catalog's own facts | its own slug, `.agents/mycelium.yml` here | measured |
| F3 | A stray line written by mistake | invalidated with the reason; the line stays | measured |

## What the second round carried

Two rows blocked a pilot: A10 and A13. Without them the first sprint with a
`depends-on` fact either forked the vocabulary or refused the second edge.
The list below is what landed, in the order a pilot would have hit it.

1. **Declared predicates with cardinality** (A10, A13, C4). The values
   file gains `predicates`, a map of name to `one` or `many`. A predicate
   not in the list is refused at propose, the way a type is, and at commit
   if it was removed since. The conflict rule applies only to `one`; for
   `many` a second object on the same subject is another edge. Duplicates
   stay refused for both. `reported` is built in as `many`.
2. **A lock around commit and invalidate** (E2), the same file lock Dryad
   uses for its registry, so the conflict check and the append are one
   step. Measured with two committers racing in a test, the way the
   overlay parallel test races two attaches.
3. **Two proposers racing** (E1), measured in the same test: n lines
   written, n lines read back, none torn.
4. **`--from-seat` for a blocked report** (C2). `p` becomes `reported`,
   `o` the blocked line, as done is today.
5. **Three reading verbs** (D3, D5, D6): `query --all` for every status,
   `trace <id>` to walk `amends` and `superseded by` in both directions,
   `query --since ISO` on transaction time.
6. **Understory pointer** (C7): the reading line for an item gains the ids
   of active facts whose subject is that item, read through `query --json`
   and never restated.
7. **Brief helper** (C6): `query --brief` prints ids and one line each in
   the shape the Dryad seat brief expects, so a person pastes one block.

Named and not carried: A8 (`--valid-to` at propose; invalidate later is
enough), B6 (self-commit; the log shows it, and a project that wants two
pairs of eyes adds a second judge and reads the log), B10 (authentication;
a machine decision), C8 (automatic propose; a decision about what a seat
may write), E4 to E6 (size, machines, migration; the pilot will say when).

## Verify the round

Each numbered item lands with its guard reverted once to red. The real
boundary stays the playground sandbox with a real seat, and the case
numbers above are the names the evidence file uses, so a reader can go from
a row here to the run that measured it.
