---
name: herbarium
description: >-
  de-novo Herbarium — every document a project keeps has one house, and the
  rest point at it. Use whenever you are about to write, move, rename, or
  review a document that someone else will read: a README, a skill, a
  design note, an evidence record, a reference, working rules for agents.
  Use when a fact seems to live in two files, when a document is getting
  long, when a link may have gone stale, or when the user runs /herbarium.
  Values live in .agents/herbarium.yml (the houses, the language, the page
  cap). The CLI counts drift; it never edits a document.
---

# Herbarium

A specimen is pressed once, labelled, and shelved where it can be found.
The same plant is not pressed twice. A document is a specimen: one house,
one label, and every other document that needs it points at the shelf.

This file owns the pattern. The houses a project keeps, the levers for
writing a document an agent will run, and the CLI are in
[references/houses.md](references/houses.md).

## The rule

**One house per fact; pointers, not copies.** Before writing a sentence,
ask where that fact already lives. If it lives somewhere, link there. If
it lives nowhere, put it in the house the reference names for its kind
and link from where you are. A fact restated in a second file is a fact
that will be wrong the next time its home changes; `check` counts those.

## Write

1. **Name the kind.** The reference lists the eleven kinds and the house
   each one has. A document that is two kinds is two documents.
2. **Front-load the leading word** and the one defining constraint. A
   reader, human or agent, decides in the first line whether to keep
   reading; the pointer to this document, wherever it sits, uses the same
   word.
3. **Keep steps and reference apart.** Steps in order, each ending on a
   criterion a reader can check: done or not done, with a number where
   one exists. Reference consulted on demand goes below the steps or
   behind a pointer; what only some readers need goes behind a pointer.
4. **Let the environment speak.** A command's `--help`, a config file, a
   directory listing are sources of truth. Write down the convention that
   is not in them and the reason behind a choice; leave the lookups where
   they cannot go stale.
5. **Say the positive.** State the behaviour wanted; a prohibition earns a
   line only as a hard guardrail, paired with the positive it protects.
6. **Prune.** Every line either changes what the reader does or leaves.
   Layers that settled because adding felt safe are sediment; core through
   them.

## Check

```bash
de-novo skills herbarium check          # links n/n · copies n · language n · pages n/n · archive n
```

Run it before a document lands, and let CI run it on every change. A
broken link or anchor, a copied sentence, a public surface whose prose is
in another script, a page over its cap, or a generated snapshot that
names no source and revision is a non-zero exit. Similar paragraphs and
links from active documents into the archive are shown, not judged: a
person decides whether they are a paraphrase, a citation, or a
leftover. The check also says how many bytes an agent loads across the
public surfaces, with a token estimate that names itself one.

## Retire

A design that is no longer operating authority moves to the archive with
its date and a link to what replaced it. Active instructions do not lean
on it. It is not deleted: a reader who finds an old decision should be
able to read why it was made.

## Invariants — not weakenable

- **One house per fact.** A second copy is a defect the check counts. A
  summary in your own words that points at its source, and a generated
  snapshot that names what made it and when, are not copies: the source
  stays the one place to edit, and the reader can tell how old they are.
- **The CLI never edits.** It counts; a person or an agent moves the text.
- **Public surfaces are one language**, the one the values file names.
- **A human page is short.** Its prose stays under the cap; a diagram in a
  fence or a table is looked at, not read, and does not count.
- **Retired documents are kept**, dated, and pointed at what replaced them.

## Not this skill

- Deciding what is true. Mycelium holds facts; this holds the documents
  that point at them.
- Writing the record of a sprint. Understory does that, under this rule.
- A documentation site, a publishing pipeline, a translation workflow.
