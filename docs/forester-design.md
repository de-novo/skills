# Forester — analyse the work, then keep this machine's slots full

Written 2026-09-08. Status: design proposal. The name was chosen the same day:
a forester plans the forest, decides what is planted where, and knows how many
trees the ground can carry, which is this skill's whole job next to Grove (the
ground), Dryad (the seats), and Canopy (the screen). Once the implementation lands,
`skills/forester/SKILL.md` owns the pattern and `infra/lib/forester.mjs` owns the
parse and the allocation rule. This note keeps only the reasons.

## What it is

One sentence: **you give it the work, you say how many things this machine can
run at once, and it keeps that many assigned.**

Three parts, and they are separable:

1. **Analyse.** Turn a body of work into items with dependencies and expected
   file ownership. An agent does this by reading the skill; the CLI never calls
   a model.
2. **Budget.** How many items may be active at once *on this machine*.
3. **Allocate.** Pick the ready items, up to the budget, and hand them to Dryad
   as seats. When a worker reports done, a slot frees and the next item can go.

## Why it is not part of Dryad

Dryad seats one worker: a worktree, an environment, a task, a journal. It has
no opinion about which work should exist or in what order. Adding a plan and a
budget to it would make one skill answer two unrelated questions, and it would
put a scheduler inside a thing whose whole contract is "one seat".

Separating them also settles a question that was awkward while they were one
thing. Dryad's contract says it launches no agent. Forester is free to decide
its own contract without touching that.

This is the same split that already happened once: Grove stops at the ground,
Dryad seats workers on it.

## Where the values live

The catalog rule is that a skill is a pattern and the values live in the
project. Forester splits its values one step further, because two of them are
not the same kind of fact.

| Fact | Home | Tracked |
| --- | --- | --- |
| The pattern: how to analyse work into a plan | `skills/forester/SKILL.md` | yes |
| This project's plan, and a budget if the project sets one | `.agents/forester-plan.yml` | yes |
| This machine's budget, used when the project sets none | `.agents/forester.local.yml` | **no** |

The budget is usually a property of the machine: a laptop running three
shared engines cannot seat eight agents, and the same repository on a
workstation can. That is why it has a gitignored local home, the convention
this catalog already uses for `addressing.local.yml` and
`runtime-profile.local.yml`.

A project may still declare one, and **when the project declares it, the
project's value is followed**. A team that has decided its repository takes
two workers at a time has made a decision about the project, and a local file
must not quietly override it. The local file is the answer only when the
project has not given one.

## The plan

```yaml
version: 1
project: { slug: acme }
tasks:
  define-shape:
    task: "Decide the response shape and write it into the reference"
    owns: [docs/reference/**]
  api-endpoint:
    task: "Add the endpoint returning that shape"
    owns: [src/api/**]
    depends_on: [define-shape]
  web-panel:
    task: "Show it in the page"
    owns: [src/web/**]
    depends_on: [define-shape]
    retry: { max_attempts: 2 }
```

Fields on a task: `task` (the one line a worker is seated with), `owns`,
`depends_on`, and optionally `role` and `retry`. `phase` with `allowed_roles`
is a candidate borrowed from the reference implementation, held back until
something needs it.

`owns` is the field with no prior art to copy. The reference implementation
describes file ownership in prose but does not carry it in its declared
schema, so this is ours to get right. It is a **claim, not a lock**: the plan
says which files an item is expected to touch, and the allocator refuses to run
two items whose claims intersect. Nothing stops a worker from editing outside
its claim, and Dryad's existing `overlaps` still reports what actually happened.
A claim that turns out wrong is a plan defect, and it should be visible as one.

## The budget

```yaml
version: 1
parallel: 3
```

That is the whole local file. In the plan it is the same key, `parallel`, at
the top level next to `tasks`. Resolution is one rule: the plan's `parallel`
if present, else the local file's, else an error. Neither grows (a per-role
budget, a cap on environments) until something measured needs it.

