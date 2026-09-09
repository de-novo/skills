# Mycelium — the facts under the forest

Written 2026-09-08. Status: landed the same day, first round. Once landed,
`infra/lib/mycelium.mjs` owns the behaviour and `skills/mycelium/README.md`
owns the fields. This note records why.

## The gap

Grove is the ground, Dryad the seats, Forester the plan, Canopy the screen,
Understory the record. All five are about the work: which item, which
worktree, which state. None of them holds what the work found out. A locked
decision, a verified cause, a check that failed, an approach that did not
survive: today those live in a chat transcript, a PR body, or a person's
memory, and the next seat starts without them.

The other side of the gap is just as real. The Forester plan must not become
that store. Its file is tracked and per branch; its nodes are items with
five states; a fact about the world does not fit there and would drift with
every worktree.

## What is kept as a fact, and why it is a separate graph

Two graphs, deliberately:

| | Forester | Mycelium |
| --- | --- | --- |
| Node | item of work | assertion |
| States | done, active, ready, blocked, failed | staging, active, invalid |
| Time | now | valid interval and transaction time |
| Written by | the planning agent | any worker (propose), the judge (commit) |
| Home | tracked plan file | machine-local, append-only log |

They meet at exactly one point, read-only: a seat's done report can be
proposed as a fact. Mycelium never writes the plan or a seat.

## Decisions

- **Append-only log, fold on read.** Provenance is free: the log is the
  history. Two readers of the same log see the same graph. Invalidation is a
  new line, so what was held, and for how long, is never lost.
- **A file under the same state root as Dryad**, keyed by the Dryad slug. A
  database is the P2 answer for several writers and several machines; a
  pilot on one machine needs a file that the shell can `tail`.
- **Vocabulary is declared.** Domains and entity types live in a tracked
  values file. A proposal naming an unknown domain or type is refused. A
  graph that grows its own vocabulary one agent at a time becomes a chat.
- **Conflict is the same (domain, subject, predicate) with another object.**
  Refused at commit unless the caller supersedes, which invalidates the old
  fact in the same log line. There is never a moment with both active.
- **Point-in-time is `valid_from <= at < valid_to`** over committed facts,
  invalidated since or not. Staging never answers a moment; it is not yet
  in the world.
- **No default writer.** A seat is `seat:<DRYAD_ID>`; anyone else passes
  `--by`. A fact with no author is not written.
- **Judges are declared in the values file, not authenticated.** `judges`
  is the list of writer ids that may commit and invalidate. A process can
  claim any id; the list is the project's statement of trust, the same
  trust Dryad's registry already rests on. Authentication is a later
  decision and would come from the machine, not from this log.
- **Correction is `amend`: a copy that points back.** The original is
  closed with an empty interval when the copy is committed, so it never
  answers a point-in-time query; it is still in the log with the reason.
  This is distinct from supersede, which keeps the old interval up to the
  new fact's `valid_from`, because the old fact did hold for a while.
- **The CLI never calls a model.** Who judges is a role the project gives to
  a person or a worker, not a flag in the CLI.

## Not in this round

The case-by-case walk, with what each round carries, is
[mycelium-cases.md](mycelium-cases.md).

- Two writers appending in the same instant. Closed in the second round:
  every write re-reads the log under the file lock Dryad's registry uses,
  and a race of four committers on a `one` predicate leaves one active
  (`infra/bin/mycelium.test.mjs`).
- A second machine. The log is machine-local like Dryad's registry.
- A query language. Filters are exact matches, one moment (`--at`), one
  change horizon (`--since`), and one chain (`trace`).
- A hook that proposes on `dryad report --status done` without a person
  running `propose --from-seat`. The seam exists; the automation is a later
  decision because it changes what a seat is allowed to write.
- Projection into a wiki or notes app. Understory can point at ids.

## Verify

Parser and CLI guards under `infra/bin/mycelium.test.mjs`. Revert each
guard once to see red and record how many went red. The real boundary for
this round is the catalog's own Dryad ground: one propose, one amend, one
commit, one query, at a real slug, with the log file read back, and the
same arc inside a playground sandbox with a real seat:
[evidence](evidence/2026-09-08-mycelium-sandbox.md).
