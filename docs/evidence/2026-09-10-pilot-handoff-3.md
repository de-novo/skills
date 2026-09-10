# The third handoff pilot: the prompts designed away, re-measured; Codex hooks made to run — 2026-09-10

A short cold run after [pilot 2](2026-09-10-pilot-handoff-2.md) had been
merged (PR #23) and the Codex trust records had landed (PR #24), to
measure two things: how many prompts a seat now costs a person with the
literal handoff and stdin evidence, and whether a Codex seat under serve
now writes hook events. Catalog at `main` `06eb807` plus the fix this run
found. Two independent items on the playground sample: `api-count`
(Claude Code, `app/api/**`) and `docs-paths` (Codex, `docs/**`); hooks
applied before and removed after; the driver answered only what asked.

## Counts

| | Claude seat | Codex seat |
| --- | --- | --- |
| Trust dialogs answered by a person | 1 (the folder) | 1 (the directory) |
| Permission or escalation prompts | **0** (pilot 2: 2 and 7) | 3 (`dryad seat`, `report working` ×2; Codex's sandbox refuses the playground guard's `ps`, so each is an escalation) |
| Working reports before done | 3 | 3 |
| Evidence | 1 check, 1 not measured, handed in on stdin, no file written | 12 checks, 2 not measured, on stdin |
| Paths outside scope | 0 | 0 |
| Hook events in the seat's file | 24 (UserPromptSubmit, PreToolUse ×11, PostToolUse ×11, SessionEnd) | **0** |
| Wall clock to done | about 1 min 50 s | about 3 min |

The Claude seat used the seat id and paths as the handoff wrote them and
piped its evidence into `report --status done --evidence -`; no
`$VARIABLE` and no Write outside the worktree, so nothing asked.

## Why Codex still wrote nothing, and the fix

The TUI does run trusted hooks: a temporary unconditional handler with
its trust record wrote a line from a TUI session. What it did not run
were Forester's entries, and a TUI launched right after `hooks --apply`
showed why: "Hooks need review: 3 hooks are new or changed". Three of the
five, not five, so the recorded hashes were right for `UserPromptSubmit`
and `Stop` (the two `codex exec` had exercised) and wrong for
`PreToolUse`, `PostToolUse`, and `PermissionRequest`: for the tool events
Codex hashes the group's matcher into the identity, and Forester's groups
carried `matcher: ""` while the recipe, taken from groups Codex itself had
trusted, had none. Codex entries are now written without a matcher key,
which is what the trusted groups on this machine look like. After that
change, on this machine's Codex 0.154.0:

| Session | Review screen | Events |
| --- | --- | --- |
| TUI right after `hooks --apply`, before the change | shown, "3 hooks are new or changed" | 0 |
| TUI after the change, prompt runs `ls` then answers | none | 4 (UserPromptSubmit, PreToolUse, PostToolUse, Stop) |

`hooks --remove --apply` afterwards: the store back to Orca's own
entries, the config's trust tables gone.

Also seen: after the pilot's Codex session the store no longer held
Forester's entries at all. The review screen offers "Continue without
trusting"; the driver's Enter, sent for the directory prompt, may have
landed there. Not determined.

## Not measured

A Codex seat under serve after this change (the TUI was driven in a
pseudo-terminal from a shell, not through serve); the `ps` refusal in
Codex's sandbox, which is the playground guard's and not the catalog's.
