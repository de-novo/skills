---
name: catalog
description: >-
  Add, edit, rename, or review a published skill in the de-novo skills
  catalog (skills/<name>/). Use when creating a new skill, splitting
  SKILL.md vs README vs examples, wiring .agents load paths, updating the
  catalog README table, or when the user runs /catalog. Not for planting
  Grove on a consuming project — that is grove.
metadata:
  internal: true    # repo-only: the skills CLI hides it unless INSTALL_INTERNAL_SKILLS=1
---

# Catalog

This skill is for **this repository**. How to work here in general:
[`AGENTS.md`](../../../AGENTS.md). Load adapter:
[`.agents/README.md`](../../README.md).

A published skill is a pattern other projects install. Project values do not
belong in it.

## Houses

| File | Owns |
| --- | --- |
| `skills/<name>/SKILL.md` | Pattern. Agent prompt. YAML frontmatter `name` + `description`. |
| `skills/<name>/README.md` | The human page, under about 400 words: a diagram if one helps, then **What it does** (with the one defining constraint), **When to reach for it** (invocation mode and the trigger boundary), **It's working if** (tells a reader can check without opening SKILL.md), **Where it fits**, **What it does to your machine** (writes, downloads, runs, undo, as a table; one line when it only reads), **Apply to a project**, **Pointers**. |
| `skills/<name>/references/` | The long facts: fields, registry, CLI tables, state machines. The README and SKILL point here; neither restates them. |
| `skills/<name>/examples/` | Shape of values, not a required backend. |
| `skills/<name>/agents/openai.yaml` | Codex picker metadata: `interface.display_name`, `interface.short_description`; for a user-invoked skill also `policy.allow_implicit_invocation: false`. |
| `.agents/skills/<name>` | Relative symlink to `../../skills/<name>`. |
| `.claude-plugin/plugin.json` | The plugin manifest: every published skill in `skills`, nothing else. CI diffs the two. |
| Root `README.md` Skills table | One-line index, grouped user-invoked / model-invoked. |
| `infra/addressing.yml` | This checkout's TLD and hostname scheme. Clone override: `addressing.local.yml`. |

`name` in frontmatter equals the directory name.

## Invocation

Every skill is one of two:

- **Model-invoked** (the default): a model or a person may reach for it.
  The description is model-facing and keeps its trigger phrases ("Use
  when…", `/name`). Grove, Dryad, Understory, Mycelium: a seat reaches for
  them on its own when its work meets them.
- **User-invoked**: only a person typing `/name`. Frontmatter carries
  `disable-model-invocation: true` and `agents/openai.yaml` carries
  `policy.allow_implicit_invocation: false`; the two are always set
  together or neither. The description is human-facing, one or two
  sentences, no trigger list. Forester: the plan is a person's ask.

A skill that tells the agent to run another skill says so as a tool call,
one skill per call: `Call the Skill tool with "dryad"`. A relative link
(`[dryad](../dryad/SKILL.md)`) is router prose for a person and fires
nothing. Nothing may name a user-invoked skill to the Skill tool; tell the
person to run it instead. In a host with no Skill tool the same sentence
means: read that skill's `SKILL.md` from the installed copy (a seat has
Dryad's path in `$DRYAD_SKILL`; the others sit beside it) and follow it.
That fallback is the root README's, stated once; skills do not repeat it.

## Add a skill

1. Create `skills/<name>/SKILL.md`. Pattern only — no domains, ports, service
   lists, or real commands. Those go in a consuming project's
   `.agents/runtime-profile.yml` (Grove) or the equivalent values file the
   skill names.
2. Write `README.md` next to it in the seven-section shape above, and put
   every field or CLI table in `references/`. Do not paste the SKILL body
   into the README; point.
3. Decide the invocation (above) and write `agents/openai.yaml`.
4. `ln -s ../../skills/<name> .agents/skills/<name>`
5. Add the path to `.claude-plugin/plugin.json` `skills`, then
   `claude plugin validate . --strict`.
6. Add one row to the root README Skills table, in its invocation group.
7. Public surfaces are English.
8. If the skill has parser or CLI behavior in `infra/`, add tests under
   `infra/bin/` and revert the production change once to see the new test
   go red. Then `npm test`.

Tool dirs (`.claude/skills`, `.cursor/skills`, `.grok/skills`) already point
at `.agents/skills`. Do not copy the skill there.

Do not add the new skill's pattern to `AGENTS.md`. Point at `skills/<name>/`.

## Edit a skill

Change the house that owns the fact. If the same sentence exists in SKILL
and README, edit the owner and make the other a pointer.

Grove-specific: schema lives in `references/runtime-profile.md`; invariants
are judged in `infra/lib/profile.mjs`. Do not restate the schema in SKILL.md.

## Not this skill

- Planting Grove on another repo → `grove`
- Starting or stopping machine engines → `infra/` CLI, and only when asked
- Changing how agents work in this catalog (invariants, verify, no-down) →
  `AGENTS.md`
