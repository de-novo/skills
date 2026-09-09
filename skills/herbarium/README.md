# Herbarium

Every document has one house, and the rest point at it. One verb counts
what drifts.

```
a fact ──▶ its house (one file) ◀── pointers from every other document
                 │
   herbarium check: links n/n · copies n · language n · pages n/n · archive n
```

## What it does

Names a house for each kind of document a project keeps (working rules,
pattern, human page, long facts, design note, evidence, cases, vocabulary,
decision, record, retired) and gives an agent the levers for writing one
that another agent will run. The defining constraint: a fact lives in one
file, and `check` counts every sentence found in two.

## When to reach for it

An agent reaches for it whenever it is about to write, move, or review a
document someone else will read, when a fact seems to live in two files,
when a page is getting long, or when a link may have gone stale. A person
types `/herbarium` for the same reasons. For what is *true*, use
[mycelium](../mycelium/README.md); for the record of a sprint, use
[understory](../understory/README.md).

## It's working if

- `herbarium check` exits zero on every change, and CI runs it.
- A reader finds a fact by following one link, never by comparing two files.
- Human pages get shorter as the project grows, because the long facts moved to references.

## Where it fits

Underneath every other skill's documents: each skill's SKILL, README, and
references follow this rule, and this catalog checks itself with it. Root
map: [How the skills fit](../../README.md#how-the-skills-fit).

## What it does to your machine

Reads the public files the values file names. Writes nothing, downloads
nothing, runs nothing.

## Apply to a project

1. Write `.agents/herbarium.yml`: the public globs, the human pages and
   their cap, the archive, the language. Copy
   [examples/herbarium.yml](examples/herbarium.yml) and cut it down.
2. Run `de-novo skills herbarium check`. Read the counts; fix what is
   counted, or move the cap, but say which.
3. Add the same command to CI.

## Pointers

Houses, levers, and the CLI: [references/houses.md](references/houses.md).
Pattern: [SKILL.md](SKILL.md). Reasons and what was borrowed:
[`docs/herbarium-design.md`](../../docs/herbarium-design.md).
