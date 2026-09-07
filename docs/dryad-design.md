# Dryad — a seat on a tree

Written 2026-09-06. Status: design record. Implemented the same day. Design
base: `69418fc`. This document is not an operating specification. The pattern is
owned by [`skills/dryad/SKILL.md`](../skills/dryad/SKILL.md), the schema,
registry, and CLI by [`skills/dryad/README.md`](../skills/dryad/README.md), and
the checks by `infra/lib/dryad.mjs`. This document keeps only the reasons for
the decisions. Where the implementation differs from the design: under
`GROVE_STATE_DIR` the registry also goes into a `dryads/` subdirectory, so it
does not overlap Grove's files. `report`'s `--session` overwrites the seat's
value. `status` reads Grove `overlay status --json` to count whether an env is
tracked and what work is in progress.

## In one sentence

Grove is the ground. Dryad makes a **seat** on one tree (one worktree) of that
ground for one worker, counts how many seats there are, who sits in them, and
what they did, and clears the seat when the work is done. Which worker sits in
which seat, and with which tool, is decided by a person. Dryad does not start a
worker.

## The boundary

| Question | Owner |
| --- | --- |
| Names, engines, overlay env, lease, the applied judgment | Grove |
| Creating, registering, and clearing a seat (worktree + env + task text), the seat count and the history | Dryad |
| Which task in which seat, with which tool | A person |
| Running the agent process, continuing a conversation, detecting idleness and permissions | The launcher (a terminal, a worktree manager app, tmux, an ACP client, and so on). Outside Dryad |
| Task DAGs, supervision loops, mailboxes, escalation | The orchestrator. Outside Dryad |
| Branch merging, pushing, review | People and the project. Dryad does not do them |
| Browser QA, e2e | The project. Outside both skills |

The dependency runs one way. Dryad uses Grove. Grove does not know about Dryad
and works unchanged without it. In the other direction, Dryad has to work with
worktrees alone on a project with `overlay: none`. A single-claude setup is just
the case where every seat uses the same launcher; it is not a separate mode.

The contact with Grove is three public CLIs only.
`de-novo skills overlay create/destroy/status`, `urls`, `validate`. It does not
import `infra/lib/overlay.mjs`. The path a person types by hand and the path
Dryad walks have to be the same, so that a result measured at one boundary is
valid for both. The cost of starting itself as a child process is accepted.

## Why Dryad does not start an agent

