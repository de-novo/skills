# Mycelium round 2 in the playground sandbox — 2026-09-09

The second round carried the seven items named in
[`docs/mycelium-cases.md`](../mycelium-cases.md): declared predicates with
cardinality, a lock around every write, a blocked report through the seam,
three reading verbs, the Understory pointer, and the brief. This record is
one execution of all of them inside a playground sandbox with a real Dryad
seat, plus the unit evidence at the same tree. Case numbers are the ones
the cases note uses.

## What the run demonstrates

| Case | Observed result |
| --- | --- |
| A13 | `propose --p caused_by` refused, naming the four declared predicates including the built-in `reported` |
| A10, C4 | two `depends-on` edges from `reviewer` (to `worker`, to `design-note`) both committed; the second superseded nothing |
| A5 | a third `reviewer depends-on worker` refused at commit as already stated |
| A4 | on the `one` predicate `uses`, the second object refused as a conflict, then committed with `--supersede`; the first became invalid |
| C2 | after `dryad report --status blocked`, `propose --from-seat worker --report blocked` wrote a staging fact carrying the note; the same call without `--report` was refused for lacking a done report |
| D3 | `query --s sample-web --all` returned 2 (one active, one invalid) |
| D5 | `trace` on the superseding fact printed the chain of 2 with `superseded by` and `supersedes` links |
| D6 | `query --since 2100-…` returned 0; `--all --since 2026-09-01` returned all 6 |
| C6 | `query --brief --s reviewer` printed two Markdown list lines with id, triple, domain, confidence, source |
| C7 | `understory reading` appended `· facts a-…, a-…` to the `reviewer` line and nothing to `worker`, which had no active fact |
| status | `predicates depends-on(many), uses(one), passed(many), reported(many)`; `assertions 6 · active 3 · staging 2 · invalid 1` |
| log | 10 lines, one JSON object each |
| F1 | `down`: 0 ports, 0 machine dryad or overlay mentions, 0 directories remaining; machine Dryad and Mycelium files hold 0 sandbox paths |

The counts above are one dated execution, not a guarantee.

## The commands that ran

```bash
SB=<sandbox>; P="$SB/project"; W="$SB/seats/worker"; CLI=infra/bin/cli.mjs
node $CLI playground up --dir "$SB"
cat > "$P/.agents/mycelium.yml" <<'EOF'
version: 1
domains: [sample]
types: [seat, item, decision, check]
predicates: { depends-on: many, uses: one, passed: many }
judges: [human:reader]
EOF
# a two-item Forester plan (worker, reviewer depends_on worker) in $P/.agents/forester-plan.yml
# every line below carries GROVE_STATE_DIR="$SB/state"
node $CLI dryad plan worker --project "$P" --task 'Change the sample web page' --by reader --apply
(cd $W && node $CLI mycelium propose --s worker --p caused_by --o x --s-type item --domain sample --source f)        # A13 refused
(cd $W && node $CLI mycelium propose --s reviewer --p depends-on --o worker --s-type item --o-type item --domain sample --source .agents/forester-plan.yml)
(cd $W && node $CLI mycelium propose --s reviewer --p depends-on --o design-note --s-type item --o-type decision --domain sample --source docs/design.md)
node $CLI mycelium commit --project "$P" <e1> --by human:reader; node $CLI mycelium commit --project "$P" <e2> --by human:reader
(cd $W && node $CLI mycelium propose --s reviewer --p depends-on --o worker ...); node $CLI mycelium commit --project "$P" <dup> --by human:reader   # A5 refused
(cd $W && node $CLI mycelium propose --s sample-web --p uses --o 'plain html' ...); (cd $W && ... --o 'html plus script' ...)
node $CLI mycelium commit --project "$P" <u1> --by human:reader
node $CLI mycelium commit --project "$P" <u2> --by human:reader              # conflict, refused
node $CLI mycelium commit --project "$P" <u2> --by human:reader --supersede
node $CLI dryad report worker --project "$P" --status blocked --note 'waits for the design note'
node $CLI mycelium propose --project "$P" --from-seat worker --report blocked --s-type seat --domain sample --by human:reader
node $CLI mycelium propose --project "$P" --from-seat worker --s-type seat --domain sample --by human:reader          # no done report, refused
node $CLI mycelium query --project "$P" --s sample-web --all
node $CLI mycelium trace --project "$P" <u2>
node $CLI mycelium query --project "$P" --since 2100-01-01T00:00:00Z
node $CLI mycelium query --project "$P" --all --since 2026-09-01T00:00:00Z
node $CLI mycelium query --project "$P" --brief --s reviewer
node $CLI understory reading --project "$P"
node $CLI mycelium status --project "$P"
node $CLI playground down
grep -l "$SB" ~/.dev-infra/dryads/*.yml ~/.dev-infra/mycelium/*.jsonl | wc -l                                       # 0
```

## Unit evidence at the same tree

`node --test infra/bin/mycelium.test.mjs infra/bin/understory.test.mjs`:
14 and 4 tests. Guards reverted one at a time, each restored before the
next, with the tests that went red:

| Guard reverted | Red |
| --- | --- |
| unknown predicate refused at propose | 1 |
| `many` predicate treated as `one` | 1 |
| predicate removed after the proposal, at commit | 1 |
| the lock around every write | 1 |
| report status matched by prefix (`done-ish` counted as done) | 0, then 1 after the test's fixture string was found to carry a non-ASCII letter and was corrected |
| `--since` on `changed_at` instead of `tx_at` | 1 |
| trace in chain order instead of clock order | 1 |
| Understory listing staging facts as proven | 1 |

E1 and E2 are measured in the test file itself: four committers racing on
a `one` predicate leave one active and no lock file behind; twelve
proposers racing leave twelve whole lines. Full suite `npm test`: 264/264.

## Found on the way

- A `done-ish` fixture line meant to prove the status match is exact
  carried a Cyrillic `е`, so the guard could not fail. Corrected; the
  guard then went red on revert.
- `trace` first ordered by `tx_at`; two lines written in the same
  millisecond came out in the wrong order. Now ordered by chain depth,
  then time.
- `--since` first read `tx_at`, which never changes; an amended fact was
  not news. The fold now records `changed_at` on every line that touches
  a row.

## Made permanent

The arc above was typed by hand three times across two days, and the hand
script was wrong twice (a shell that did not split a command variable; a
flag passed to the wrong verb). It is now `infra/bin/mycelium-arc.test.mjs`
in the suite: a sandbox, a real seat, the same writes and reads, `down`,
and the machine-state check. Reverting the judges gate or the Understory
pointer turns it red (1 each).

## Not measured

A second machine; a log larger than memory; automatic propose on
`dryad report`. Unchanged from the design note.
