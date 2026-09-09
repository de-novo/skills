# The notes pilot: one sprint through every skill, in a playground sandbox — 2026-09-09

The first sprint run end to end on the whole stack: a person's goal, a
Forester grilling, a plan, two rounds of Dryad seats (Claude Code and
Codex), overlays verified by name, facts proposed by seats and committed by
a judge, a Codex seat unblocked by a fact another seat had left, the seat
branches merged by a person, the baseline restarted and verified, an
Understory record written by an agent, seats finished, sandbox down with
the machine untouched. Catalog at `45adb70` plus the fix this PR carries.

## Harness

| Piece | Value |
| --- | --- |
| Project | the playground sample (api, web, router; notes in one JSON file), in a sandbox under the session scratchpad, its own git repo |
| Vocabulary | `.agents/mycelium.yml`: domains `notes`, `sprint`; types `item decision module check seat`; predicates `decided caused-by depends-on passed failed tried-and-failed`; judge `human:jhpark` |
| Budget | `.agents/forester.local.yml`: `parallel: 2`, tools `claude` and `codex` |
| Skills in the project | copied into `.agents/skills` and `.claude/skills`, because the sandbox refuses symlinks (isolation rule 1) |
| Sessions | Claude Code 2.1.265 for the Forester and two seats; Codex 0.153.4 (`-a on-request -s workspace-write --add-dir <sandbox>`) for one seat; all in Orca terminals, driven with `terminal send` and `wait --for tui-idle`, approvals answered by the driver |
| Person | the driver, answering the grilling, committing facts as judge, merging, restarting the baseline |

## What happened, in order

1. **Grilling.** `/forester` with a three-sentence goal. The session read the
   sample (10 tool calls), then asked twelve numbered questions in one
   round, each with a recommended answer: POST contract, validation,
   note shape, persistence, where the count comes from, page scope,
   README shape and its edge, which item Codex takes, verification through
   overlays, retries, budget, and whether to record the decisions. Answer:
   "yes to all twelve".
2. **Decisions into the log.** The session proposed twelve `decided` facts
   to Mycelium (source: the grilling round and the session id); the judge
   committed all twelve. Then the quiz: three items as vertical slices with
   `owns`, one edge (README waits for the api), three questions
   (granularity, edges, merge or split). Answer: yes.
3. **Plan.** The session wrote `.agents/forester-plan.yml`, ran
   `forester plan` and `forester next`, and stopped. The driver committed
   the plan and ran `forester assign --apply`: `assigned 2/2 · slots 2/2`,
   `api-add-note` (claude) and `web-count` (codex), each with an overlay env.
4. **Round one.** Each seat woke with the seat environment and one
   sentence ("You woke up seated: DRYAD_ID is set…"). Both read
   `$DRYAD_SKILL` and `dryad seat --task` before anything else. Both
   reported `working` at real turns.
   - The Claude seat added POST /notes (83 insertions, one file), hit a
     refusal from `tools/build.mjs`, worked around it, attached its own
     revision as overlay `api-add-note`, verified POST 201 / 400 ×3 / GET
     through the router by name, and reported done with the session
     reference. It proposed two facts: the verification, and a
     `tried-and-failed` on the build refusal with the workaround spelled out.
   - The Codex seat added the count row (2 insertions), hit the same
     refusal, could not attach, and reported **blocked** with a
     `tried-and-failed` fact of its own.
5. **Unblocking through the log.** The judge committed the seats' facts.
   The driver told the Codex seat one thing: read `mycelium query --brief
   --domain sprint`, fact `a-d2b16a361a` has the workaround. Codex used it,
   attached `web--web-count`, verified 7/7 by name (count 6 matching the
   baseline api), and reported done with a `passed` fact.
6. **Round two.** `forester assign --apply` seated `readme-notes-api`
   (claude) in the slot the api item freed. It queried the notes domain
   first, attached the api image the first seat had built (no rebuild),
   ran 16 curl calls through the router by name, wrote a 303-line README,
   and reported done with a `passed` fact that names the one case not
   exercised (503).
7. **Merge and restart.** `forester plan`: `items 3 · done 3`. The driver
   merged the three seat branches on `main` (one merge commit, 3 files).
   `tools/baseline.mjs up --apply` built new images but did not restart
   the running services; the driver stopped the three baseline processes
   by hand and ran `up` again. Then, by name through the router: POST
   answered with the stored note at the merged revision, GET listed 7,
   the web page showed `notes count 7`, an empty title answered 400,
   DELETE answered 405.
8. **The record.** `/understory` in the Forester session wrote
   `docs/notes-sprint.md` (1003 words): the Mermaid graph from the CLI,
   the reading lines with `· facts` ids, the decisions table by fact id,
   and a "what is proven" table with the unexercised case in it.
9. **Finish and down.** `dryad finish --apply` ×3: worktrees removed,
   branches kept, journals archived; overlays 0. `playground down`: ports
   0, machine mentions 0, directories remaining 0. Machine Dryad and
   Mycelium files hold 0 mentions of the sandbox.

## Counts

| | |
| --- | --- |
| Grilling questions, rounds | 12, 1 |
| Items, seats, tools | 3, 3, Claude ×2 and Codex ×1 |
| Facts in the log at the end | 17 active, 0 staging, 0 invalid: 12 decisions, 3 passed, 2 tried-and-failed |
| Seat journals | 5, 6, 4 lines; every seat reported working then done; the Codex seat also blocked |
| Overlays attached and verified by name | 3 of 3 seats |
| Merged baseline checks by name | POST, GET 7, count 7, 400, 405 |
| Approval prompts answered by the driver | Claude seats: about 70 across three sessions; Codex: 27 |
| Machine registry mentions after down | 0 |

## Found on the way

- **Product defect, fixed in this PR.** `playground/tools/lib/sandbox.mjs`
  took the sandbox root from the file's parent directory; from a seat
  worktree at `<sandbox>/seats/<id>` that is `seats`, so every seat's
  `build` and `overlay` refused `GROVE_STATE_DIR` as outside the sandbox.
  Two seats found it independently and wrote it down as `tried-and-failed`
  facts; the third seat and the unblocked Codex seat read the workaround
  from the log instead of rediscovering it. The root now comes from the
  `.agents/playground.json` marker a seat's worktree carries; the new test
  plans a real seat and builds from it, and goes red when the fix is
  reverted (1).
- **Sample gap, not fixed.** `tools/baseline.mjs up` does not restart
  running services at a new revision; the profile says `reflect: restart`
  but the sample has no restart verb. The driver stopped the processes by
  hand. A restart verb, or `up` restarting on a changed image, is a later
  change to the sample.
- **Sandbox rule met the planting rule.** Isolation rule 1 refuses
  symlinks inside the sandbox, and the planting rule says never copy a
  skill body. Inside a throwaway sandbox the copy wins; the Forester
  session made that call itself and said so.
- **Driver friction.** Claude Code's `--allowedTools` patterns do not cover
  compound commands, and Codex asks per command under `on-request`; a
  person answered roughly a hundred prompts. `forester serve` with its
  hooks is the designed path for this and was not used here so that every
  prompt could be read.
- **Prompt wording.** The Forester session first called the CLI as
  `de-novo skills forester`; the sandbox runs the catalog's `cli.mjs`
  directly, which takes the verb without `skills`. It corrected itself.

## Not measured

`forester serve` holding the sessions (Orca terminals were used instead);
Codex reading the skills from `.agents/skills` on its own (the seat was
told the path); a second sprint on the same log, where the decisions from
this one would be read before grilling; a person other than the driver
reading `docs/notes-sprint.md` cold.
