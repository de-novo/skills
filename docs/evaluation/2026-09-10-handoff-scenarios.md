# Handoff scenarios: what each one is measured by

Date 2026-09-10. The acceptance table of the improvement brief, one row
per scenario, each pointed at the test that measures it in the suite
(`npm test`) or marked as not measured with the reason. The numbers
those tests count are in [the evidence](../evidence/2026-09-10-handoff-integrity.md);
this page says only which behavior is covered by what. The pass criteria
are correctness bars to keep, not achievements to claim.

| Scenario | Bar | Measured by |
| --- | --- | --- |
| A fresh install | gaps and compatibility named, no unapproved mutation | `doctor.test.mjs`: a tree digest equal before and after `doctor`; states per values file; the plugin version equals the package version |
| A document edit with a complete brief | only the needed path runs, no stack, daemon, or question | [the pilot](../evidence/2026-09-10-pilot-handoff.md): two seats on complete briefs asked no interview question; the Forester interview itself was not run |
| Two independent items | no scope conflict, verified in two worktrees | `forester.test.mjs` (claims hold), `integrity.test.mjs` F07 (a done outside the scope is refused) |
| B needs A's result | no start before the result is in B's base; start on the right ref | `integrity.test.mjs` F01: waiting until merged or integrated, then B's base holds A's commit and B's `inputs` name it |
| A new plan reuses an old task id | no inherited done | `integrity.test.mjs` F02, `forester.test.mjs` (attempts per revision) |
| A new attempt after a failure | branch and evidence kept, the new attempt starts | `integrity.test.mjs` F04 (`-2` branch, `--resume`) |
| Env creation or agent spawn fails | cause and recovery shown, never read as done | `forester-serve.test.mjs`: `failed` with its kind, pending retried with backoff then failed, `restart` |
| Two serves at once, resume after a crash | one owner, no duplicate process, records kept | `forester-serve.test.mjs`: the lock, the winner's socket kept, fresh-context note |
| Several projects in parallel | managed active seats within the machine cap | `forester-machine.test.mjs`: two projects, three rounds of simultaneous `assign`, stale reclaim |
| Summaries and fact commits | source traceable, staging never shown as settled | `mycelium-policy.test.mjs` (mode, refs, `ref_state`), `herbarium-structure.test.mjs` (sourced snapshots) |
| Many Canopy tabs, a long archive | bounded reads, local detail pages, partial marked | `canopy-cost.test.mjs` (process counts, `finished 20 of n`); latency in the evidence |
| An existing v1 project | no silent data loss, migration possible | `dryad.test.mjs`, `forester.test.mjs` on records without the new fields; `mycelium-policy.test.mjs` on a values file without `mode` |

Platforms: Linux with Node 24 remains the CI baseline; macOS with Node 24
now runs the same suite in CI (`.github/workflows/verify.yml`), and this
page's numbers came from macOS with Node 26. Each agent adapter's
behavior is recorded only for the tool version it was run with; nothing
here generalizes one tool's dialogs to another's.

## Metrics, first readings

| Metric | Where it is counted | First reading |
| --- | --- | --- |
| Questions before a task starts | [the pilot](../evidence/2026-09-10-pilot-handoff.md) | 0 interview questions on complete briefs; 1 trust dialog and 1 permission prompt per seat reached a person |
| Dependents started with the right input | `integrity.test.mjs` F01; the pilot | 1/1 in the fixture and 1/1 in the pilot, 0 started early |
| Wrong done verdicts | `integrity.test.mjs` F02 | 0 in the fixture |
| Duplicate daemons | `forester-serve.test.mjs` | 0 of 2 starts |
| Orphan worktrees or envs | `dryad.test.mjs` finish paths | unchanged from before |
| Documents loaded, bytes | `herbarium check` `loaded` line | 453980 bytes ≈ 113495 tokens (bytes/4 estimate) across 55 public files |
| Processes per Canopy detail page | `canopy-cost.test.mjs` | 3 |
| Canopy detail page latency, 50 seats | the evidence's benchmark | median 367 ms (was 1134 ms) |

Targets for these are set after a second reading, not before.
