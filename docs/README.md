# Documentation

Current operating authority:

- [Grove pattern](../skills/grove/SKILL.md)
- [Onboarding and human diagram](../skills/grove/README.md)
- [Profile schema](../skills/grove/references/runtime-profile.md)
- [Overlay contract](../skills/grove/references/overlay-contract.md)
- [Dryad pattern](../skills/dryad/SKILL.md) and [profile, registry, CLI](../skills/dryad/references/seats.md)
- [Catalog machine backend](../infra/README.md)
- [Catalog working rules](../AGENTS.md)

## Product direction

[Grove value and intended experience](grove-product-direction.md) evaluates
current capabilities, alternatives, differentiation hypotheses, and adoption
measurements. It is an analysis, not operating authority or approved scope.

## Design records

[Forester design](forester-design.md) proposes a third skill: analyse work into a
plan with dependencies and expected file ownership, set how many items this
machine may run at once, and keep that many assigned as Dryad seats. A budget
the project declares is followed; a local, untracked one applies only when the
project sets none. Landed 2026-09-08 in two rounds: the plan, budget,
allocator, and verbs; then `serve`, which holds each seat's real interactive
session in a pseudo-terminal, `attach`, and `hooks`, which makes Codex,
Grok, Cursor, and OpenCode report their state the way Claude Code does.

[Understory](../skills/understory/README.md) has no design note of its own:
the skill README owns the document shape, `infra/lib/understory.mjs` owns
the drawn graph and the reading lines, and the reasons are two sentences in
the Forester note. Landed 2026-09-08.

[Mycelium design](mycelium-design.md) proposes a fifth skill: an append-only
log of assertions per project, each with valid time, confidence, domain, source,
and agent, folded into the graph of what the project holds true. Workers
propose; a person or the named judge commits or invalidates. The only seam to
Forester is read-only: a seat's done report may be proposed as a fact. Landed
2026-09-08. [Mycelium cases](mycelium-cases.md) walks every situation a
shared fact store meets in a multi-worker sprint, marks each as measured,
tested, pattern, or gap at `7047aa0`, and names the second round: declared
predicates with cardinality, a lock around commit, and the reading verbs.
That round landed 2026-09-09 with its own
[evidence](evidence/2026-09-09-mycelium-round-2.md). The skills themselves
were then run cold in fresh sessions: [skill eval](evidence/2026-09-09-skill-eval.md),
and one whole sprint ran through every skill with Claude Code and Codex seats
in a playground sandbox: [the notes pilot](evidence/2026-09-09-notes-pilot.md).

[Herbarium design](herbarium-design.md) records why the documentation
discipline became a skill: one house per kind of document, the levers for
writing a document an agent runs, and one verb that counts drift; it names
what was borrowed and from where. Landed 2026-09-09.

[Playground design](playground-design.md) records the sandbox rules for the
sample project the catalog ships: one directory holds everything, no machine
registry, no port chosen in advance, no engines or containers, its own git
repository. Not implemented.


[Canopy design](canopy-design.md) proposes the second round of the read-only
page: per-worktree cards with the skill verbs actually run, the files each
seat changed, unseated worktrees, and file overlaps between seats. The seams
are defined as `dryad status --json` fields first. Not implemented.

[Dryad design](dryad-design.md) records why the second skill prepares seats
and launches no agent, and what it deliberately leaves to launchers and
orchestrators. Current behavior is owned by the skill and `infra/lib/dryad.mjs`;
the record is not operating authority.

## Reproducible examples and evidence

- [Kubernetes lifecycle lab](evaluation/kubernetes/README.md): build and change
  independent overlays, inject failures, and verify recovery in a disposable
  synthetic application.
- [Recorded Kubernetes results](evidence/2026-09-06-kubernetes-lifecycle.md):
  observed behavior, failed attempts, commands, and measurement boundaries.
- [Parallel worktree experiment](evaluation/2026-09-05-worktree-evaluation.md):
  source changes and lifecycle operations from separate Git worktrees.
- [Dryad and status extensions](evidence/2026-09-06-dryad.md): seats on real
  worktrees, concurrent attach through the process backend, in-flight and
  stalled labels, `status --json`, and the guard-reversal counts.
- [Playground arc](evidence/2026-09-08-playground.md): the sample project's
  whole arc in a sandbox with no Docker, the three defects that running it
  found, and the guard-reversal counts.
- [Forester first round](evidence/2026-09-08-forester.md): plan, budget,
  and allocator over real Dryad seats in the playground sandbox, then serve
  holding two real Claude Code sessions to done with every prompt answered
  through the socket, then hooks for the other tools with Codex, Grok, and
  OpenCode run to done; 29 guards seen red.

Published evidence uses repository-owned synthetic applications. Private project
identities, configuration, source fingerprints, and adoption history do not
belong in this documentation, including its archives.

## Archive

These records preserve decision history, not current behavior or approved work:

- [Initial design decisions](archive/2026-09-02-design-decisions.md): rationale
  for profile boundaries, optional backends, and observed lifecycle completion.
  Historical proposals are not an implementation backlog or execution authority.
- [Multi-machine proposal](archive/2026-09-05-multi-machine.md): deferred until
  repeated cross-machine needs justify a separate design. Not implemented.

Do not load archives for routine operations. Remove redundant explanations;
archive only context that still explains a decision. Runtime compatibility is
removed only after checking consumers, not because a design is old.
