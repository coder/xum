---
name: gauntlet
description: Read and fix DRY gate findings (make dry-check, Quality / DRY). Use when a dry-check report names a new near-duplicate, or before you copy a function and edit the copy.
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