## The allocation rule

A pure function of the plan, the seat states, and the budget. No model call, so
the same inputs give the same assignment every time.

1. An item is **done** when its seat reported done, **active** when it has a
   live seat, **blocked** while any `depends_on` is not done, otherwise
   **ready**.
2. Walk the ready items in declared order.
3. Skip one whose `owns` intersects an active item's `owns`.
4. Stop when active reaches `parallel`.

Ties are broken by declaration order rather than by any estimate. An estimate
would be a guess presented as a decision, and the order a person wrote the plan
in is real information.

## Verbs

```text
forester plan    [--json]     the graph: done, active, ready, blocked, and why
forester next    [--json]     what would be assigned now; changes nothing
forester assign  --apply      create the Dryad seats for those items
forester status  [--json]     the budget: slots filled, items waiting
```

`next` exists so the decision can be read before it is taken, the same way
Grove's overlay verbs plan before they apply.

Refilling is a command first. When a worker reports done, running
`assign --apply` again fills the freed slot. A daemon may run that same
command on the person's behalf when one is needed (decided 2026-09-08), but it
adds nothing the command does not have: it watches the seats and calls
`assign --apply`, and everything it decides is readable by running the
command by hand. The daemon is an optional verb, not the only way to refill.

## Invariants — not weakenable

- **No model call in the CLI.** The analysis is done by an agent reading the
  skill, and it produces a file. `infra/lib/forester.mjs` parses and decides.
  The reference implementation's own report is that roughly 40% of tokens went
  to coordination before it made scheduling deterministic.
- **Forester does not create environments or worktrees itself.** It asks Dryad,
  which asks Grove. One backend, named once.
- **The project's budget wins; the local one is the fallback.** A committed
  `parallel` is followed as written. The local file is never committed and is
  read only when the plan sets none.
- **A claim is not a lock.** `owns` constrains allocation, not the filesystem.
- **Order is declared, not inferred.** No priority model, no estimate-based
  scheduling.

## Not this

- Decomposing a goal by calling a model from the CLI.
- A queue server, or a daemon that decides anything on its own. A daemon that
  only re-runs `assign --apply` and reports is allowed when needed.
- Verification. Whether an item's work is good enough to land is a separate
  gate and a separate decision.
- A screen. Canopy already owns that, and `forester plan --json` should be
  shaped so Canopy can read it.

## Open question

**Does Forester launch the agent into the seat it created?** Today a seat is
created and a person or their tool starts the worker. Forester could do that
step, and it was measured as feasible on 2026-09-08: five seats, three
different tools, all five reported done in 90 seconds. The same day the two
remaining tools on this machine were started the same way, as a detached
process with its pid recorded and no third-party launcher in between, and both
wrote the file they were asked for and exited on their own. Every tool present
here has a single-turn mode that takes the task on its command line and an
auto-approve flag, so the launch is one command template per tool. Which tools
a machine has is a machine fact, so those templates would live in the local
file next to the budget.

Headless is not the only way to seat a worker. Every tool here also starts
interactively with the task as its first argument, and macOS ships `screen`,
so a seat can be a detached `screen` session that a person attaches to when
the tool asks for approval, and detaches from again. Measured 2026-09-08: one
tool started that way in a detached session, wrote the file it was asked
for, and the session was closed by name. The two modes are one field on the
tool's template, `headless` or `attended`. Attended keeps every approval in a
person's hands, at the price that a slot stays filled until somebody attends
it; headless fills slots without attention, at the price that every approval
is bypassed, which is acceptable only inside a boundary that can be thrown
away.

Against doing it: the tool-agnostic promise is easier to keep when the launch
is somebody else's business, and that space is crowded with tools that do only
this. For it: a budget that refills itself is worth more than one that needs a
command each time.

Not decided here. The rest of the design does not depend on the answer.

## Seating a real session, not a headless one (2026-09-08)

