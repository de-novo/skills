---
name: understory
description: >-
  de-novo Understory — the story under the canopy. Write the document that
  lets a person read Forester's graph: what the work is, how it depends and
  what it claims, what is moving now, what was proven, and what is open.
  Use when a person asks for a shared document, a write-up, a map, or a
  status page of the work graph; when the user runs /understory. The graph
  and the per-item reading lines come from the CLI; you write the prose
  around them and never restate a fact another file owns.
---

# Understory

Canopy is the live screen above the work. Understory is what stays written
underneath it: one document a person who was not here can read and know
what the graph is, where it stands, and what has been proven about it.

This file owns the pattern. The section shapes and the CLI are in
[references/document.md](references/document.md). The graph itself is Forester's:
[forester](../forester/SKILL.md).

## The one rule

**A map points; it does not copy.** Every fact in the document already has
a home: the plan file, the Forester reference, the design note, an evidence
file. The document names the home and links to it. A fact restated in the
document is a fact that will be wrong the next time its home changes.

What the document owns outright is the reading: the sentence that turns a
node and a state into "this is what you should take from it". That is the
part a person is measured against, and it is the part you write.

## Produce it

1. Get the graph as it is now:

   ```bash
   de-novo skills understory graph               # Mermaid, from the project's plan
   de-novo skills understory reading             # one line per item, and the summary
   de-novo skills understory graph --from plan.json   # from a saved forester plan --json
   ```

   Do not draw the graph by hand and do not reorder the items. Two people
   drawing the same plan must get the same picture.

2. Write the sections in the order the reference gives, each as short as it
   can be while still answering its question. The drawn graph goes in the
   second section, as it came out of the CLI, inside a ```mermaid fence.

3. Put every number that changes what a reader does in a table or on its
   own line, and every number that does not change what they do nowhere.

4. Name what is not proven in the same table as what is. A document that
   only lists successes is not trusted, and should not be.

5. End with the pointers: the plan, the Forester reference, the design note,
   the evidence. If a reader needs a schema field or a CLI option, they go
   there; the document does not carry it.

6. Show the person the document and ask one question: reading only this,
   do you know what is happening? Their answer is the document's evidence.

## Where it goes

Where the document is published is a value the project decides: a wiki
page, a shared page, or `docs/` in the repository. Its language is that
audience's language. Inside this catalog's own `docs/`, that is English.

## Invariants — not weakenable

- **No new facts.** The document reads the plan, the CLI output, and the
  evidence; it does not measure, decide, or assign.
- **The graph is drawn by the CLI**, never by hand.
- **Pointers, not copies**, for anything another file owns.
- **What is not proven is written next to what is.**

## Not this skill

- Changing the graph, assigning items, or verifying work. Forester, Dryad,
  and a person do those.
- A live screen. Canopy is that; Understory is the record.
- A design note. Reasons live in `docs/`; the document links to them.
