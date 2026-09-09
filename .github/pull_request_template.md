## What

<!-- Which house changed: a published skill (pattern), infra/ (backend + CLI), or agent load paths. What a reader sees differently after the merge. -->

## Execution evidence

<!-- AGENTS.md: a change is not merge-ready until the path it changes has been executed at the closest real, safe boundary. "Tests pass" without the command and the counted result is not evidence. -->

Candidate `<sha>` on `<branch>`, target `main` at `<sha>`.

```bash
npm test          # tests n, pass n, fail 0
```

| Guard reverted once | Red |
| --- | --- |
| <!-- every new parser or CLI guard --> | |

Real boundary: <!-- the sandbox arc, a real seat, a real slug; what was observed and counted -->

Not measured: <!-- an untouched boundary, never the behavior this PR introduces -->

## Authorship

- [ ] Human-authored
- [ ] Agent-authored (agent and model: `<name>`)
- [ ] Hybrid (agent and model: `<name>`)

What the submitting human ran and read themselves: <!-- exact commands, or "reviewed the diff only" -->

## Shared infra

- [ ] Touches no shared engine, container name, network name, or shared database.
- [ ] Needs shared-infra authority: the human gate is named below and this PR stays not ready to merge until that execution is measured.