The decision is that a seat runs the tool's real interactive session, the
same thing a person would open, not `claude -p` or `codex exec`. Two reasons.
Every approval stays with a person. And the interactive session is the
surface the subscription is priced for: on 2026-05-14 Anthropic announced
that `claude -p` and Agent SDK use would leave the subscription pool for a
separate metered credit, then paused that change on 2026-06-15 before it took
effect. Headless is not forbidden today, but it is the surface whose terms
have already moved once.

How the tools that do this today do it, read from their sources:

- **Paseo** (`packages/server/src/terminal/agent-hooks/*`) installs each
  CLI's own hook into its config, `~/.claude/settings.json`,
  `~/.codex/hooks.json`, an OpenCode plugin file, and maps events to three
  states: `running`, `idle`, `needs-input`. Claude's `Notification` with
  `idle_prompt` is `needs-input`; `Stop` is `idle`. Its in-app sessions use
  the Claude Agent SDK instead, which is the metered surface.
- **Superset** (`packages/agent-setup`, `packages/host-service`) holds every
  session in a `node-pty` pseudo-terminal owned by a daemon, installs one
  notify script into thirteen CLIs' hook configs that POSTs the event to the
  daemon, and additionally scans the PTY's OSC title bytes for state. Before
  launch it seeds trust for the new folder into `~/.claude.json`
  (`projects[<path>].hasTrustDialogAccepted`) and Codex's `config.toml`
  (`trust_level = "trusted"`) so the first interactive launch does not park on
  the trust dialog.
- **Orca** exposes the same shape as verbs: `terminal create --command`,
  `terminal send --text --enter`, `terminal wait --for exit|tui-idle`,
  `terminal read --screen`, and `worker-show` whose `agentWait` names a worker
  parked on a prompt only a human can answer, with the evidence that proved
  it: hook, prompt text, or title.

The three agree on the shape: a daemon owns the pseudo-terminals, the tool's
own hooks say `running`/`idle`/`needs-input`, the rendered screen is the
fallback, and a person attaches to a session when it needs them.

Measured here, without any of those tools:

- macOS ships `screen` 4.00.03. It can hold a detached session that runs a
  tool interactively, and close it by name. It cannot inject keys: `-X stuff`
  did nothing, on a plain shell as well as on a TUI. Its log flag works.
- A fresh directory that is its own git root parks Claude on the trust dialog
  with "No, exit" selected. A worktree of an already trusted checkout does not
  (the CLIs treat the repo root as the trust domain), so Dryad seats on a real
  project are not affected. The playground sandbox is, because it is a fresh
  `git init`.
- `claude` started under nohup inside my own session's environment works
  only with `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` unset.

What this settles for Forester:

- `assign --apply` seats the item and starts the tool's interactive session
  in a pseudo-terminal held by a Forester daemon. The daemon is the thing
  that owns terminals; that is the reason it exists, not refilling.
- State comes from the tool's own hook events, written by a one-line hook
  command into the seat's `run/` directory, so `plan` and `status` read files
  and never a screen. The screen is read only to show a person what a
  `needs-input` seat is asking.
- Trust is seeded the way Superset does it, into each CLI's own sanctioned
  store, and only for a folder Forester itself just created.
- The pseudo-terminal is held with `@lydell/node-pty` (decided 2026-09-08).
  Node 26 has no built-in pty. Upstream `node-pty` 1.1.0 needs an install
  script with a `node-gyp` fallback and ships no Linux prebuilds; the fork
  ships prebuilt binaries for darwin, linux, and win32 on both arm64 and x64,
  installs with no scripts in well under a second, and is MIT. `tmux` is not
  on this machine and macOS `screen` cannot inject keys, so a multiplexer
  would have been a machine requirement on top of a dependency. This is the
  catalog's second runtime dependency after the YAML parser, and it is
  optional: everything but the daemon works without it.
