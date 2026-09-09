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
| `language` | The script public surfaces use. `en`: a file holding Hangul, Han, kana, Cyrillic, Arabic, or Thai letters is counted | `en` |
| `public` | Globs of every document a reader from outside may meet. Required, non-empty | — |
| `pages.globs` | Globs of the human pages held to the cap | none |
| `pages.max_words` | The cap on a page's prose, outside code fences | 450 |
| `archive` | Globs of retired documents. A link into them from an active document is shown, not judged | none |
| `ignore` | Globs never read. Symlinks are never followed | none |

Unknown keys are rejected. Globs: `**` spans directories, `*` stays inside
one segment.

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
| `copies n` | a line of prose of 80 characters or more, outside code and tables and headings and pointer lines, found in two or more public files | any |
| `language n` | public files holding letters outside the named script | any |
| `pages n/n` | human pages whose prose is within the cap | one over |
| `archive n` | links from active documents into the archive | never; shown for a person |

`--project ROOT` names the project; omitted, the nearest
`.agents/herbarium.yml` above the current directory is used. `--json`
prints `{ root, ok, counts, findings }`.

## Not measured yet

Anchors inside a target file (`file.md#heading` is checked to the file);
a copy that was paraphrased rather than pasted; a document in the right
house that is simply wrong. The first two are later counts; the third is
a reader's job.
