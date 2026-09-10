# The handoff pilot: two real seats through serve, the gate, and the merge — 2026-09-10

A cold run of the handoff branch on the playground sample, with real
Claude Code sessions held by `forester serve`, to see whether an agent
reading the new skills does what they say. Catalog at branch
`feat/handoff-integrity` (`340bc3b` plus the fix this run found). The
unit suite proves the CLI; this run proves the seams a session meets.

## Harness

| Piece | Value |
| --- | --- |
| Project | the playground sample (api, web, router) in a sandbox under the session scratchpad, its own git repository |
| Plan | two items: `api-count` (add `GET /notes/count`, owns `app/api/**`, a brief file, two verify lines) and `docs-count` (document the api, owns `docs/**`, `depends_on: [api-count]`, a brief file) |
| Vocabulary | `.agents/mycelium.yml` with `judges: [human:driver]` and `mode: restricted`; no seat was asked to propose a fact |
| Budget | `parallel: 2` in the local file; `forester machine --parallel 2 --apply` |
| Skills in the project | copied into `.agents/skills` and `.claude/skills` (the sandbox refuses symlinks) |
| Sessions | Claude Code 2.1.267, launched by `forester serve` from the local file's `claude` template (`--permission-mode acceptEdits` and an allow list); the driver attached with `forester attach` in Orca terminals and answered what needed a person |
| Person | the driver: answered the trust dialog, chose auto mode at each seat's first prompt, merged, finished |

`doctor --project <sandbox>` before anything ran: ok; 7/7 skills carried
as copies; two gates named (shared engines, trust dialogs); next: nothing.

## What happened, in order

1. **serve seated `api-count`** (worktree, overlay env `api-count`,
   scope `app/api/**`, revision `1eab52702495a893`, attempt 1) and logged
   `trust not seeded; a trust dialog shows as needs-input, answer it with
   forester attach api-count`. `status` showed the session `needs-input`
   before any hook had fired (the screen fallback).
2. **The driver attached.** The screen was Claude Code's trust dialog with
   the cursor on "No, exit". Down, Enter: the session went `running` at
   its first prompt, the generated handoff (title, revision, base, scope,
   the two verify lines, the report line, the brief under its path and
   digest).
3. **The seat read the skill first** (`Skill(dryad)` from the copied
   skills), then ran one compound shell command, which the allow list did
   not cover: `needs-input` again, read through attach, answered with
   "Yes, and switch to auto mode". No further prompt reached a person.
4. **The seat worked as the rules say.** Three `working` reports at real
   turns (before the edit, before verification, before the commit); one
   file changed inside its scope; committed `bcf8cef`; built the image
   named by its HEAD; `overlay attach api-count api --apply` (its first
   attempt without `--image` was refused and it corrected itself);
   `urls --env`; `curl` by name through the router: 200 with `count: 3`
   on the overlay name and 404 on the baseline name, which it used to
   prove the answer came from its overlay. It wrote an evidence file with
   8 checks (command, cwd, exit, observed) and 2 `not_measured` entries
   (the 503 branch, read not run, with the reason; everything outside its
   scope), and reported done with its session reference. Dryad recorded
   the result: head `bcf8cef`, clean, 1 path, scope kept, checks 8. serve
   closed the session.
5. **The gate held.** `forester plan`: `api-count done`, `docs-count
   waiting · api-count done at bcf8cefd2144 is not in baseline HEAD
   0f9b11c532b3; merge it, or record dryad integrate api-count --commit
   <sha>`. Nothing was seated.
6. **The driver merged** (`git merge --ff-only seat/api-count`). Within
   one poll `docs-count` was `ready · api-count done and in the baseline`
   with `inputs: { api-count: bcf8cef… }`, and serve seated it on base
   `bcf8cef`. Its handoff read `Depends on: api-count: result bcf8cef… is
   in your base`.
7. **No second trust dialog.** The second worktree went straight to its
   first prompt. Claude Code had keyed the driver's answer on the
   repository (`projects[<sandbox>/project].hasTrustDialogAccepted`), not
   on the worktree path; serve wrote nothing.
8. **The docs seat** reported working three times, wrote `docs/api.md`
   (238 lines, every path with an example, the 503 cases), verified with
   the plan's grep and a path-by-path diff of the doc's headings against
   the server's route checks, committed `8de6cee`, and reported done with
   4 checks and one `not_measured` (no live request; examples derived
   from source). Scope kept.
9. **Merge, finish, down.** The driver merged the docs branch, ran
   `dryad finish --apply` twice (envs destroyed 2/2, worktrees removed
   2/2, branches kept), stopped serve (snapshot, socket, and lock gone),
   and `playground down`: processes 0, ports 0, machine dryad mentions 0,
   machine overlay mentions 0, directories 0.

## Counts

| | |
| --- | --- |
| Items, seats, sessions | 2, 2, 2 Claude Code sessions held by serve |
| Prompts a person answered | 1 trust dialog, 2 permission prompts (one per seat, each answered with auto mode) |
| Working reports before done | 3 and 3 |
| Evidence checks, not measured | 8 and 2; 4 and 1 |
| Paths outside scope | 0 and 0 |
| Dependents seated before their input was in the baseline | 0 |
| Wall clock, seat from launch to done | about 3 min 15 s and 2 min 45 s |
| Machine registry mentions of the sandbox after down | 0 |
| Entries serve wrote to the person's Claude state file | 0 (the one entry under the sandbox path is the driver's own answer, keyed by Claude Code on the repository) |

## Found on the way

- **Defect, fixed in this run.** After both seats were finished,
  `forester machine` still showed `held 1/2` for `docs-count`: its
  reservation had no seat in the registry and the process that took it,
  the serve daemon, was still alive, so the liveness rule read it as in
  flight. An in-flight reservation is now bounded: younger than two
  minutes, and with nothing of its id finished since it was taken. The
  regression finishes a seat while the reserving process lives and
  expects the slot released; reverting the bound turns it red (1).
- **Evidence file location is unsaid.** The handoff says `--evidence
  <file>` and nothing about where. The first seat put it under its own
  session scratch directory; the second under the sandbox's state
  directory, a write outside its worktree, though not to any source.
  Dryad copies the file's content into the record, so the file is
  disposable, but the handoff should name a place (a later change).
- **Trust is keyed by repository, not by worktree**, in Claude Code
  2.1.267: one answer covered both seats. `pretrust_worktrees`, when a
  machine opts in, writes the worktree path; whether Claude Code reads
  that key for a worktree of an already-trusted repository was not
  needed here and is not known.
- **Auto mode carried the rest.** One permission prompt per seat reached
  a person; with the allow list alone every compound command would have.
  The pilot of 2026-09-09 answered about a hundred prompts by hand.

## Not measured

Codex as a seat under serve (both seats were Claude Code); a seat that
reports done outside its scope in a real session (the refusal is
exercised by the suite only); the squash-integration path (`dryad
integrate`) in a real session; facts proposed by seats (the briefs did
not ask for any); the machine cap refusing a third project's seat while
these two ran.
