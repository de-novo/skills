---
name: mycelium
description: >-
  de-novo Mycelium — the facts under the forest. One append-only log of
  assertions per project: what is held true, since when, with what
  confidence, in which domain, on whose word. Workers propose; a person or
  the judging worker commits or invalidates; readers query a moment. Use
  when work produces a fact that outlives the seat that found it (a locked
  decision, a verified cause, a blocker, a check result), when a person
  asks what the project currently holds true, or when the user runs
  /mycelium. Values live in .agents/mycelium.yml (domains, entity types,
  and the judges who may commit; tracked). Corrections are amendments
  that point back; nothing is edited in place. The CLI never judges; the
  promotion is yours.
---

# Mycelium

Forester's graph is the work: items, dependencies, claims. It says nothing
about what the work found out. Mycelium is the other graph, the one under
the forest: facts with time, confidence, domain, and provenance attached,
so a worker seated tomorrow starts from what was proven today instead of
from the chat that proved it.

This file owns the pattern. The envelope, the transitions, the query, and
the CLI are in [README.md](README.md). Forester pattern:
[forester](../forester/SKILL.md). Seats: [dryad](../dryad/SKILL.md).

## Two graphs, one seam

| Graph | Node | Owner | Home |
| --- | --- | --- | --- |
| Forester | an item of work and its state | the plan | `.agents/forester-plan.yml` |
| Mycelium | an assertion and its status | the log | `<state>/mycelium/<slug>.jsonl` |

The seam is one direction only: a seat that reported done may be proposed
as a fact (`propose --from-seat`). Mycelium never changes the plan, never
assigns, never marks an item done.

## The rule

**Propose is cheap; commit is a judgement.** Any worker may propose, and a
proposal is only staging. Only a judge commits: a person, or the worker the
project names in `judges`. A committed fact that stops being true is
invalidated, never deleted: the log keeps what was held and for how long.

**Wrong is amended; no longer true is invalidated.** A fact you got wrong
gets a corrected copy (`amend`), and the original is closed as if it never
held. A fact that was true and stopped is invalidated or superseded, and
the moment it held stays answerable. Nothing is ever edited in place.

**Every line names its writer.** A seat standing in its own worktree is
`seat:<id>` without saying so; a person or a judging agent passes `--by`.
The id is a declaration the project trusts, not a login; the README says
what that means on a shared machine.

## Write

When your work produces a fact worth keeping:

1. **Ask whether it outlives you.** A locked decision, a verified cause, a
   dependency between lanes, a blocker, a check's pass or fail, an approach
   tried and failed: yes. A file hunk, a build log, a heartbeat, a chat
   turn: no. The full list is the README's commit rules.
2. **Propose it in the envelope.** Subject, predicate, object, the subject's
   type, the domain, the source you read it from, and your confidence.
   The domain and the types must already be in `.agents/mycelium.yml`; if
   the vocabulary lacks one, say so to a person rather than inventing it.
3. **Name the source precisely.** A file path and line, a PR, a seat's
   report, a check's output line. A fact with no source is a rumour and
   is not proposed.
4. **Correct with `amend`, not with a second proposal.** If you find your
   own proposal wrong, or another's, amend it and say why in the source.
   The log then shows the correction as one link, not two unrelated facts.
5. **Do not commit your own proposal** unless the project names you as its
   judge. Say what you proposed in your seat report.

## Judge

When you hold the judge's role, or are a person reading staging:

1. `query --status staging` and read each candidate against its source.
2. Commit what is true. A conflict with an active fact on the same subject
   and predicate is refused; supersede only when the newer fact replaces
   the older, and say so.
3. Invalidate with a reason a stranger can read. `--below 0.5` finds the
   candidates least sure of themselves; those get a source check first.

## Read

Ask the log, not the chat. `query --domain <d>` for what is held now,
`query --at <moment>` for what was held then, `query --s <entity>` for
one thing's history. Put the answer into the worker's brief as pointers
to assertion ids, so the brief stays short and the facts stay in one home.

## Invariants — not weakenable

- **The log is append-only.** No edit, no delete. Invalidation is a new line.
- **The graph is the fold of the log.** Nothing else is consulted.
- **Every assertion names its source and its agent.** No defaults for either.
- **Correction is a new line that points back.** `amend` links; nothing is edited.
- **Vocabulary is declared, not discovered.** Unknown domains and types are refused.
- **The CLI never calls a model and never judges.** Commit is a person's or the named judge's.
- **Mycelium does not write the plan.** The Forester seam reads seats; it does not touch them.

## Not this skill

- Deciding the work or its order. Forester.
- Seating, reporting, or finishing a worker. Dryad.
- A document a person reads. Understory can point at assertion ids.
- A second store per machine, a query language, a merge across machines.
  Those are named as later work in the design note and are not here.
