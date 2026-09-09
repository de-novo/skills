# Herbarium — one house per document

Written 2026-09-09. Status: landed the same day. Once landed,
`infra/lib/herbarium.mjs` owns the counts and
`skills/herbarium/references/houses.md` owns the houses and the levers.
This note keeps the reasons and names what was borrowed.

## The gap

By the seventh skill this catalog had a documentation discipline, but only
as habits: the "Where facts live" table in `AGENTS.md`, "pointers, not
copies" in Understory, dated evidence files, design notes, a cases note,
the six-section README with `references/` beside it, and an archive rule.
None of it was a pattern a consuming project could take, and none of it
was measured: a link checker was written by hand twice in one week to
land two PRs, and a Cyrillic letter sat in an English evidence file for a
day because nothing counted scripts.

## Decisions

- **A skill, not a linter.** The verb is the smallest part. The pattern is
  the houses (which kind of document lives where) and the levers (how a
  document an agent runs is written). A project that only runs `check`
  still drifts; a project that only reads the pattern cannot prove it did.
- **Model-invoked.** A person rarely types a documentation skill's name.
  The description carries the triggers (about to write a document, a fact
  in two files, a long page, a stale link) so an agent reaches for it on
  its own; `/herbarium` remains for a person who wants it.
- **Counts, never edits.** The CLI prints numbers and the findings behind
  them and exits non-zero. Moving text is a judgement; the check makes the
  judgement unavoidable, not automatic.
- **Copies are exact lines of prose.** Eighty characters or more, outside
  code, tables, headings, and pointer lines, in two files. Paraphrase is
  not counted; the bar is the one that cannot false-positive on a shared
  pointer line. A first run on this catalog found zero copies and one
  wrong-script file, which is the right ratio for a rule that has been
  followed by hand.
- **A page's cap is on its prose.** A diagram or a command block in a
  fence is looked at, not read. Without that rule Grove's README, which is
  mostly one drawing, fails a cap it honours in every sentence.
- **Archive links are shown, not judged.** A design note citing what it
  replaced is a citation; an active instruction leaning on an archived
  plan is a defect. The same link, two meanings; a person tells them apart.
- **Vocabulary and decisions are not new houses.** A project's words live
  in `.agents/mycelium.yml` and its locked decisions are Mycelium
  `decided` facts. Herbarium names those houses and adds nothing beside
  them.

## Borrowed

From `mattpocock/skills` (MIT), read on 2026-09-09:

- The levers table is a compression of its `writing-for-agents` skill:
  context pointers, the two loads, the information hierarchy and
  progressive disclosure, completion criteria, leading words, positive
  phrasing, the environment as a source of truth, pruning and sediment,
  when to split. The words are that skill's; the table form and the tests
  in the right column are this catalog's.
- The three-part test for recording a decision (hard to reverse,
  surprising without context, a real trade-off) is its ADR format's, and
  went into Mycelium's commit rules rather than here, because a decision's
  house is the log.
- "Be opinionated: one word, and the ones to avoid" is its `CONTEXT.md`
  format's attitude toward vocabulary; the values file already is that
  list, so only the attitude was taken.

Not borrowed: a documentation-site page template, absolute-URL rules,
author-attribution rules, translations, and bucket folders.

## Verify

`infra/bin/herbarium.test.mjs` fixtures each count and the CLI, and the
last test runs `check` on this catalog itself, so the suite fails when the
catalog's own documents drift. Reverting a count turns its test red. The
real boundary for this round is that first run on the catalog: two true
findings (one wrong-script file, one page over the cap for the wrong
reason), both fixed, then zero. The second round's record, including six
near copies the stricter check found in the catalog's own documents and a
Codex session that reached for the skill without being told its name, is
[evidence/2026-09-09-herbarium.md](evidence/2026-09-09-herbarium.md);
the third round, with the similar-paragraph count and a reader who was not
here, is [evidence/2026-09-09-herbarium-round-3.md](evidence/2026-09-09-herbarium-round-3.md).
