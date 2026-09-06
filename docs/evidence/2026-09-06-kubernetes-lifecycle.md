# Synthetic Kubernetes lifecycle evidence — 2026-09-06

Grove was exercised against a disposable web/API application using actual Git
worktrees, Docker builds, Kubernetes workloads, and HTTP requests. All application
and adapter source used by the lab is available in this repository.

## What the run demonstrates

| Capability | Observed result |
| --- | --- |
| Independent changes | Two worktrees built different images with overlapping Docker builds; each overlay served its own version |
| Thin overlays | Web-only, API-only, and paired overrides used the synthetic baseline for services without overrides |
| Runtime verification | Unready Pods and stale images could not finalize attachment |
| Recovery | Interrupted operations, the default command timeout, and partial deletion retained recoverable state |
| Isolation during changes | Baseline and peer API response contents matched in 3,282/3,282 observations |
| Repeated cleanup | Five lifecycle cycles and ten duplicate cleanup calls completed; the final registry and route map were empty |
| Browser observation | Web/API versions matched in 3/3 environments after reload |

The accepted run completed 12/12 planned scenarios. These counts are a dated
execution result, not a performance guarantee or a permanent test-suite count.

## Reproduce and inspect

Run the [Kubernetes lab](../evaluation/kubernetes/README.md) from the catalog
checkout. The recorded invocation was:

```bash
node docs/evaluation/kubernetes/run.mjs docs/evaluation/kubernetes/attempt-05.json
```

Execution base: `0725d06520ae0ca2062bbff6236da7332cb8840e` plus uncommitted changes.
The [accepted receipt](../evaluation/kubernetes/attempt-05.json) records exact
execution source hashes, commands, timings, observations, and cleanup. Source
hashes matched at the beginning and end of the run. Published local paths are
normalized; counts and outcomes are preserved.

Supporting checks at the time of the run:

- `npm test`: 182/182 passed.
- [Browser observations](../evaluation/kubernetes/browser-results.json): 3/3 matched.
- [Target guard mutation](../evaluation/kubernetes/guard-mutation.json): removing
  the guard in an isolated copy made three tests fail while the positive control
  still passed.
- The private cluster and temporary worktrees were removed. Pre-existing
  container IDs and the default kubeconfig remained unchanged. Shared Docker
  build cache was retained.

## Failed attempts and backend constraints

Failed runs remain available alongside the accepted receipt:

- [Attempt 01](../evaluation/kubernetes/attempt-01.json): API port selection in
  the lab setup failed.
- [Attempt 02](../evaluation/kubernetes/attempt-02.json): the lab HTTP client did
  not deliver the required Host header.
- [Attempt 03](../evaluation/kubernetes/attempt-03.json): concurrent k3d image
  imports collided on the same tools container name.
- [Attempt 04](../evaluation/kubernetes/attempt-04.json): a macOS temporary-path
  comparison needed realpath normalization.

The accepted runner sequences image imports per cluster while retaining parallel
Docker builds and independent overlay operations. Separate backend processes
need their own import coordination; the runner's queue does not provide it.
Backend locks also need their own interruption and recovery checks. Grove's
registry recovery does not establish recovery of every adapter-owned resource.

## Scope

The adapter uses atomic per-environment ConfigMap updates and a private router.
The evidence covers this synthetic application and backend. Authentication,
business workflows, database/event isolation, other routing implementations,
empty-machine setup, resource savings, and developer productivity were not
measured. Cached base images were available. No production-readiness or speedup
claim follows from these results.
