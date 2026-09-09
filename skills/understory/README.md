# Understory

The story under the canopy: the document a person who was not here reads to
know what the work is, where it stands, and what has been proven.

```
forester plan --json ──▶ understory graph     ──▶ ┐
                     ──▶ understory reading   ──▶ ├─▶ the document (an agent writes the prose)
plan · design note · evidence ──(links only)──▶ ┘
```

## What it does

Draws Forester's graph and one reading line per item through the CLI, then
an agent writes eight short sections around them. The defining constraint:
a map points, it does not copy. Every fact stays in its home and the
document links to it; what the document owns is the reading.

## When to reach for it

Someone wants the work graph as a page they can hand to a colleague, or a
sprint has ended and needs its record; an agent reaches for it then, and a
person types `/understory`. For the live screen instead, use Canopy
(`de-novo skills canopy`).

## It's working if

- A reader who was not here says, from the document alone, that they know what is happening.
- The document gets shorter as it gets better, and every number in it changes what the reader does.
- What is not proven sits in the same table as what is.

## Where it fits

Reads Forester's graph and Mycelium's fact ids; writes only prose. Root
map: [How the skills fit](../../README.md#how-the-skills-fit).

## What it does to your machine

Reads Forester's JSON and Mycelium's log. Writes nothing itself; the
document is written by the agent, where the project says.

## Apply to a project

1. The project has a Forester plan.
2. An agent reading [SKILL.md](SKILL.md) runs the two verbs and writes the
   eight sections around them.
3. The project decides where the document lives and in which language.
4. A person reads it and says whether they know what is happening. That
   answer is the evidence; record it with the date.

## Pointers

The eight sections, the drawn graph, the reading lines, the CLI:
[references/document.md](references/document.md). Pattern: [SKILL.md](SKILL.md).
