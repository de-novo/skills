# Grove consumer evaluation protocol

Status: exploratory protocol; decision thresholds and a production pilot remain
unapproved. This file contains no consumer identities or measured project rows.
Metric definitions and the investment question belong to the
[product direction](../grove-product-direction.md).

## Private evaluation boundary

Consumer projects are evaluation inputs only. Never put their names, paths,
URLs, owners, source SHAs, image references, source code, topology, configuration,
commands, raw logs, or anonymous-ID mappings into documentation, examples,
fixtures, commits, or memory. Do not fill this protocol with project-specific
results. Report only anonymous observations and limitations to the user.

Keep necessary identities in the active session. If execution needs temporary
files, use a private directory outside repositories and remove it afterward.
Do not collect credentials. This boundary takes precedence over recording exact
consumer commands or retaining raw evidence. Generic protocol and Grove-owned
implementation evidence may remain in this catalog.

## Confirm in the session before a production comparison

- Two consumer targets, runtime owners, permitted operations and cleanup scope.
- Existing procedure and Grove readiness, inspected without mutation first.
- Task pairs, sample size, execution order, timeout and interruption conditions.
- Acceptance thresholds for preparation time, operator effort, failures and
  initial integration cost, agreed with the owner before scoring results.
- Isolated failure targets, permitted fault injection and recovery ownership.

Reuse existing authorization for the same target and scope. Choosing evaluation
inputs does not authorize shared engine or database mutations. An exploratory
component measurement cannot stand in for an approved productivity comparison.

## Comparison procedure

1. Record first-time integration effort separately. If a project is already
   integrated and historical records are absent, report that cost as notMeasured.
2. Pair equivalent tasks within each project. Observe source identity and
   expected runtime identity in the session without retaining private values.
3. Record cache/image readiness, machine load, concurrency and data conditions.
   Do not call unobserved conditions equal or clear shared caches to equalize them.
4. Alternate execution order so one method does not always benefit from warm
   caches or familiarity. Keep normal execution and injected failures separate.
5. Apply the same independent completion check to both methods. A command's exit
   code or Grove receipt alone does not prove the comparison's runtime result.
6. Check permitted cleanup and effects on other work. Never delete pre-existing
   resources to make a cleanup count pass.
7. Include every failure and interruption. Link retries to their initial attempt
   in the session; do not replace failed observations with successful reruns.

## Observation fields

Use anonymous run and pair IDs. Observe request, ownership acquisition, execution
start, independently confirmed readiness, cleanup request and confirmed absence.
Use a monotonic clock for elapsed time within one machine. Do not subtract clocks
from different machines without verifying a common time basis.

Report elapsed waiting time separately from active person-minutes and operator
interventions. Authorization wait, build, deployment and verification are parts
of the elapsed interval; do not add them to that interval again. Count redundant
requests for authorization as interventions when actually observed.

## Failure cases and interpretation

Observe old-image rejection, readiness failure, interrupted execution and failed
cleanup only within a confirmed isolated scope. Check recovery against the actual
runtime and count remaining resources. Shared fault injection needs specific
owner authorization.

Report planned/executed runs, failures, interruptions and comparable pairs.
Separate projects, scenarios and first-time versus repeated work. Show paired
elapsed-time differences; do not hide failed pairs inside averages of successes.
Evaluate benefit together with integration, maintenance and ownership-wait cost.
Keep unmeasured outcomes explicit and avoid generalizing a small exploratory
sample to full-project productivity.
