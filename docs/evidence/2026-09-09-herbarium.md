# Herbarium, second round — 2026-09-09

The first round of Herbarium landed with four things unmeasured: anchors
inside link targets, copies that were paraphrased rather than pasted, a
consuming project's first `check`, and whether Codex reaches for the skill
on its own. This record is each of those, run at its real boundary on the
tree after PR #11 (`7cdb1bb`) with the changes this PR carries.

## Anchors and near copies, on the catalog itself

`check` gained `anchors n/n` (a `#heading` resolved against the target's
headings with GitHub's slug rule) and `copies n near` (a run of fourteen
words shared by two files after case and punctuation are dropped, one
finding per pair, skipped when the pair holds an exact copy).

The first run of the stricter check on the catalog:

| Count | Result |
| --- | --- |
| links | 216/216 |
| anchors | 17/17 |
| copies, exact | 0 |
| copies, near | 6 |

All six were true. Each was a sentence written in this session or the one
before it, restated where a pointer belonged:

| Pair | Runs | What it was | What it became |
| --- | --- | --- | --- |
| playground evidence · playground design | 6 | the evidence restated isolation rule 6 | a pointer to the rule |
| forester design · forester skill | 4 | the design note restated two invariants | one sentence saying the skill owns them |
| forester design · mycelium design | 1 | both restated the working rules' guard sentence | one sentence pointing at the rules |
| clearing README · forester README | 3 | the same invocation sentence in two human pages | two distinct sentences |
| herbarium README · herbarium skill | 1 | the skill listed the eleven kinds the reference owns | a pointer to the reference |
| understory README · understory skill | 7 | the README restated the skill's description | a sentence in the README's own words |

After: `links 217/217 · anchors 17/17 · copies 0 exact · 0 near`. The
suite holds the catalog there.

Guards reverted once, each restored before the next: anchors (1 red), the
heading slug keeping inline code (1), near copies (1), a near copy not
doubled on an exact pair (2).

## A consuming project's first check

The Mycelium arc test now plants `.agents/herbarium.yml` in the sandbox
project, writes a README with one prose paragraph and one link, and runs
`check`: `links 1/1 · copies 0 exact · 0 near`, exit 0. Then it copies
the paragraph into a second file and runs `check` again: exit 1 with one
exact copy. That runs on every `npm test` and in CI.

## Codex reaches for the skill unprompted

An Orca worktree of the catalog at this branch, dependencies installed,
Codex 0.153.4 in a terminal (`-a on-request -s workspace-write`), and one
prompt that names no skill:

> Review docs/mycelium-cases.md before it is published to people outside
> this repository. Fix what you find, commit on this branch, and do not
> push. Tell me what you checked and how.

| Checked for | Observed on screen |
| --- | --- |
| Finds the skill by itself | "will use the Herbarium skill to check document ownership and references", then `cat .agents/skills/herbarium/SKILL.md` |
| Reads the houses | `Read herbarium.yml, houses.md, …` |
| Runs the verb | `herbarium check: 222/222 links, 17/17 anchors; no copy or language findings` |
| Reads the evidence it cites | the two Mycelium evidence records and `references/log.md` |
| Commits, does not push | `7d76ff6 docs: correct Mycelium case coverage for external readers`, one file, 58 insertions and 73 deletions, "Did not push" |
| Says what it ran | `npm test` 279/279, `git diff --check` clean |

The commit is cherry-picked into this PR as is. What it changed in the
cases note: a glossary for outside readers (seat, judge, slug), marks made
honest (B4 from "measured with a human" to pattern, A11 from tested to
measured through C4, E3 from tested to pattern because the test covers a
missing version and not a truncated line), the "deferred" mark folded into
gap, and one finding that was a defect in the code: `--from-seat` searched
the finished archive before the live seat, so a retried item's earlier
seat could outrank the seat working now. The order is now live first, then
archived newest first, with a test that goes red on the old order (1).

Driver friction, unchanged from the pilot: 75 approval prompts answered by
the driver; the driver's "y" keystrokes also landed in Codex's composer
after the run ended, harmless.

## Not measured

A copy paraphrased so thoroughly that no fourteen-word run survives; a
person who was not here reading the rewritten cases note and saying
whether it reads better; Codex reaching for the skill inside a sandbox
project (this probe ran in the catalog, where `.agents/skills` is a
symlink tree).
