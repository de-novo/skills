# `.agents/` — load adapter

Canonical published skills live in `skills/<name>/`. Tools that scan
`.agents/skills/` (Claude, Cursor, Grok, and others) see the same trees
through **relative symlinks**, not copies.

```
.agents/skills/<name>  →  ../../skills/<name>
.claude/skills         →  ../.agents/skills
.cursor/skills         →  ../.agents/skills
.grok/skills           →  ../.agents/skills
```

Add a published skill under `skills/`, then symlink it here. Procedure:
[catalog](skills/catalog/SKILL.md). Working rules: [`AGENTS.md`](../AGENTS.md).

Installing from outside a checkout goes through the plugin manifest in
`.claude-plugin/` (root README, Install), not through these symlinks.

Repo-only skills (not published to consuming projects) may live here as real
directories. `catalog` is one — it teaches how to work on this catalog.

Do not put a second `SKILL.md` body under `.claude/`, `.cursor/`, or `.grok/`.

This catalog is not a consuming app. `.agents/runtime-profile.yml` is planted
by `de-novo-skills init` in *other* projects. Do not add one here.