- Measured 2026-09-08 through that module, with no other tool: a real
  `claude` session in a 120x40 pty on a fresh git root showed the trust
  dialog; Down and Enter, sent 2.5 s after it rendered, accepted it (keys
  sent 300 ms after render were ignored); the task ran, the file appeared,
  and the seat-local `Stop` hook wrote its payload to `run/events.log`, all
  in 12.5 s. After `Stop` the session showed a further dialog, so a finished
  seat is closed by ending the process, never by typing `/exit`. Trust for
  that folder was recorded in `~/.claude.json` by the tool itself.

## What landed

- **2026-09-08, first round.** `infra/lib/forester.mjs` owns the plan and
  local-file parsers, the budget rule, the item states, the allocation rule,
  and the verbs `plan`, `next`, `assign [--apply]`, `status`; the CLI wires
  `forester`; `skills/forester/` owns the pattern and the fields. `assign
  --apply` seats each chosen item as the Dryad seat of the same id. Seats the
  plan does not name take no slot and are counted as `outside`. Measured in
  the playground sandbox with real worktrees and real overlay envs, budget
  and claim holds released by done reports: [evidence](evidence/2026-09-08-forester.md).
  `npm test` 243/243 (235 before), 11 guards reverted for red 11/11.
- **2026-09-08, second round.** `infra/lib/forester-serve.mjs` owns `serve`
  and `attach`: the daemon holds each seated item's real interactive session
  in a pseudo-terminal from `@lydell/node-pty` (optional dependency), refills
  the budget every poll, reads Claude Code's hooks through `--settings` for
  running / idle / needs-input with a screen fallback for a dialog before
  the first prompt, seeds folder trust the way Superset does, closes a
  session when its seat reports done, and relays viewers over a unix socket
  with the recent output replayed. Measured with two real Claude Code
  sessions in the playground sandbox, every prompt answered through the
  socket, both items committed and done in 74 s: [evidence](evidence/2026-09-08-forester.md).
  `npm test` 245/245, 9 more guards seen red. Session states and the local
  file's `tools` are owned by `skills/forester/references/plan.md`.
- **2026-09-08, third round.** `infra/lib/forester-hooks.mjs` owns `hooks`:
  one marked entry per event in the hook store of every tool found on the
  machine (Codex, Grok, Cursor, OpenCode), gated on `FORESTER_EVENTS` so it
  does nothing outside a serve session, removable with `--remove`. This is
  the Paseo and Superset shape, and Orca's own entries were already in the
  Cursor and Grok stores here. With it, every tool reports running / idle /
  needs-input the same way; Claude Code keeps its per-session `--settings`.
  Measured with Codex, Grok, Cursor, and OpenCode items under one serve:
  [evidence](evidence/2026-09-08-forester.md). The tool-native paths
  (`claude --bg`, `opencode serve`) were looked at and not taken: each holds
  one tool's session, and the point of serve is one way for every tool.

## Measurement plan

| Seam | Check |
| --- | --- |
| Parse | A plan with a cycle, an unknown `depends_on`, or a duplicate id is rejected with the offending id named |
| Readiness | Item blocked until its dependency reports done; then ready in the same `plan` output |
| Claims | Two ready items with intersecting `owns` are not both assigned; disjoint ones are |
| Budget | `parallel: 2` assigns exactly 2 of 4 ready items; a done report frees exactly one slot |
| Precedence | A plan with `parallel: 2` and a local file with `parallel: 5` assigns 2; with no `parallel` in the plan, the local file's 5 applies |
| Local file | The budget file is gitignored, and no budget anywhere is an error rather than a silent default |
| End to end | A real plan run in the playground sandbox, seats created by `assign --apply`, workers seated, the budget refilled after a completion |

Revert each guard once to see red, and record how many went red.

## First evidence to collect

The playground is the right first ground: it is disposable, it has a sample
project, and a five-seat run already works there. The question that run should
answer is not whether the code runs but **whether a person can read
`forester plan` and know what is happening**, which is the thing this catalog has
never measured for anything it has built.
