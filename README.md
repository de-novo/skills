# de-novo skills

Research and publish agent skills for development environments and how we work.

The source of truth for each skill is `skills/<name>/SKILL.md`. Human docs sit next to it as README. Project-specific values do not belong in a skill.

Agents working in this catalog: [`AGENTS.md`](AGENTS.md). Skill load paths: [`.agents/`](.agents/).

## Skills

| Name | One line |
| --- | --- |
| [grove](skills/grove/) | Shared local ground: n projects, m apps each, one infra set |

## CLI

Grove's machine-engine, profile, and overlay-lifecycle tool. Once per **this
catalog** checkout, not per consuming project:

```bash
npm install && npm link
```

Then consuming projects call `de-novo skills infra status` (and `infra up`,
`setup`, `init`, `validate`, `urls`, `overlay`). Projects choosing this machine
backend do not copy its `infra/` directory; projects choosing another backend
keep their own operating procedure. `de-novo-skills` is an alias without the `skills`
token. Machine engines are Grove-central (`infra` next to this CLI). `setup`
provisions a project's isolation units on that set. Without a link,
`node infra/bin/cli.mjs …` works the same. There is no down command —
stopping machine infra is a human decision because several projects live on it.

Engine table and ports: [`infra/README.md`](infra/README.md).
Overlay lifecycle and cleanup contract:
[`skills/grove/references/overlay-contract.md`](skills/grove/references/overlay-contract.md).

## Layout

```
AGENTS.md        how agents work in this catalog
.agents/         skill load adapter (symlinks into skills/)
skills/          skill sources. add a skill as <name>/SKILL.md
  grove/         first skill
infra/           machine-shared engines Grove uses
  addressing.yml this checkout's TLD and hostname scheme
  docker-compose.yml engine catalog (profile = engine id)
docs/            documentation index + archived designs
```

Documentation index and historical designs: [docs/README.md](docs/README.md).
