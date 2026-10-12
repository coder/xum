---
name: crap-gate
description: Read and fix CRAP gate findings (crap-check, the commit hook report, Quality / CRAP). Use when a crap-gate or crap-check report names a function, before splitting or testing a complex function, or when deciding on a Crap-Debt trailer.
---

# CRAP gate

CRAP = CC² × (1 − coverage)³ + CC per function, where CC is cyclomatic
complexity. Complex code without tests scores high. The gate stops new debt and
makes touched hotspots shrink. The scorer is Crapper (`make crap`), and the
rules live in `scripts/crap/policy.ts` with thresholds in
`scripts/crap/thresholds.ts`.

## Where reports come from

- `make crap-check` (or `bun scripts/crap/check.ts --base <ref>`): the files
  changed since the merge-base with `origin/main`, in the working tree.
  Exit 0 pass, 1 violations, 2 tool error.
- The agent hook: after a `git commit` or `git push` bash call, Xum appends the
  report to the tool result (warn mode). In block mode the hook stops the
  command before it runs. `scripts/crap/agent-gate.sh` holds the mode.
- CI: the `Quality / CRAP` job summary and its annotations. It is informational.

Without coverage, scores are CC. With `--coverage <lcov>`, scores are CRAP.

## Reading a finding

```
VIOLATION floor-cc     src/x.ts:10-25 normalizeAgentId: CC 3 -> 4 (must not grow)
```

| Rule           | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `floor-cc`     | An existing function gained CC.                                                  |
| `floor-crap`   | With coverage on both sides, an existing function gained CRAP.                   |
| `new-function` | A new function (or a renamed one, or one moved to another file) is above 8.      |
| `crap-tax`     | You touched a function whose base score is above 30, and its score did not drop. |

- A `crap-tax` finding without coverage on both sides is a warning: a comment
  or one-line fix in a hotspot passes, with a nudge to shrink it.
- When the changed files' total CC drops, `new-function` findings are warnings
  (net-extraction relief): splitting a hotspot is allowed even if one piece is
  still above 8.
- The function name and line range are in the report. Identity is
  `path::namespace::name`, so renaming a function makes it new.

## The two repairs

1. Shrink the function. Extract pure logic into a named function with its own
   tests. In React, move state and effects into a named hook, or a part of the
   tree into a child component, each with its own tests.
2. Test it. Coverage lowers CRAP, so this repairs only reports with coverage
   (`--coverage <lcov>`, the CI job's new-function findings). The hook and a
   plain `make crap-check` score CC alone: tests cannot clear their `floor-cc`
   or `new-function` findings, so shrink the function instead. A test must
   assert behavior that would fail if the code broke.

## Anti-gaming rules

Never do these to lower a score:

- Replace `?.` or `??` with `!`, `as` casts, or other unchecked assumptions.
  Crapper counts `?.` and `??` as decisions, but removing a real check hides a
  bug instead of removing complexity.
- Add tests without meaningful assertions (coverage probes, snapshot-only or
  `expect(true)` tests).
- Split code into one-caller helpers that only pass state through. The CC moves,
  the complexity stays, and the reader pays twice.
- Move or rename a function only to reset its history.

## Crap-Debt

When a violation cannot be fixed in this change (a hotfix, a generated file),
add a `Crap-Debt: <reason>` trailer to the commit, or the `crap-debt` label to
the PR in CI. Every violation becomes a warning, and the report lists each use.
Name the follow-up in the reason.
