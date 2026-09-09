# Skill eval in fresh sessions — 2026-09-09

The unit suite proves the CLI. It says nothing about whether an agent that
reads a skill cold does what the skill says. This record is three probes,
each in a fresh Claude Code session (2.1.265, Fable 5.1) that had never
seen this conversation, driven through Orca terminals on an Orca worktree
of the catalog at `45adb70` (the tree after PR #8). What was sent, what
came back, and what it was checked against.

## Harness

| Piece | Value |
| --- | --- |
| Checkout | Orca worktree `skill-eval` of this repo, branch from `main` at `45adb70` |
| Session | `claude --permission-mode acceptEdits --allowedTools 'Bash(node infra/bin/cli.mjs:*)' …` in an Orca terminal, prompts sent with `orca terminal send`, turns awaited with `terminal wait --for tui-idle` |
| Evidence | the session's own transcript under `~/.claude/projects/…/*.jsonl` (assistant text and tool calls), the Dryad journal, `git show` in the seat |
| State | probe C ran with `GROVE_STATE_DIR` set to a scratch directory; the machine registries hold 0 mentions of the eval afterwards |
| Teardown | terminals closed, `dryad finish eval-seat --apply`, `orca worktree rm --force`, seat branch deleted; the seat's commit was cherry-picked into this PR |

## Probe A: Forester grills before it plans

Sent: `/forester Goal: add a --since ISO flag to understory reading that
hides items whose seats reported nothing since that moment. Do not write
any file yet; start from the skill.`

| Checked for | Observed |
| --- | --- |
| Reads before asking | 14 tool calls first: the Understory reference and module, the Forester and Dryad modules, the seat journal shape |
| One numbered round with a recommendation each | nine questions `Q1`…`Q9`, each with `→` and a one-line reason; none depended on another's answer |
| Waits | ended the turn with "Answer with numbers, or just 'all recommended'. I will not write any file until the frontier is empty and the item list has been quizzed." |
| After `all recommended`: the quiz | two items as vertical slices, each with task, delivers, owns, and `blocked by`; then the three questions the skill names (granularity, edges, merge or split), each with its own recommendation |
| Locked decisions to Mycelium | offered: "the nine answers are `decided` facts worth proposing", and held it because of the no-write instruction |
| No file written | `.agents/forester-plan.yml` absent at the end; the session said so itself |

Verdict: the grilling, the vertical-slice rule, the quiz step, and the
Mycelium seam all fired from the skill text alone.

## Probe B: Clearing reads before it speaks

Sent: `/clearing` in the same session, twice.

| Checked for | Observed |
| --- | --- |
| Reads the two screens first | one Bash call running `understory reading` and `mycelium query --brief` before any prose |
| First run, dependencies missing | both verbs failed (`Cannot find package 'yaml'`); the reply said "The screen could not be read", refused to guess, and separated what it could point at from what it could not |
| Second run, dependencies present | `understory reading` → `plan not found`; `mycelium query --brief` → one active fact; the reply quoted both, said "What is done: nothing in the project", listed three open items, and ended with one next action |
| Shape | 227 words, sections for goal, done, moving, open, next; no filler |

Verdict: the "say nothing that is not on that screen or in that log" rule
held under a failing screen and under a partial one.

Harness defect found here: the Orca worktree was created with
`--setup skip`, so `node_modules` was absent. The skill's behavior was
right; the harness was not. Fixed by `npm install` in the worktree.

## Probe C: a seat's done report is a handoff

A seat `eval-seat` was planned from the eval worktree with a brief in the
Dryad shape (outcome, boundary, verification, report, forbidden). A fresh
session was started in the seat's worktree with the `dryad seat --shell`
environment and told only: "You woke up seated: DRYAD_ID is set. Follow
the dryad skill from the start."

| Checked for | Observed |
| --- | --- |
| Reads the skill and the task through the CLI | `cat`-equivalent Read of `$DRYAD_SKILL`, then `dryad seat "$DRYAD_ID" --json` and `--task` |
| Reports working at a real turn | `report --status working --note "Read task; editing skills/clearing/SKILL.md …"` before the edit |
| Stays inside the boundary | one file changed, `skills/clearing/SKILL.md`, 7 insertions |
| Verifies with the named check | `node --test infra/bin/catalog.test.mjs` → 4/4 |
| Commits on its branch, does not push | commit `bd4eb62` on `dryad/eval-seat`; no push, no merge, no `finish` |
| Done report is a handoff | note: revision and base, what changed in one sentence, "Only that file changed", the counted check, "Open: review and merge by a person; not pushed" |
| Session reference | `--session https://claude.ai/code/session_…` included |
| Stops after done | last assistant text: "The seat is reported as done and I have stopped" |
| Mycelium proposal | none; nothing in the task outlived the seat, and the log in the scratch state holds 0 rows |

Verdict: the worker rules and the new handoff paragraph were followed
without a person in the loop beyond permission prompts. The seat's commit
is in this PR as `Clearing: name what it is not`.

## Counts

| | |
| --- | --- |
| Sessions | 2 fresh (one for A and B, one for C) |
| Tool calls | A: 14 reads then 0 writes; B: 1 Bash per run; C: 9, of which 1 edit and 1 commit |
| Permission prompts answered by the driver | B: 3, C: 7; all `Yes` to Bash commands whose compound form fell outside the allowlist |
| Files changed by the eval in the catalog | 1, by the seat, carried in this PR |
| Machine registry mentions of the eval after teardown | 0 |

## Not measured

Codex or another harness reading the same skills; a person who was not
here reading a short README and saying whether they know when to reach for
the skill; Forester actually writing the plan and `assign --apply` seating
the two items it proposed (the no-write instruction stopped it there on
purpose).

## Found on the way

- An eval worktree needs its dependencies installed before a skill can run
  the CLI; Orca's `--setup skip` leaves that to the driver.
- `--allowedTools 'Bash(node infra/bin/cli.mjs:*)'` does not cover a
  compound `a; b` command, so every combined call prompted. A driver that
  wants no prompts needs a broader pattern or a single-command habit in the
  skill text; the skills were left as they are.
