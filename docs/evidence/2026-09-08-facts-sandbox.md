# Facts in the playground sandbox — 2026-09-08

Facts is the catalog's fifth skill: an append-only log of assertions per
project. This record is three executions of its arc inside playground
sandboxes, on one machine, with the machine registries checked before and
after. Landed with the skill; the working tree at the time was uncommitted
on `main` above `73d5981`.

## What the runs demonstrate

| Capability | Observed result |
| --- | --- |
| Values file | `status` printed the sandbox project's domains, types, and judge, with 0 assertions |
| A real seat | `seat plan worker --apply` created the seat worktree and branch inside the sandbox |
| Plan seam, before done | `propose --from-seat worker` was refused: "has no done report" |
| Plan seam, after done | after `seat report worker --status done`, the same call wrote a staging fact whose `source` and `valid_from` are that report's journal time |
| Seat identity in a sandbox | the playground guard strips `SEAT_*`; a seat running from its own worktree was still written as `seat:worker` (third run); from the project root with nothing set it was refused |
| Judges gate | `commit` by `seat:worker` was refused naming the judge list; the same id could still `amend` |
| Amend | the seat's amendment (confidence 0.6 → 0.8) was committed by `human:reader`; the original became invalid with reason "amended by" |
| `--ids` | a shell loop over `query --status staging --ids` committed each id |
| Log | 2, 3, and 2 lines respectively, one JSON object each, `v: 1` |
| Machine isolation | machine Seat and Facts files held 0 mentions of any sandbox path throughout |
| Teardown | `down` reported 0 ports listening, 0 machine mentions, 0 directories remaining, each run |

The counts above are dated executions, not a guarantee.

## The commands that ran

```bash
SB=<sandbox>; P="$SB/project"; CLI=infra/bin/cli.mjs
node $CLI playground up --dir "$SB"
printf 'version: 1\ndomains: [sample]\ntypes: [seat, decision, check]\njudges: [human:reader]\n' > "$P/.agents/facts.yml"
# every line below carries GROUND_STATE_DIR="$SB/state"
node $CLI facts status --project "$P"
node $CLI seat plan worker --project "$P" --task 'Change the sample web page' --by reader --apply
node $CLI facts propose --project "$P" --from-seat worker --s-type seat --domain sample --by human:reader   # refused
node $CLI seat report worker --project "$P" --status done --note 'page changed, 1 file'
node $CLI facts propose --project "$P" --from-seat worker --s-type seat --domain sample --by human:reader   # staging
(cd "$SB/seats/worker" && node $CLI facts propose --s sample-web --p uses --o 'one HTML page, no framework' \
   --s-type decision --domain sample --source web/index.html --confidence 0.6)                                # seat:worker
(cd "$SB/seats/worker" && node $CLI facts commit <id>)                                                     # refused: not a judge
(cd "$SB/seats/worker" && node $CLI facts amend <id> --confidence 0.8)
for id in $(node $CLI facts query --project "$P" --status staging --ids); do
  node $CLI facts commit --project "$P" $id --by human:reader
done
node $CLI facts query --project "$P"; node $CLI facts query --project "$P" --status invalid
node $CLI playground down
grep -l "$SB" ~/.dev-infra/seats/*.yml ~/.dev-infra/facts/*.jsonl | wc -l                                # 0
```

## Unit evidence at the same commit

`node --test infra/bin/facts.test.mjs`: 11 tests. Guards reverted one at a
time, each restored before the next: values unknown-key, domain whitelist,
commit conflict refusal, judges gate, staging never answers `--at`, amend
closes the original, worktree fallback, worktree prefix without a path
separator. Each revert turned 1 or 2 tests red; the last one turned 0 red
until its test was given a real sibling directory, and 1 after. Full suite
`npm test`: 260/260.

## Found on the way

- A stray smoke assertion was written to the machine log for the catalog's
  own slug while chasing the sandbox refusal; it was invalidated with that
  reason. Append-only means the line stays.
- The first sandbox run refused a seat's `SEAT_ID`. Cause: the playground
  guard removes every `SEAT_*` variable from a verb aimed at a sandbox.
  Fix: the writer is also found from the seat whose worktree holds the
  current directory, a registry fact. Guarded by the worktree tests above.

## Not measured

Two writers appending in the same instant; a second machine; automatic
propose on `seat report --status done`. Named as later work in
[`docs/facts-design.md`](../facts-design.md).
