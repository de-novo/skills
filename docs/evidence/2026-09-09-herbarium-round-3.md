# Herbarium, third round — 2026-09-09

The second round left three things unmeasured: a paraphrase with no
fourteen-word run left, Codex reaching for the skill inside a sandbox
project rather than the catalog, and a reader who was not here reading
the rewritten cases note. This record is each of those, on the tree after
PR #12 (`bc1539f`) with the changes this PR carries.

## A paraphrase that kept the bones

`check` gains `copies n similar`: a paragraph of 25 words or more, half of
whose word 4-grams (of the shorter of the two) appear in a paragraph of
another file, for a pair not already reported as an exact or near copy.
Containment rather than Jaccard: the first fixture, a paraphrase with
every fourteenth word changed, scored 0.36 by Jaccard and 0.54 by
containment, because every changed word removes four grams from both
sides and Jaccard charges for both. Shown, not judged, so a true
paraphrase and two honest descriptions of one thing are both left to a
person. The catalog shows 0. Guards reverted once: the finding itself
(1 red), the pair skipped when a copy is already reported (1 red).

## A reader who was not here

A fresh headless Claude Code session in a directory holding only
`docs/mycelium-cases.md`, told to read nothing else, asked three things.

| Asked | Answered |
| --- | --- |
| What Mycelium is, holds, and what is open, in three sentences | correct on all three: an append-only log of assertions, the envelope's fields and the three corrections, and the open rows by number (A8, C8, B4, E4 to E6) |
| Terms or sentences it could not understand from the file alone | 22, every one a name defined elsewhere in the catalog: Dryad, Forester, Understory, Grove, Herbarium, the catalog, the sandbox, the fold, the values file, the envelope's fields, the conflict rule, the guards |
| Did the file alone say what is measured and what is not | "Yes for the classification and no for the evidence": the marks are clear, the counts behind them live in the evidence records |

That is the houses rule read back from the outside: the note is a cases
document, not a human page, and it pointed at nothing for its vocabulary.
It now carries one pointer to the root map and the references, and says
why. The second answer is the reason a cases note should never grow a
glossary of its own.

## Codex inside a sandbox project

A playground sandbox, the seven skills copied into the project's
`.agents/skills` (the sandbox refuses symlinks), `.agents/herbarium.yml`
planted, a second document added, one commit. Then `codex exec` in the
project directory with the second round's prompt, its target widened from
one file to "the documents in this project" and still naming no skill
(the wording is in [the second round's record](2026-09-09-herbarium.md)).

| Checked for | Observed in the transcript |
| --- | --- |
| Finds the skill by itself | "I'm using the herbarium skill", then `cat .agents/skills/herbarium/SKILL.md` |
| Reads the houses | `cat … .agents/herbarium.yml .agents/skills/herbarium/references/houses.md` |
| Fixes what the skill names | README 943 words to 302, broken links fixed, catalog-only instructions removed, a `docs/adapter.md` added "with source-checked behavior and build limitations" |
| Reports counts | "12 links, 1 anchor, word limit, duplicate-text and language checks" |
| The driver's check on its result | `links 12/12 · anchors 1/1 · copies 0 exact · 0 near · 0 similar · language 0 · pages 1/1`, the same numbers |
| Commits, does not push | could not commit: Codex's own sandbox keeps `.git` read-only, so it said so and left the changes uncommitted; nothing pushed |

`playground down`: ports 0, machine mentions 0, directories remaining 0.

Driver finding: `codex exec` run without a terminal waits on stdin
("Reading additional input from stdin…") until it is closed; the first
attempt sat for nine minutes. `< /dev/null` is part of the invocation.

## Not measured

A cold reader who is a person rather than a fresh session; the similar
count on a project with many long documents, where the pair-by-pair
comparison may be slow; Codex committing inside its own sandbox, which is
its policy and not this catalog's.
