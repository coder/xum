#!/usr/bin/env bash
# Fail when a test file is run by no CI lane, or by two.
#
# Why: runners discover tests by path (bunfig's `root = "src"`, Jest's testMatch,
# scripts/test-unit-ci.sh's find roots), so a test in an unexpected place or with an
# unexpected extension silently runs nowhere. A repo audit found ~100 such tests,
# including the VS Code webview's oRPC allowlist security guard.
#
# Test files are every *.test.* and *.spec.* file with a JS/TS extension: Bun, Jest and
# Playwright all recognize both suffixes.
#
# Lanes, in the order checked:
#   1. Bun unit lane: scripts/test-unit-ci.sh --list-all (CI "Test / Unit").
#   2. Jest lane: `jest --listTests` under tests/ (CI "Test / Integration" runs
#      `jest tests/`).
#   3. Playwright lane: files under tests/e2e/ (playwright.config.ts testDir; CI
#      "Test / E2E").
#   4. The explicit list below: files run some other way, or deliberately not in CI.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# path<TAB>where it runs / why it is excluded
other_routes=(
  $'scripts/check-startup-imports.test.ts\tmake check-startup-imports (static-check), right before its analyzer'
  $'tests/ui/domIsolation.radixOrder.child.test.tsx\tspawned in a fresh process by tests/ui/domIsolation.test.ts'
  $'vscode/src/api/orpcConnection.integration.test.ts\tnot in CI: needs a live xum server; run with TEST_INTEGRATION=1 bun test ./vscode/src/api/'
)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --others: also check new, not-yet-added files locally (CI has only tracked ones).
# Skip paths deleted in the worktree but not yet staged; no runner can see them.
git ls-files --cached --others --exclude-standard -- \
  '*.test.'{ts,tsx,js,jsx,mjs,cjs} '*.spec.'{ts,tsx,js,jsx,mjs,cjs} \
  | while IFS= read -r file; do [[ ! -e "$file" ]] || printf '%s\n' "$file"; done \
  | LC_ALL=C sort -u >"$tmp/all"
./scripts/test-unit-ci.sh --list-all | sed 's#^\./##' | LC_ALL=C sort >"$tmp/unit"
if ! bun x jest --listTests >"$tmp/jest.raw" 2>"$tmp/jest.err"; then
  cat "$tmp/jest.err" >&2
  exit 1
fi
# Strip the checkout prefix literally: $PWD may contain sed/regex metacharacters.
while IFS= read -r file; do
  file=${file#"$PWD/"}
  [[ "$file" != tests/* ]] || printf '%s\n' "$file"
done <"$tmp/jest.raw" | LC_ALL=C sort >"$tmp/jest"
{ grep '^tests/e2e/' "$tmp/all" || true; } >"$tmp/e2e"
printf '%s\n' "${other_routes[@]}" | cut -f1 | LC_ALL=C sort >"$tmp/other"

status=0
report() {
  local message=$1 file=$2
  if [[ -s "$file" ]]; then
    echo "check-test-routing: $message" >&2
    sed 's/^/  /' "$file" >&2
    status=1
  fi
}

LC_ALL=C sort -u "$tmp/unit" "$tmp/jest" "$tmp/e2e" "$tmp/other" >"$tmp/routed"
LC_ALL=C comm -23 "$tmp/all" "$tmp/routed" >"$tmp/unrouted"
report "test files run by no CI lane (move them under a runner's root, or add them to other_routes with a reason):" "$tmp/unrouted"

LC_ALL=C sort "$tmp/unit" "$tmp/jest" "$tmp/e2e" "$tmp/other" | uniq -d >"$tmp/duplicated"
report "test files claimed by more than one lane:" "$tmp/duplicated"

LC_ALL=C comm -13 "$tmp/all" "$tmp/other" >"$tmp/stale"
report "other_routes entries that are not tracked test files:" "$tmp/stale"

if ((status == 0)); then
  echo "check-test-routing: $(wc -l <"$tmp/all") test files routed ($(wc -l <"$tmp/unit") bun unit, $(wc -l <"$tmp/jest") jest, $(wc -l <"$tmp/e2e") playwright, $(wc -l <"$tmp/other") other)"
fi
exit "$status"
