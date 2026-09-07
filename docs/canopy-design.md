# Canopy — parallel work per project, on one screen

Written 2026-09-07. Status: design proposal. The first round (`5e38159`) has the
seat table and the problem row. This document records the decisions for the
second round. It is not an operating specification. Once the implementation
lands, `infra/lib/canopy.mjs` and `infra/lib/dryad.mjs` own the behaviour and
`skills/dryad/README.md` owns the fields.

## The questions a person has to get answered

On one screen, per project:

1. How many worktrees are moving right now. Both the ones that are seats and the ones that are not.
2. **What work** is happening in each worktree. One line of task, the last report, and how long ago.
3. **Which skill verbs** each worktree actually used. plan, report, attach, destroy …
4. **Which files** each worktree changed. Committed and not yet committed.
5. Are there **files that overlap**. A merge conflict has to be visible now, not at merge time.

The first round covers 1 (seats only) and 2 (the last journal line). 3, 4, and 5
have no seam.

## Principles

- Canopy only reads. Same as the first round. It does not open registry files;
  it reads only the public CLI's JSON. So the information it needs is defined
  first as **fields that Dryad `status --json` hands out**. The Canopy UI comes
  after that.
- Do not build a new tracking device. Git already knows the file changes. A
  skill use is a CLI verb run in a seat, so the CLI itself can write it to the
  journal. Both read from something that already exists.
- Compute the overlap and show it, but do not judge it. Only as far as "these
  two seats changed the same file". Who merges first and who yields is a person.

## Seam 1: skill verbs run in a seat → journal `cli` events

When a process with `DRYAD_ID` set runs a catalog CLI verb that **changes
state**, one line is appended to that seat's journal.

```yaml
- { at: …, actor: seat, event: cli, detail: "overlay attach w6 web --image acme/web:2c46dc9… --apply", exit: 0 }
```

- Verbs that are recorded: `overlay create|attach|detach|destroy|touch|prune --apply`,
  `dryad report` (a `report` event already exists, so it is not recorded twice),
  `setup`, `infra up|provision`. Read verbs (`status`, `seat`, `urls`,
  `validate`, `projects`, `canopy`) are not recorded. This is so polling does not
  bury the journal.
- The `--image` value and the arguments are written as they are; an environment
  variable such as `GROVE_PROVISION_PASSWORD` is not in argv in the first place.
  Passthrough (after `--`) is written as a SHA-256 digest only, the same as
  Grove's contract.
- The record is written once at the CLI entry point (`cli.mjs`), after the
  command ends, together with the exit code. A failed attach is recorded too.
  That is "what was attempted".
- If the seat for `DRYAD_ID` is not in the registry (it was already finished),
  it is skipped silently. A failure to record does not fail the command itself.

With this, "which skills were used" becomes a count of the journal's
`event ∈ {plan, cli, report, finish…}`. Canopy shows the per-verb count and the
last time for each seat.

## Seam 2: file changes → `changes` in `status --json`

Read from git per seat. There is no new state.

```json
"changes": {
  "base": "879559a…",
  "committed": [ { "path": "apps/web/src/routes/work.$slug.tsx", "status": "M" }, … ],
  "uncommitted": [ { "path": "apps/web/src/components/work/x.tsx", "status": "??" } ],
  "counts": { "committed": 4, "uncommitted": 1, "ahead": 2 }
}
```

- `committed` = `git diff --name-status <base>..HEAD`, `uncommitted` = `git status --porcelain`.
- Past several hundred, only the first 200 with `truncated: true`. The screen shows the count first.
- With no worktree, `changes: null`. The same for an adopted worktree.

## Seam 3: worktrees that are not seats → the project's `worktrees`

Attach the baseline's `git worktree list --porcelain` at the top level of
`status --json`.

```json
"worktrees": [
  { "path": "/…/acme", "branch": "main", "head": "73f9c01…", "seat": null, "baseline": true },
  { "path": "/…/acme-seats/w8", "branch": "…/dryad-w8", "head": "…", "seat": "w8", "baseline": false },
  { "path": "/…/somewhere/else", "branch": "feature/x", "head": "…", "seat": null, "baseline": false }
]
```

A worktree with no seat means "somebody is working in parallel, and Dryad does
not know about it". Canopy shows it as a grey column. `changes` is computed only
for seats. Reading the files of a worktree that is not a seat is looking into
another person's work, so it is not done by default.

## Seam 4: overlap → `overlaps` in `status --json`

Project level. The case where more than one seat has the same file as
`committed` or `uncommitted`.

```json
"overlaps": [ { "path": "apps/web/src/routes/work.$slug.tsx", "seats": ["w8", "w9"] } ]
```

This value does not affect `status`'s exit code. An overlap is not a problem; it
is a fact. Text `status` counts it as one line, `overlaps n`.

## The screen

