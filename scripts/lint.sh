#!/usr/bin/env bash
# Usage: scripts/lint.sh [--eslint | --full] [--fix]
#
# Default: oxlint on every file, with the eslint.config.mjs rules it can run (see
# scripts/gen-oxlintrc.mjs). It takes seconds and well under 1 GiB.
# --eslint: also type-aware ESLint on the files changed since the merge base with origin/main (see
# scripts/lib/lint_targets.js for why and when it falls back to all files).
# --full: oxlint, then ESLint on every file, as CI does.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

MODE=oxlint
FIX_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --eslint) [ "$MODE" = full ] || MODE=eslint ;;
    --full) MODE=full ;;
    --fix) FIX_ARGS=(--fix) ;;
    *)
      echo "Unknown argument: $arg (expected --eslint or --full, and/or --fix)" >&2
      exit 2
      ;;
  esac
done

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

OXLINT_CONFIG=.oxlintrc.json

# The config is generated and gitignored, so it cannot drift from eslint.config.mjs.
ensure_oxlint_config() {
  local input
  for input in eslint.config.mjs eslint-local-rules.mjs scripts/gen-oxlintrc.mjs node_modules/.installed; do
    if [ ! -f "$OXLINT_CONFIG" ] || [ "$input" -nt "$OXLINT_CONFIG" ]; then
      echo "Generating $OXLINT_CONFIG from eslint.config.mjs..."
      node scripts/gen-oxlintrc.mjs "$OXLINT_CONFIG"
      return
    fi
  done
}

run_oxlint() {
  ensure_oxlint_config
  # A separate assignment so set -e stops on a listing error.
  local listing
  listing="$(node "$SCRIPT_DIR/lib/lint_targets.js" --all)"
  local files=()
  while IFS= read -r file; do
    [ -n "$file" ] && files+=("$file")
  done <<<"$listing"
  if [ "${#files[@]}" -eq 0 ]; then
    echo "No lintable files; skipping oxlint."
    return
  fi
  echo "Running oxlint on ${#files[@]} files (type-aware rules: make lint-eslint, or CI)..."
  # More threads barely help: the JS plugins (Tailwind, the local rules) dominate the run time.
  bun x oxlint -c "$OXLINT_CONFIG" --threads 4 --deny-warnings "${files[@]}" "${FIX_ARGS[@]}"
}

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
  # Most local runs are warm-cache validation after a small edit. ESLint's
  # worker startup/merge overhead dominates that path, so keep it
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

ESLINT_ARGS=(
  --cache
  --cache-strategy content
  --max-warnings 0
)

run_full_eslint() {
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

run_changed_eslint() {
  # A separate assignment so set -e stops on a selection error (e.g. a bad XUM_LINT_BASE).
  local selection
  selection="$(node "$SCRIPT_DIR/lib/lint_targets.js")"
  local header="${selection%%$'\n'*}"
  local kind="${header%% *}"
  local detail="${header#* }"
  if [ "$kind" = full ]; then
    run_full_eslint "$detail"
    return
  fi
  local changed_files=()
  if [[ "$selection" == *$'\n'* ]]; then
    while IFS= read -r file; do
      [ -n "$file" ] && changed_files+=("$file")
    done <<<"${selection#*$'\n'}"
  fi
  if [ "${#changed_files[@]}" -eq 0 ]; then
    echo "No lintable files changed since ${detail:0:12}; skipping eslint (make lint-full lints all files)."
    return
  fi
  echo "Running eslint on ${#changed_files[@]} file(s) changed since ${detail:0:12} (make lint-full lints all files)..."
  # One worker: worker start-up costs more than it saves on a small file set, and each worker
  # loads its own copy of the TypeScript program. --no-warn-ignored: a changed file that the
  # config ignores (e.g. src/browser/main.tsx) must not fail --max-warnings 0.
  bun x eslint --concurrency "${MUX_ESLINT_CONCURRENCY:-1}" "${ESLINT_ARGS[@]}" --no-warn-ignored \
    "${changed_files[@]}" "${FIX_ARGS[@]}"
}

run_oxlint
case "$MODE" in
  eslint) run_changed_eslint ;;
  full) run_full_eslint "--full" ;;
esac

if [ "${#FIX_ARGS[@]}" -eq 0 ]; then
  echo "Lint checks passed!"
fi
