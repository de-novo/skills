# Documentation

Current operating authority:

- [Grove pattern](../skills/grove/SKILL.md)
- [Onboarding and human diagram](../skills/grove/README.md)
- [Profile schema](../skills/grove/references/runtime-profile.md)
- [Overlay contract](../skills/grove/references/overlay-contract.md)
- [Dryad pattern](../skills/dryad/SKILL.md) and [profile, registry, CLI](../skills/dryad/README.md)
- [Catalog machine backend](../infra/README.md)
- [Catalog working rules](../AGENTS.md)

## Product direction

[Grove value and intended experience](grove-product-direction.md) evaluates
current capabilities, alternatives, differentiation hypotheses, and adoption
measurements. It is an analysis, not operating authority or approved scope.

## Design records

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
