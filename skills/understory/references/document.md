# Understory — the sections, the drawn graph, the reading, the CLI

The long facts of Understory. Pattern: [SKILL.md](../SKILL.md). The human
page: [README.md](../README.md). The graph belongs to
[Forester](../../forester/references/plan.md).

```
forester plan --json ──▶ understory graph     ──▶ ┐
                     ──▶ understory reading   ──▶ ├─▶ the document (an agent writes the prose)
plan · design note · evidence ──(links only)──▶ ┘
```

## Sections, in order

| # | Section | Answers | Source |
| --- | --- | --- | --- |
| 1 | What this graph is | One sentence: nodes, edges, claims, budget. Why this kind of graph, in three lines | design note (link) |
| 2 | The graph now | The Mermaid flowchart from `understory graph`, as it came out | CLI |
| 3 | How to read it | The `understory reading` lines, and one line per state saying what a reader does about it | CLI |
| 4 | How the plan was written | The five rules from the Forester skill, pointed to, not restated | Forester SKILL (link) |
| 5 | What is proven | One table: what was run, what happened, what was not run. Failures in the same table | evidence files (link) |
| 6 | Words | One line each for the names a reader meets: Grove, Dryad, Forester, Canopy, Understory, Playground | root README (link) |
| 7 | Open | What is not decided or not measured yet | design note, evidence |
| 8 | Pointers | The plan file, the Forester README, the design note, the evidence | — |

Never in the document: schema field tables, CLI option lists, hook store
paths, machine paths. Those have homes.

## The drawn graph

`understory graph` prints a Mermaid flowchart: one node per item, in plan
order, coloured by state (done recedes; active, waiting, and failed stand
out; ready and blocked read as waiting on the plan); a solid edge per `depends_on`; a dotted edge
labelled with the claim for every ready item a claim hold keeps waiting; a
self-note for an item the budget alone holds; and a legend of only the
states present. The node label carries the id, the claims, the tool when
the item names one, and the session state when serve holds one.

## The reading

`understory reading` prints a summary line and one line per item:

| State | Line |
| --- | --- |
| done | `finished (why)` |
| active | `someone is working on it (session …)`, or `… and the session is waiting for a person`; when serve holds the session, `, now <tool> <target>` from its last tool event |
| ready | `would be assigned now`, or `could start, but <hold reason>`, or `could start` |
| waiting | `a person must integrate first: <why>` — a dependency's result is not in the baseline yet |
| blocked | `cannot start yet: waits for …` |
| failed | `gave up: <why>` |

`--json` prints `{ summary, reading: [{ id, state, line, facts }] }`.
`facts` is the list of ids of the active Mycelium facts whose subject is
the item, read through Mycelium's own query and never restated; the text
form appends `· facts a-…, a-…` to the line. A project without
`.agents/mycelium.yml` gets an empty list, and so does `--from`, which has
no project to ask. Pattern: [mycelium](../../mycelium/SKILL.md).

## CLI

```text
de-novo skills understory graph   [--project ROOT | --from plan.json]
de-novo skills understory reading [--project ROOT | --from plan.json] [--json]
```

Both are pure functions of `forester plan --json`. `--from` reads a saved
copy of that output, so a document can be drawn from a plan captured
earlier or on another machine. `--project` resolves as Forester does.
