# Mycelium

The facts under the forest: one append-only log of assertions per project,
each with a valid interval, transaction time, confidence, domain, source,
and writer. Workers propose; a judge commits; nothing is edited in place.

```
worker (any seat) ──▶ propose ──▶ staging ──▶ commit (judge) ──▶ active
                                     ▲            │                │
              amend <id> (a corrected copy) ──────┘   invalidate ◀─┘
                                                      (valid_to = now, reason kept)

dryad report --status done|blocked ──▶ propose --from-seat <id>   (the Forester seam, read-only)
```

## What it does

Keeps what the work found out, separately from the work itself: a locked
decision, a verified cause, a blocker, a check result, an approach that
failed. The defining constraint: the graph is the fold of the log and
nothing else, and only a judge named in the values file promotes a fact.
A wrong fact is amended and never held; a fact that stopped being true is
invalidated and its interval kept.

## When to reach for it

A seat reaches for it when its work produces a fact that outlives the seat.
A person reaches for it to ask what the project holds true now, held at a
moment, or changed since they last looked. The vocabulary (domains, types,
predicates) is declared in `.agents/mycelium.yml`; a missing word is a
signal to a person, not something to invent.

## It's working if

- A new seat's brief starts from `query --brief` ids, not from a chat transcript.
- `query --status staging` is short, because a judge reads it daily.
- `trace <id>` on any active fact tells a stranger how it got to be what it is.

## Where it fits

Beside Forester, not inside it: two graphs, one read-only seam
(`propose --from-seat`). Understory points at its ids. Root map:
[How the skills fit](../../README.md#how-the-skills-fit).

## Apply to a project

1. Write `.agents/mycelium.yml` with the domains and the first types.
   Copy [examples/mycelium.yml](examples/mycelium.yml) and cut it down.
2. Load the skill through `.agents/skills/mycelium` the way the project
   loads the others.
3. Run `mycelium status`. It prints the log path and zero counts.
4. Propose one fact from a source you can point at, commit it as a person,
   query it back. That cycle is the evidence the project has the skill.

## Pointers

Values, writers, the log, the envelope, transitions, commit rules, query,
CLI: [references/log.md](references/log.md). Pattern: [SKILL.md](SKILL.md).
Reasons: [`docs/mycelium-design.md`](../../docs/mycelium-design.md). Cases:
[`docs/mycelium-cases.md`](../../docs/mycelium-cases.md).
