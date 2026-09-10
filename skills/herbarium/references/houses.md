# Herbarium — the houses, the levers, the CLI

The long facts of Herbarium. Pattern: [SKILL.md](../SKILL.md). The human
page: [README.md](../README.md).

## Values

`.agents/herbarium.yml`, tracked.

```yaml
version: 1
language: en                          # the one script public surfaces are written in
public: [README.md, AGENTS.md, docs/**/*.md, skills/**/*.md]
pages:
  globs: [README.md, docs/*/README.md] # the short human pages
  max_words: 450                       # cap on their prose; fences do not count
archive: [docs/archive/**]             # retired documents
ignore: [dist/**, .playground/**]      # never read; node_modules and .git are always ignored
```

| Field | Meaning | Default |
| --- | --- | --- |
| `language` | The script public surfaces use. Only `en` is supported, and it is a script check over prose, not a judgment of language: a file whose prose holds Hangul, Han, kana, Cyrillic, Arabic, or Thai letters is counted; code spans, fences, quoted lines (`>`), and snapshots may carry any script | `en` |
| `public` | Globs of every document a reader from outside may meet. Required, non-empty | — |
| `pages.globs` | Globs of the human pages held to the cap | none |
| `pages.max_words` | The cap on a page's prose: words outside code fences and tables | 450 |
| `archive` | Globs of retired documents. A link into them from an active document is shown, not judged | none |
| `ignore` | Globs never read. Symlinks are never followed | none |

Unknown keys are rejected. Globs: `**` spans directories, `*` stays inside
one segment.

## Links, snapshots, and what the check reads

A link is resolved as the rendered page resolves it: inline
(`[text](path#anchor "title")`) and reference-style (`[label]: path`)
alike; an anchor is checked against the headings of the file it names,
and a repeated heading gets `-1`, `-2`, … as GitHub gives it.

A **generated snapshot** is prose or a diagram a command produced and a
document keeps for a reader who cannot run the command: an Understory
reading, a Forester graph, a status line. It is a copy by construction,
so it is not counted as one, on one condition: its block names what made
it and the revision or moment it was made at.

```markdown
<!-- snapshot: de-novo skills understory reading @ 3ccdbda 2026-09-10 -->
…
<!-- /snapshot -->
```

A block whose header has no source before the `@` or nothing after it is
a finding, and the check fails. A **cited summary** is prose in your own
words that points at its source on the same line; a quoted line (`>`)
that carries a link is read as a citation, not as a copy.

`check --json` groups what it found: `errors` (broken links and
anchors, another script, pages over the cap, unsourced snapshots) are
certain; `candidates` (exact copies, near copies, similar paragraphs)
are for a person to judge, of which the exact and near copies still fail
the check because the pattern names them defects. `measures` says what an
agent loads when it reads every public surface: `bytes`, and
`tokens_estimate`, which is bytes over four and says so; no tokenizer
runs, and the number is a scale, not a bill.

## The houses

One house per kind. A document that is two kinds is two documents.

| Kind | Answers | House in a project | In this catalog |
| --- | --- | --- | --- |
| Working rules | how do people and agents work in this repository | `AGENTS.md` (`CLAUDE.md` points at it) | `AGENTS.md` |
| Pattern | what an agent does when it takes this skill | `skills/<name>/SKILL.md` | same |
| Human page | what it is, when to reach for it, how to tell it is working, where it fits, how to apply | `skills/<name>/README.md`, under the cap | same |
| Long facts | fields, registries, CLI tables, state machines | `skills/<name>/references/*.md` | same |
| Design note | why it is shaped this way, what was decided against | `docs/<name>-design.md` | same |
| Evidence | one dated execution: what ran, what was counted, what was not | `docs/evidence/<date>-<what>.md` | same |
| Cases | every situation the thing must carry, each marked measured, tested, pattern, or gap | `docs/<name>-cases.md` | `docs/mycelium-cases.md` |
| Vocabulary | the words a project uses and the ones it avoids | `.agents/mycelium.yml` (types, predicates, domains) | same |
| Decision | one locked choice with its source and time | a Mycelium `decided` fact | same |
| Record | what a sprint was, where it stands, what was proven, for a reader who was not here | wherever the project publishes, written by Understory | `docs/notes-sprint.md` in the pilot |
| Retired | a design that is no longer operating authority | `docs/archive/<date>-<what>.md`, dated, pointing at its replacement | same |

The catalog's index of these is the "Where facts live" table in its
`AGENTS.md`; a project keeps its own such table there.

## Levers for a document an agent will run

Borrowed, with the reasons in the design note, from a public catalog's
guide to writing for agents. Each is a knob that changes what an agent
does every run, not a matter of taste.

| Lever | Meaning | Test |
| --- | --- | --- |
| Context pointer | The line that names a document and says when to reach it. Its wording, not its target, decides whether the agent gets there | Does the pointer carry the leading word and one trigger per real branch? |
| Two loads | Always-loaded lines cost the agent every turn; documents behind pointers cost the person, who must remember they exist | Is this line paying context load for something only some runs need? |
| Information hierarchy | In-file steps first, in-file reference next, disclosed reference behind a pointer last | Does every branch need this, or only some? |
| Completion criterion | Every step ends on a condition the agent can tell done from not-done | Is it checkable, and does it demand enough (every X accounted for, not "a list of X")? |
| Leading word | One pretrained word the agent thinks with, repeated as a token (tight, red, seam) | Can three lines of restatement collapse into one word? |
| Positive phrasing | State the target behaviour; a prohibition drags the banned thing into context | Can the ban be rewritten as what to do? |
| Environment as truth | `--help`, config, the directory tree are sources; a document that restates them is a cache that goes stale | Would a reader find this by looking? Then leave it there |
| Pruning | Sediment settles because adding feels safe; a no-op is a line the agent already obeys | Does this line change behaviour versus the default? If not, delete the sentence |
| Splitting | Split by sequence when later steps tempt the agent to rush the current one; otherwise keep one document | Would hiding the later steps change how carefully this one is done? |

## CLI

```text
de-novo skills herbarium check [--project ROOT] [--json]
```

| Count | What is counted | Fails the run |
| --- | --- | --- |
| `links n/n` | relative Markdown links in public files, outside code, that resolve to a path | a broken one |
| `anchors n/n` | `#heading` parts of those links, and same-file `#heading` links, that name a heading in the target (GitHub's slug rule) | a broken one |
| `copies n exact` | a line of prose of 80 characters or more, outside code and tables and headings and pointer lines, found in two or more public files | any |
| `copies n near` | a run of 14 words, after case and punctuation are dropped, shared by two public files that hold no exact copy; one finding per pair, with the first run | any |
| `copies n similar` | a paragraph of 25 words or more, half of whose word 4-grams (of the shorter of the two) appear in a paragraph of another file, for a pair not already reported; one finding per pair, with the paragraph's first line | never; shown for a person |
| `language n` | public files holding letters outside the named script | any |
| `pages n/n` | human pages whose prose (outside fences and tables) is within the cap | one over |
| `archive n` | links from active documents into the archive | never; shown for a person |

`--project ROOT` names the project; omitted, the nearest
`.agents/herbarium.yml` above the current directory is used. `--json`
prints `{ root, ok, counts, findings }`.

## Not measured yet

A paraphrase that kept fewer than half its 4-grams in the other file; a document in the
right house that is simply wrong. Both are a reader's job.
