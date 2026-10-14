#!/usr/bin/env bash
# Usage: scripts/lint.sh [--full] [--fix]
#
# Default: ESLint on the files changed since the merge base with origin/main (see
# scripts/lib/lint_targets.js for why and when it falls back to all files).
# --full: ESLint on every file, as CI does.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Check for PNG files in docs - suggest WebP instead
echo "Checking for PNG files in docs..."
PNG_FILES=$(git ls-files 'docs/*.png' 'docs/**/*.png' 2>/dev/null || true)
if [ -n "$PNG_FILES" ]; then
  echo "❌ Error: PNG files found in docs directory. Please use WebP format instead:"
  echo "$PNG_FILES"
  echo ""
  echo "Convert with:"
  for png in $PNG_FILES; do
    webp="${png%.png}.webp"
    echo "  cwebp '$png' -o '$webp' -q 85"
  done
  exit 1
fi

# Workflow runtime and packaged skill workflow sources are executable JS embedded
# into the app; lint them alongside the TS sources (they get dedicated
# non-type-aware config blocks).
ESLINT_PATTERNS=(
  'src/**/*.{ts,tsx}'
  'tests/**/*.{ts,tsx}'
  'src/node/builtinSkills/**/*.js'
  'src/node/workflowRuntime/*.js'
  'scripts/lib/*.js'
)

get_default_eslint_concurrency() {
  # Most local `make static-check` runs are warm-cache validation after a small
  # edit. ESLint's worker startup/merge overhead dominates that path, so keep it
  # single-process once the cache exists; cold caches still scale up for CI-like
  # first runs.
  if [ -f .eslintcache ]; then
    echo 1
    return
  fi

  # Cold type-aware runs scale memory with concurrency, so use cgroup headroom instead of visible
  # core count. Keep stderr attached for diagnostics, and fall back only if the helper fails.
  local concurrency
  if concurrency="$(node "$SCRIPT_DIR/lib/worker_budget.js" eslint)" \
    && [[ "$concurrency" =~ ^[0-9]+$ ]] && [ "$concurrency" -gt 0 ]; then
    echo "$concurrency"
  else
    echo 1
  fi
}

MODE=changed
FIX_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --full) MODE=full ;;
    --fix) FIX_ARGS=(--fix) ;;
    *)
      echo "Unknown argument: $arg (expected --full and/or --fix)" >&2
      exit 2
      ;;
  esac
done

ESLINT_ARGS=(
  --cache
  --cache-strategy content
  --max-warnings 0
)

run_full_lint() {
  local concurrency="${MUX_ESLINT_CONCURRENCY:-$(get_default_eslint_concurrency)}"
  echo "Running eslint on all files ($1, concurrency=$concurrency)..."
  local eslint=(bun x eslint --concurrency "$concurrency" "${ESLINT_ARGS[@]}" "${ESLINT_PATTERNS[@]}" "${FIX_ARGS[@]}")
  # One full run at a time per machine: each peaks at ~7.6 GiB, and parallel agents running
  # several at once OOM-killed shared workspaces. XUM_LINT_LOCK=0 skips the wait.
  if [ "${XUM_LINT_LOCK:-1}" = 0 ]; then
    "${eslint[@]}"
  else
    node "$SCRIPT_DIR/lib/run_exclusive.js" full-lint -- "${eslint[@]}"
  fi
}

if [ "$MODE" = full ]; then
  run_full_lint "--full"
else
  # A separate assignment so set -e stops on a selection error (e.g. a bad XUM_LINT_BASE).
  selection="$(node "$SCRIPT_DIR/lib/lint_targets.js")"
  header="${selection%%$'\n'*}"
  kind="${header%% *}"
  detail="${header#* }"
  if [ "$kind" = full ]; then
    run_full_lint "$detail"
  else
    CHANGED_FILES=()
    if [[ "$selection" == *$'\n'* ]]; then
      while IFS= read -r file; do
        [ -n "$file" ] && CHANGED_FILES+=("$file")
      done <<<"${selection#*$'\n'}"
    fi
    if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
      echo "No lintable files changed since ${detail:0:12}; skipping eslint (make lint-full lints all files)."
      exit 0
    fi
    echo "Running eslint on ${#CHANGED_FILES[@]} file(s) changed since ${detail:0:12} (make lint-full lints all files)..."
    # One worker: worker start-up costs more than it saves on a small file set, and each worker
    # loads its own copy of the TypeScript program. --no-warn-ignored: a changed file that the
    # config ignores (e.g. src/browser/main.tsx) must not fail --max-warnings 0.
    bun x eslint --concurrency "${MUX_ESLINT_CONCURRENCY:-1}" "${ESLINT_ARGS[@]}" --no-warn-ignored \
      "${CHANGED_FILES[@]}" "${FIX_ARGS[@]}"
  fi
fi

if [ "${#FIX_ARGS[@]}" -eq 0 ]; then
  echo "ESLint checks passed!"
fi
