# Catalog review execution evidence — 2026-09-05

Base: `a77f0800269792f014d0ccad37886cb959f95d81`.
Candidate: uncommitted working-tree changes; no candidate commit was created.
Target: Grove skill/docs, profile validation, and overlay lifecycle verification
in `/Users/denovo/orca/denovo/dev-infra`.

## Result and compatibility

Machine setup and provisioning execution are unchanged. Their existing account
credential/grant effects and ownership requirement are now explicit; init and
help no longer imply that routine inspection authorizes setup.

Attach now requires runtime image equality and readiness. Project adapters must
report `{ service, image, ready }` observations. Existing name-only inventories
remain inspectable but cannot prove an attach; missing inventory or unmeasured
tracked identity makes status non-zero. Registry storage needs no migration.
Profile validation rejects unknown documented keys, malformed command/service
values, and missing default profiles. Backend-specific runtime profile options
remain project-owned. See the current schema and overlay contract for authority.

The original unified design and multi-machine proposal moved to `docs/archive/`
with preserved bodies and explicit historical status. The ignored machine-local
registry note was not changed. `data.infra: project` remains a supported backend
choice; runtime compatibility was not deleted without consumer evidence.

## Executed checks

| Command | Observed result |
| --- | --- |
| `npm test` | 172 tests passed, 0 failed, 0 skipped |
| `node --test infra/bin/overlay-process.test.mjs` | 1 passed; executable artifacts 2/2, rejected transitions 2/2, detached endpoints 1/1, destroyed environments 1/1 |
| `node infra/bin/cli.mjs validate skills/grove/examples/minimal.runtime-profile.yml` | configuration invariants 5/5 |
| `node infra/bin/cli.mjs validate skills/grove/examples/multi-service.runtime-profile.yml` | configuration invariants 5/5 |
| `node infra/bin/cli.mjs urls skills/grove/examples/minimal.runtime-profile.yml` | URL rendering succeeded |
| `node infra/bin/cli.mjs urls skills/grove/examples/multi-service.runtime-profile.yml` | URL rendering succeeded |
| `node infra/bin/cli.mjs --help` | owner-authorized setup help rendered |
| `bash -n infra/bin/provision` | shell syntax accepted |
| `git diff --check` | no whitespace errors |

Additional direct CLI executions used a temporary `grove-review-cli-*` directory
and removed it afterward: init plus validation succeeded; the complete schema
YAML passed; invalid service fields, invalid runtime/default command values,
and `runtime.writer` typo were rejected 3/3. The canonical schema block is also
executed by `infra/bin/profile.test.mjs` on every `npm test`.

The process test launches only its own temporary Node workloads on ephemeral
loopback ports. Running executables derive their immutable identity from their
own bytes. Project status measures that identity and HTTP readiness. The test
keeps the old executable running during a replacement attempt, observes the
rejection, then executes a new artifact returning HTTP 503, observes another
rejection, recovers with a ready artifact, and checks HTTP absence after detach.
This measures the lifecycle contract against a real process backend.

## Guards reverted and restored

Each mutation was applied to production code or the canonical example locally,
the selected tests went red, and the candidate file was restored in `finally`.
The complete passing suite above ran after restoration.

| Local mutation | Exact selected command | Tests that went red |
| --- | --- | --- |
| Restore base profile parser/report | `node --test --test-name-pattern 'documented profile values reject\|validation reports configuration scope' infra/bin/profile.test.mjs` | 28 |
| Replace attach identity/readiness check with service presence | `node --test --test-name-pattern 'attach cannot finalize' infra/bin/overlay.test.mjs` | 3 |
| Remove per-service image/readiness drift comparison | `node --test --test-name-pattern 'status refuses a clean result' infra/bin/overlay.test.mjs` | 3 |
| Accept absent runtime inventory as a clean status | `node --test --test-name-pattern 'status without runtime inventory' infra/bin/overlay.test.mjs` | 1 |
| Restore base schema reference YAML | `node --test --test-name-pattern 'schema reference complete YAML' infra/bin/profile.test.mjs` | 1 |

Total: 36 failing test observations across 5 mutations. These are regression
sensitivity measurements, not additional successful runtime deployments.

## Untouched boundaries

Shared engine reconciliation, SQL provisioning, migrations, real container/k3d
rollout, and project hostname routing: `notMeasured`. Their implementations were
not changed or exercised. No shared engine or database mutation, commit, push,
or PR publication was performed. The local process backend evidence does not
claim any consuming project's adapter has been migrated or deployed.