```
■ acme         seats 3 · worktrees 4 (1 unseated) · envs 2/2 · overlaps 1        Grove · pending 0 · drift 0
┌ w8 · claude · 36m ───────────┐ ┌ w9 · codex · 10m ────────────┐ ┌ (unseated) feature/x ──────┐
│ ASCII figures for the sheet  │ │ scroll-led reading motion    │ │ /Users/…/somewhere/else     │
│ ● done  "3 plates in SSR…"   │ │ ● done  "5 head states…"     │ │ HEAD 1a2b3c4 · main+3       │
│ env w8 tracked → web--w8…    │ │ env w9 tracked → web--w9…    │ │                             │
│ skills  plan 1 · attach 2 ·  │ │ skills  plan 1 · attach 1 ·  │ │                             │
│         report 4             │ │         report 3             │ │                             │
│ files   +3 committed · 0 open│ │ files   +5 committed · 0 open│ │                             │
│   work/ascii-figure.tsx      │ │   work/sheet-motion.tsx      │ │                             │
│   work/skills-figures.tsx    │ │   work/sheet-reading-head…   │ │                             │
│ ⚠ routes/work.$slug.tsx      │ │ ⚠ routes/work.$slug.tsx      │ │                             │
└──────────────────────────────┘ └──────────────────────────────┘ └─────────────────────────────┘
  ⚠ overlap  routes/work.$slug.tsx  w8 · w9
  ▸ finished 11
```

- One project is one line, with a vertical card per worktree below it. Card
  order is seats first, then worktrees with no seat, each by most recent
  activity.
- Inside a card: the task's first line, the status and last report, the env and
  the hostname link, the skill verb counts, the file count and list (an
  overlapping file is prefixed with `⚠`), and the elapsed time.
- An overlap is marked inside the card and gathered once more below the project.
- The first round's problem row, the finished fold, the 5-second polling, and the
  first render without JS are kept as they are.
- On a narrow screen the cards stack vertically. The file list shows up to 12 and
  the rest as a count.

## What it does not do

- The file list of a worktree that is not a seat. The reason is above.
- Opening a tool's session log. `session` is still link text.
- Task instructions, mailboxes, "what to do next". Canopy only looks.
- Any judgment about an overlap, or an automatic rebase.

## Measurement plan

| Seam | Check |
| --- | --- |
| `cli` events | In a temporary seat, set `DRYAD_ID` and run `overlay create --apply` and a failing `attach` → 2 `cli` lines in the journal, exit 0 and 1. `status` is not recorded. The command still succeeds when run from a finished seat |
| `changes` | In a real temporary repository, 2 commits and 1 uncommitted → committed 2, uncommitted 1, ahead 2. `truncated` past 200 |
| `worktrees` | Next to the baseline, one worktree with no seat via `git worktree add` → `seat: null` 1, baseline 1 |
| `overlaps` | Two seats change the same file → overlaps 1, exit code unchanged |
| Canopy | `--once` carries the fields above as they are. Take `/` over the socket and count the `⚠` and the cards |

Revert every guard once to see red. With the real tools, run around once more on
a dogfooding seat.

## What landed

- **2026-09-07, the data seat (d1).** Seams 1 to 4 and the `hostnames` fix went
  into `infra/lib/dryad.mjs` and `infra/bin/cli.mjs`. When a process with
  `DRYAD_ID` runs a state-changing verb (`overlay …--apply`, `setup`, `infra
  up|provision`), the CLI entry point appends one `cli` journal line together
  with the exit code (read verbs are not recorded, and everything after `--` is
  a SHA-256 digest only). `status --json` carries, per seat, `changes`
  (`truncated` past 200, with the counts intact), a top-level `worktrees` that
  includes worktrees with no seat, and `overlaps`, which does not change the
  exit code. `hostnames` became `[{host, service, attached}]` so an unattached
  service is distinguished. The fields are owned by `skills/dryad/README.md`.
  Measured: `node --test infra/bin/dryad.test.mjs` 18/18, `npm test` 214/214
  (210 before), each of the 5 new guards reverted for red 5/5. The screen (the
  cards) does not exist yet.

## Splitting the seats

- One catalog seat (data): seams 1 to 4 in `dryad.mjs` / `cli.mjs`, the tests,
  and the README field table.
- One catalog seat (screen): take the JSON shape above as the brief and build
  the card screen against a fixture. In parallel, the same way as the previous
  round.
- When the two seats are done, open two seats on the site again and look through
  Canopy to see whether the overlap is actually visible. That capture is this
  round's evidence.

## Later candidates (2026-09-07)

- **A machine-level conflict check on declared ports.** Two projects each took
  the same host port for their own listener, and one silently shadowed the
  other. Dryad's project index knows this machine's projects, so it can gather
  each profile's `addressing.ports.blocks` and count the overlaps. The overlap
  itself is a fact; a person makes the judgment.
