# Parallel overlay Kubernetes lab

Explore how independent changes share a baseline, how Grove detects an incorrect
runtime, and how interrupted operations recover. The application, adapter, and
runner are included here; no private project is needed.

[Recorded results and limitations](../../evidence/2026-09-06-kubernetes-lifecycle.md).

Run from the catalog checkout:

```bash
node docs/evaluation/kubernetes/run.mjs /absolute/path/to/result.json
```

This opt-in experiment creates a private k3d cluster, disposable Git worktrees,
real Docker images, a shared synthetic web/API baseline, and independently
routed overlays. The public Grove CLI manages every overlay.

Prerequisites are the locally available `docker`, `k3d`, and `kubectl` commands
and the image tags used by the runner. The runner owns its generated cluster,
image tags, loopback listeners, kubeconfig, and Grove registry. It checks the
cluster ownership label before deletion and compares pre-existing container
IDs and the default kubeconfig before and after execution. Never substitute an
existing cluster name or kubeconfig. Docker build cache is retained; the runner
does not prune the machine's shared cache or engine set.

Docker builds overlap. Image imports are sequenced per private cluster because
concurrent `k3d image import` calls contend for the same tools container. This
runner coordinates its imports; independent consumer processes still need their
own shared importer coordination. Grove does not supply that backend lock.

The normal lifecycle runs with Grove's default timeouts. Only the intentionally
stale-image and unready-Pod probes shorten the verification deadline. A separate
case waits for the real default command timeout and retries the exact operation.

The experiment measures:

- Independent source edits, overlapping Docker builds, and distinct running images.
- Web-only, API-only, paired overrides, and shared fallthrough routing.
- Peer response content while another worktree changes or fails.
- Actual build failure and Pod readiness failure.
- A stale runtime image despite an accepted attachment receipt.
- Same-environment exclusion, process-group death, and dead-owner recovery.
- Default timeout, partial deletion, idempotent retries, and repeated cleanup.

Counts, durations, candidate/source hashes, command receipts, failures, and
cleanup observations come from the JSON report. Preserve failed attempts;
setup or fixture failures are not product failures or passing acceptance cases.
Check the planned case count as well as the number that actually executed.

The synthetic Kubernetes adapter uses atomic per-environment ConfigMap patches
and a private router. Other routing implementations, business correctness,
authentication, data/event isolation, and production performance need separate
validation. The lab does not measure developer productivity.

Raw reports may contain local executable and checkout paths. Keep new reports
outside the repository until reviewed for publication. Normalize local paths,
retain failure outcomes, and publish only synthetic application evidence.

The Docker-free target guards run with `npm test`. They prove unsafe target
selection is rejected before a Kubernetes executable can run; the opt-in lab
supplies the real runtime execution boundary.