On 2026-09-06 the sources of two worktree manager apps and the official
documentation for ACP and each CLI were checked. The summary is in
[Tools consulted](#tools-consulted). There are three conclusions.

- The way an agent is started differs per tool and changes quickly. Neither
  seating a TUI on a PTY, nor a tool's native protocol, nor the single ACP
  protocol is a size a small CLI should own.
- A one-shot headless run such as `claude -p` cannot continue a conversation,
  and it misjudges the completion of an interactive tool that stays alive after
  the session ends as the process exiting. Neither of the two apps checked uses
  the exit code as a completion signal.
- Both apps checked create the worktree themselves. If Dryad monopolized
  worktree creation, it would fight these tools.

So Dryad's output is a **seat**. A seat is a bundle of values that can be handed
to any launcher as it is, and the launcher is not a value and is outside Dryad.

## Vocabulary

- **seat**: one worktree + one overlay env (when there is an overlay) + the task
  text + the `DRYAD_*` environment variables. The id is a DNS label and is the
  same as the overlay env name. The Grove registry and the Dryad registry meet
  on the same key.
- **dryad**: the worker sitting in a seat. It may be a person, or an agent
  started with some tool. Dryad only writes down the name tag (`--by`) of who
  sat there.
- **launcher**: whatever takes a seat and seats a worker in it. A person doing
  `cd` in a terminal and opening a tool is a launcher too.
- **journal**: the lines that pile up in time order for each seat. What Dryad
  did and what the worker reported. It is not overwritten.
- **baseline checkout**: the original directory where the project was cloned. A
  seat is not created here. This is the same line as Grove's "do not start the
  baseline from an agent worktree".

## The values file

`.agents/dryad-profile.yml`, committed to the project repository. The top-level
key whitelist of `runtime-profile.yml` is an invariant, so nothing is piled on
there. A separate file, a separate parser. The allowed top-level keys are two:
`version` and `worktrees`. Anything else is rejected.

```yaml
version: 1                       # omitted = 1. Any other value is rejected
worktrees:
  root: ../<slug>-dryads         # where Dryad creates them. Relative to the baseline, and must be outside the repository
  branch: "dryad/{id}"           # the only placeholder allowed is {id}. The result must be a valid git ref
```

The reason there are only these values is that the launcher is outside. Which
tool to start with which flags is the launcher's configuration, not Dryad's
value. A project that only adopts seats can omit `worktrees` entirely, and then
`plan` is rejected without `--worktree`.

If `root` points inside the baseline checkout, it is rejected. A worktree
created inside the repository dirties the baseline's git status and makes it
easy for a worker to step on another seat.

## The registry

`~/.dev-infra/dryads/<slug>.yml`. The same directory rules as the Grove overlay
registry (respect `GROVE_STATE_DIR`, rename a temporary file, private
permissions, a short read/merge/write lock). No credentials are kept there.

```yaml
version: 1
project: acme
seats:
  w1:
    worktree: /Users/me/acme-dryads/w1
    owned: true                  # false = adopted. finish does not remove the worktree
    branch: dryad/w1
    base: 0123456789abcdef0123456789abcdef01234567
    task: |
      add a refund endpoint to the billing API
    env: w1                      # null = the profile is overlay: none
    by: claude                   # a name tag a person gave. Not validated
    session: null                # filled by report --session. The tool's session id or log path
    created_at: 2026-09-06T02:10:00Z
    status: working              # the last report. planned|working|blocked|done
    journal:
      - { at: 2026-09-06T02:10:00Z, actor: dryad, event: plan, detail: "worktree add dryad/w1 at 0123456" }
      - { at: 2026-09-06T02:10:04Z, actor: dryad, event: overlay.create, detail: "ok env w1" }
      - { at: 2026-09-06T02:31:12Z, actor: seat,  event: report, detail: "working" }
      - { at: 2026-09-06T03:02:40Z, actor: seat,  event: report, detail: "blocked: the payment mock response does not match the schema" }
```

`journal` is append-only. `actor: dryad` is what Dryad did, `actor: seat` is
what the worker reported with `report`. `status` is only a summary of the last
report; the journal owns the history.

The registry is a mirror of the state, not a controller. If a worktree is gone
or an env is out of step, `status` counts and reports that fact. It does not fix
it silently.

## What is tracked, and what is not

| Question | Where the answer is |
| --- | --- |
| Which worktree, which branch, which base did it start from | The seat entry |
| What task was given, who sat there | `task`, `by` |
| What was changed in the code | The branch's commits. `git log <base>..dryad/w1` |
| What was attached to and detached from the shared environment | The Grove overlay registry. Per env: the mutation, the image, the time, and the worktree that made it |
| When it went through which state | The journal |
| Exactly what happened inside the tool | The tool's native log that `session` points at. Dryad does not open it |

What is not kept: the order of the commands the worker ran and the files it read
(that is the tool log's job), and anything done outside the worktree (writing to
a shared DB directly, and so on — the Grove rules forbid it, but it is not
watched). Seeing each individual action needs a PTY or hooks, and that is the
launcher's job.

## The CLI

```text
de-novo skills dryad plan   <id> (--task <text> | --task-file <path>) [--worktree <existing-path>] [--by <label>] [--project <root>] [--apply]
de-novo skills dryad seat   <id> [--json | --env | --shell] [--project <root>]
de-novo skills dryad report <id> --status <working|blocked|done> [--note <text>] [--session <ref>] [--project <root>]
de-novo skills dryad status [id] [--project <root>] [--json]
de-novo skills dryad finish <id> [--project <root>] [--apply]
```

If `--project` is omitted, it walks up from cwd looking for
`.agents/dryad-profile.yml`. When a worker calls it inside a worktree, the
worktree's `.agents/` is what gets found, so the baseline path is passed through
`DRYAD_PROJECT`. The registry slug is read from that baseline's
`runtime-profile.yml` `project.slug`. The Dryad profile has no slug. This is so
the same fact does not live in two houses.

### plan

Without `--apply`: it prints the worktree path it would create, the branch, the
base commit, and whether there is an env. It creates nothing.

With `--apply`, in order:

1. Check that the id is a DNS label, is not in the registry, and is not tracked
   as an overlay env either.
2. The worktree.
   - No `--worktree`: `worktrees` must be in the profile. The target path must be
     empty. From the baseline,
     `git worktree add --no-track -b <branch> <path> HEAD`. `owned: true`. The
     base is that HEAD.
   - `--worktree <path>`: the path must exist, `git rev-parse --git-common-dir`
     must equal the baseline's, and it must not be the baseline itself. The
     branch and HEAD are read and written down as they are. `owned: false`. The
     worktree is neither created nor changed.
3. If the runtime-profile has an overlay,
   `de-novo skills overlay create <id> --apply --project <baseline>`. The exit
   code and the last JSON line are written to the journal. On failure the seat
   is left with `env: pending` and the exit code is 1. The worktree that was
   created is not removed.
4. Record the seat with `status: planned`, and `plan` in the journal.

Calling `plan --apply` again with the same arguments skips the steps that are
already done and does only the remaining ones. If the worktree already exists on
that branch it passes, and if the env is `pending` only step 3 runs again. This
is the same shape as Grove's pending recovery.

### seat

Reads the seat from the registry and prints it. It checks that the worktree
exists, and if it does not, it still prints with exit code 1. A person has to be
able to go and see why it is missing.

- `--json`: `{ id, project, worktree, branch, base, env, task, by, env_vars: {...} }`
- `--env`: four lines in the form `DRYAD_ID=w1`
- `--shell`: one line, `cd '<worktree>' && export DRYAD_ID='w1' DRYAD_ENV='w1' DRYAD_BRANCH='dryad/w1' DRYAD_PROJECT='<baseline>'`. Values are wrapped in single quotes and the quotes are escaped.

`DRYAD_ENV` is an empty string when there is no env. The task text is not put
into an environment variable, because of length limits and shell quoting
problems.

### report

Updates `status` and appends a `report` line to the journal. `--note` goes in as
it is, and `--session` overwrites the seat's `session`. The only validation is
the status value and the existence of the seat. Sending `working` after `done`
is not blocked. A person has to be able to seat someone again.

### status

With no argument: it counts the whole project.

```text
■ acme — seats 3
  worktrees  3/3 present
  envs       2/2 tracked (w3: overlay none)
  reported   done 1, working 1, blocked 1
  w1  dryad/w1  +12  env w1 ready    done      by claude
  w2  dryad/w2  +3   env w2 ready    working   by codex
  w3  dryad/w3  0    -               blocked   by human   "orders schema decision needed"
```

`envs` is the result of calling
`de-novo skills overlay status --project <baseline>` once and cross-checking its
result against the seats. `+12` is `git rev-list --count <base>..HEAD`.

`status <id>`: in addition to the line above, it prints the whole journal in
time order.

There are four conditions that make the exit code 1. A seat has no worktree. A
seat that should have an env is not in overlay status, or the reverse. Overlay
status itself is non-zero. There is a `blocked` seat. Each of them appears in
`--json` as an entry in the `problems` array.

### finish

Without `--apply`: it prints the env it would destroy, the worktree it would
remove (only when owned), and the branch that stays.

With `--apply`, in order:

1. If there is an env,
   `de-novo skills overlay destroy <id> --apply --project <baseline>`. On
   failure it writes to the journal and stops. The seat stays. Exit code 1.
2. If `owned: true` and the worktree is clean (`git status --porcelain` prints
   nothing), `git worktree remove <path>`. If it is dirty it writes to the
   journal and stops. The seat stays. Exit code 1. There is no `--force`.
3. If `owned: false` the worktree is not touched.
4. The seat is removed from the registry. The branch stays.

Removing it from the registry removes the journal too. To keep the history,
capture `status <id>` to a file before finish. Dryad is not an archive.

## Examples of handing a seat to a launcher

Dryad runs none of the following. A person or an orchestrator does.

```bash
# a person, directly in a terminal
eval "$(de-novo skills dryad seat w1 --shell)" && claude

# a launcher that creates the worktree first: adopt that worktree
de-novo skills dryad plan w2 --worktree <launcher-created-path> --task-file tasks/w2.md --by codex --apply

# a script: read the seat JSON and use whichever tool you want
de-novo skills dryad seat w3 --json | my-launcher --stdin
```

## When a worker wakes up

Whatever the launcher, the worker starts with the worktree as cwd and the
`DRYAD_*` environment variables set. The task text goes in as the first prompt,
so no file is written inside the worktree. Git status has to start clean so that
only the worker's changes remain.

An outline of `skills/dryad/SKILL.md`:

```text
frontmatter  name: dryad, description: triggers are the presence of DRYAD_ID, /dryad, "seat"
# Dryad
One sentence. This file owns the pattern; values live in .agents/dryad-profile.yml.
## You are a dryad when
When DRYAD_ID is set. Read your own seat with seat --json. Otherwise ignore this section.
## Rules
1. Do not change anything outside your worktree. Not the baseline, not other seats.
2. Verify with the /grove procedure. The env already exists. attach is yours, destroy is finish.
3. When stuck, report blocked --note. At every large turn of the work, report working --note.
4. When done, commit, report done, stop. Pushing, merging, and finish are a person's.
5. If the tool gives a session id or a log path, leave it with report --session.
## Seating others (the section a person or an orchestrator reads)
plan → hand to the launcher → count with status → finish. One line and a link per command.
## Not this skill
Launchers, mailboxes, DAGs, merging.
```

Completion is the worker's own report. It does not depend on the tool, and needs
neither PTY parsing nor hooks. Wiring `report done` to a tool's hook or a
launcher's completion event is the project's or the launcher's choice, and Dryad
does not require it.

## Candidate invariants

To be fixed before implementation. Values may change; these do not.

- One worktree per seat. No seat is created in the baseline checkout.
- Dryad does not start an agent process. The launcher is outside.
- A dirty worktree is not removed. An adopted worktree is not removed. A branch
  is not removed.
- Completion is the worker's report, not the process exiting.
- The journal is not overwritten.
- Grove is called only through the public CLI.
- No merging, pushing, or reviewing.
- Success is counted. `seats n`, `worktrees n/n`, `envs n/n`, `reported …`.

## The state on Grove's side (checked 2026-09-06, a correction)

The first round of this document said the "cannot tell in-progress from aborted"
problem that the 2026-09-05
[worktree experiment](evaluation/2026-09-05-worktree-evaluation.md) pointed at
was still there. That was wrong. That experiment is a diagnosis from before the
fix, and the fix was already measured with
[the parallel execution change evidence](evidence/2026-09-05-overlay-parallel.md)
and `infra/bin/overlay-parallel.test.mjs` and went into `b794a82`. Grove now
records pending per env and takes a per-env lock, so different envs do not block
each other. Dryad uses the seat id as the env name, so two seats never touch the
same env. **A concurrent attach from two seats can be measured with no
precondition on Grove's side.**

What is left is not blocking but reporting. Even on an applied mutation that is
proceeding normally, Grove writes pending before dispatch and removes it after
observation. During that time the whole `overlay status` returns `pending 1` and
exit code 1, and does not say whether the pending belongs to a live process or
to an abort. Dryad `status` counts this as an "overlay status returned non-zero"
problem. For a person counting other seats while one seat is attaching, that is
a false alarm. The seat that fixes it is Grove's house. If it marked
`pending-item … in-flight` when the owning pid of the env lock file is alive and
`stalled` otherwise, Dryad could stop counting in-flight as a problem. The exit
code contract stays as it is.

## Measurement plan

`infra/bin/dryad.test.mjs`. A temporary git repository as the baseline, a
temporary directory as `GROVE_STATE_DIR`, and Grove's process-workload fixture
for the overlay commands.

| Check | What is counted |
| --- | --- |
| Profile parser: allowed keys, rejecting a placeholder other than `{id}`, rejecting a root inside the repository | rejections n/n |
| plan without `--apply`: no side effects at all | worktrees 0, no registry |
| plan `--apply`, the create path | worktree 1/1, the branch, base = HEAD, env 1/1 (on a profile with an overlay), 2 journal lines |
| plan `--apply`, the adopt path | no worktree created, `owned: false`, a path from another repository is rejected, the baseline itself is rejected |
| plan re-run: again after overlay create failed | first run env pending, second run env tracked 1/1, the worktree unchanged |
| seat in its three forms | the `--json` fields, the four `--env` lines, running `--shell` through a real `sh -c` so that cwd and the environment variables reach a fixture process |
| report | status updated, journal appended, session stored |
| the four status exit codes | 1 after removing the worktree, 1 after the env goes out of step, 1 after blocked, 0 when normal |
| finish, the create path | destroy called 1/1, worktree 0 when clean, worktree kept and exit 1 when dirty, the branch exists |
| finish, the adopt path | the worktree unchanged, only the seat removed |
| two seats planned `--apply` at the same time | worktrees 2/2, envs 2/2, both in the registry |

The `--shell` check measures the "hand it to the launcher" boundary. Starting a
real tool (claude, codex, and so on) is outside Dryad, so it is out of scope
rather than `notMeasured`. Verifying two seats attaching at the same time sits
on top of the path Grove's parallel overlay already measured, so it can be
measured now, and it has not been measured yet.

For every new guard, revert the production change, see the test go red, and
restore it. Write the number that went red in the PR.

## Implementation order

1. `infra/lib/dryad.mjs`: the profile parser and the registry read/merge/write.
   Tests.
2. `plan` (both paths), `seat`, `report`, `status`. Wire up the CLI verbs. Tests.
3. `finish`. Tests.
4. `skills/dryad/SKILL.md`, `README.md`, `examples/`, the `.agents/skills/dryad`
   symlink, and the root README row. Following the catalog procedure.
5. A harness for two seats attaching at the same time. The in-flight/stalled
   marking in Grove's `overlay status` is a separate Grove PR.

Each step is one PR. The PR description records the candidate SHA, the commands
that ran, the counted result, and the number of tests that went red.

## Improvements that came out of the first real use (2026-09-06)

What was added after trying two real projects (a temporary repository, and five
seats in the brand site repository). The grounds are in
[the evidence record](evidence/2026-09-06-dryad.md).

- `seat` hands out `DRYAD_SKILL` (the path to SKILL.md inside the catalog). In a
  worktree without the symlink, a worker had no way to reach the skill.
- `seat --task`. The launcher command becomes one line, without `$(cat file)`.
- finish moves the journal to `<slug>.finished.yml` and `status --finished`
  reads it. At audit time, the journal of a seat that had already been finished
  was gone, so it had to rely on the conversation record.
- One line of notice when `report done` has no session. Five of the five seats
  left none.
- Rule 1 was changed to "reading is allowed, writing is not", and rule 5 to
  "check before done".
- (2026-09-07) A project without Grove. The design said "it works with worktrees
  alone on a project without an overlay", but the implementation read the slug
  only from the runtime-profile and rejected the project when there was no Grove
  profile. It came out while trying to use Dryad on the catalog itself. Now the
  dryad-profile may carry `project.slug` only when there is no runtime-profile,
  and having both is rejected as a duplicate.
- (2026-09-07) The project index and seat hostnames. A tool had no way to know
  which project uses Dryad, and the seat's env name alone did not give an
  address to open in a browser. `plan --apply` writes slug → baseline root into
  `projects.yml` next to the registry, and `projects` counts live seats,
  finished seats, and whether there is an overlay. Each seat in `status --json`
  gets `hostnames`, whose value is read from Grove's `urls --json`. Dryad does
  not draw hostnames itself.

A candidate that was withdrawn: assigning a port per seat. On a project without
an overlay, dev server ports had to be split by hand per seat, but the answer is
not ports; it is an overlay adapter and names. On the same day a process backend
adapter and a hostname router were planted on that project, the two seats ran
again by name alone, and Grove's create, attach, readiness observation, and
destroy were measured on a real project for the first time. The record is in the
evidence document.

## Things to consider in the second round

Only after the seat contract has set. They are not in the first round.

- **Waiting for completion.** An orchestrator polls `status --json` and waits for
  `done`. `dryad wait <id> --for done|blocked --timeout` would be convenient, but
  it touches the "Dryad does not supervise" boundary. Look at it when polling
  actually becomes inconvenient.

- **A built-in ACP client.** The only documented common machine interface is ACP.
  If a built-in launcher becomes necessary, one thin client handling
  `session/new`, `session/prompt`, and `session/request_permission` could cover
  several tools. It is neither `-p` nor a PTY. The launcher argv becomes a value
  at that point.
- **Journal archiving.** If it becomes too costly for finish to remove the
  journal, look at leaving the file with `finish --archive <dir>`. For now
  redirecting `status <id>` is enough.
- **When create happens.** One real team's overlay tool binds an env to a
  worktree and a revision, so a create at plan time went out of step with attach.
  It was solved by having the adapter create it again before attach, but whether
  the profile could carry "the env is created at the first attach" is a candidate
  on Grove's side.
- **Emphasizing hostnames.** The hostnames in `status --json` are all of the
  env's names. Showing only attached services, or attaching whether a service is
  attached, is Canopy's second round's job.
- **A supervision mailbox.** Things like `worker_done`, `ask`, and `escalation`
  are an orchestrator's job. Dryad `report` is not a smaller version of that; it
  is one line of a seat's last state.

## Tools consulted

Checked 2026-09-06. For the two worktree manager apps the source was read; for
the rest the official documentation.

| Approach | Representative | Follow-up message | Idle and completion detection | Worktree |
| --- | --- | --- | --- | --- |
| Start a shell on a PTY and run the TUI as a startup command | Desktop worktree manager app A, Claude Squad, Superset | Write text and Enter into the PTY | A hook reports `working/blocked/waiting/done` over local HTTP; the fallback is a regex on the terminal title and screen | The app creates and removes them under its own path |
| A per-tool native protocol | Daemon-style worktree manager app B (Claude via the Agent SDK `query()`, Codex via `app-server` JSON-RPC, OpenCode via `serve` HTTP, the rest via ACP), Symphony | Push into a live session | The protocol event `turn_completed`; permission requests go to the UI | The app creates and removes them under its own path |
| The single ACP protocol | Emdash, Zed, JetBrains | ACP `session/prompt` | The ACP stop reason | One worktree per task |

ACP coverage: Claude Code (`claude-agent-acp`), Codex (`codex-acp`), Gemini
(`--experimental-acp`), OpenCode (`opencode acp`), Cursor (`cursor-agent acp`),
Grok (`grok agent stdio`). Clients include Zed, JetBrains, Neovim, and Emacs.

## The name

The npm `dryad` is a package stopped at 0.0.0, and Microsoft Research Dryad is
archived data-parallel research (checked 2026-09-06). This skill is not an npm
package and its CLI is `de-novo skills dryad`, so there is no collision.

## What it does not do

- Running an agent process, PTYs, screen parsing, installing hooks.
- Schedulers, queues, priorities, DAGs, mailboxes. The order a person calls
  `plan` in is the order.
- Automatic merging, conflict resolution, PR creation.
- Importing Grove's internal modules.
- Adding a key to `runtime-profile.yml`. Duplicating the slug in the Dryad
  profile.
