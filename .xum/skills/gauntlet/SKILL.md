---
name: gauntlet
description: Read and fix DRY and mutation gate findings (make dry-check, make mutate-check, Quality / DRY, Quality / Mutation). Use when a report names a new near-duplicate or a surviving mutant, or before you copy a function and edit the copy.
---

# Gauntlet gates

These gates sit next to the CRAP gate (`crap-gate` skill). They only warn:
the reader of the finding decides. They score only the functions that your
change touched, since the merge-base with `origin/main`.

## DRY gate

`make dry-check` (or `bun scripts/dry/check.ts --base <ref>`) compares each
changed function with every production function in `src/`. The scorer is
[dryer](https://github.com/unclebob/dryer): it drops names, literals and
locals, then scores the Jaccard similarity of the structure. Exit 0 no
findings, 1 findings, 2 tool error. CI shows the same report in the
`Quality / DRY` job summary.

```
warning  new-duplicate score 1.00 src/x.ts:41-46 feeBucket
         matches src/x.ts:34-39 centsBucket
```

- A finding needs a score of 0.82 or more (the dryer default), at least 4
  lines and 20 syntax nodes.
- Only pairs that the change made are findings: a new function that copies
  another one, or an edit that makes two functions match. An edit to one side
  of a pair that already matched on main is quiet.
- Files under test, story and fixture paths do not count (the CRAP gate's
  production-file rule).

### Repair

1. If both functions must change together (one rule, one format, one
   protocol), extract the shared shape into one function and call it from both
   places.
2. If they only look alike and must change apart (two different domains that
   happen to share a shape today), keep both. Say why in the PR.

Never merge two functions only to clear a DRY finding. A wrong abstraction
costs more than a copy.

## Mutation gate

`make mutate-check` (or `bun scripts/mutate/check.ts --base <ref>`) makes
small changes ("mutants") in the functions you changed, one at a time: `===`
to `!==`, `>` to `>=`, `&&` to `||`, `??` to `||`, `true` to `false`, `0` to
`1`, and more ([mutator](https://github.com/unclebob/mutator)'s rules). For
each mutant it runs the Bun unit tests that import the file. A mutant that no
test fails on "survived": no test checks that behaviour.

```
mutate-check: 2 survived, 7 killed, 0 uncovered, 0 without a test, 0 not run
  src/x.ts  (tests: src/x.test.ts, src/y.test.ts)
    survived :61 === -> !==  parseCap
```

- Tests: the colocated test first, then the nearest other unit tests that
  import the file directly, at most 10. Each test file runs in its own
  `bun test` process, in a private copy of the tracked files. The first
  failing file kills the mutant. A timeout (10x the file's own time, at
  least 2 s) also kills it.
- Exit 0 no survivors, 1 survivors, 2 tool error, 3 baseline failure: a test
  file failed without a mutant, so the run dropped it. Fix that test first.
- `uncovered`: with `--coverage <lcov>` (CI uses the Test / Unit reports), a
  site on a line that no test ran does not run. `no-test`: no passing unit
  test imports the file. `not-run`: the run stopped at its limit (CI: 300
  mutants or 15 minutes). `error`: the runner crashed on that one mutant; the
  report gives the reason, and the other mutants still count.
- Locally it runs on 4 workers at most (`--workers N`). Start with a small
  change: every site in a touched function runs.

### Repair

1. Write a test that fails for the mutant. Assert the behaviour that the
   mutant breaks (the boundary, the other branch), not the line.
2. If no input can tell the mutant from the original, it is equivalent. For
   example, `m[2] ?? ""` and `m[2] || ""` are the same when `m[2]` is never
   `""`. Say so in the PR and move on.

Never change production code only to kill a mutant, and never add a test
without a real assertion. The CRAP gate's anti-gaming rules apply here too.
