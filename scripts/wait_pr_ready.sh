#!/usr/bin/env bash
set -euo pipefail

# Wait for a PR to become merge-ready by enforcing the Codex + optional coder-agents-review + non-visual-review CI loop.
# Usage: ./scripts/wait_pr_ready.sh <pr_number>
#
# This script orchestrates Codex + optional coder-agents-review + checks in one polling loop:
#   1) wait_pr_codex.sh --once
#   2) wait_pr_coder_agents_review.sh --once (skips unless explicitly requested/active)
#   3) wait_pr_checks.sh --once
#   4) wait_pr_coder_agents_review.sh --once after checks pass
#   5) check_coder_agents_review_comments.sh (only when the optional gate is active)
#   6) check_codex_comments.sh (only when all active gates pass)
#
# It exits immediately on the first terminal failure and succeeds only when
# all required and active optional gates report success. Pixel review
# statuses are intentionally ignored by wait_pr_checks.sh.

if [ $# -ne 1 ]; then
  echo "Usage: $0 <pr_number>" >&2
  exit 1
fi

PR_NUMBER="$1"
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

# Polling every 30s reduces GitHub API churn while still giving timely readiness updates.
POLL_INTERVAL_SECS=30
RC_PASSED=0
RC_FAILED=1
RC_PENDING=10
RC_SKIPPED=20

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WAIT_CODEX_SCRIPT="$SCRIPT_DIR/wait_pr_codex.sh"
WAIT_CODER_AGENTS_REVIEW_SCRIPT="$SCRIPT_DIR/wait_pr_coder_agents_review.sh"
WAIT_CHECKS_SCRIPT="$SCRIPT_DIR/wait_pr_checks.sh"
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"
CHECK_CODER_AGENTS_COMMENTS_SCRIPT="$SCRIPT_DIR/check_coder_agents_review_comments.sh"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"

for required in "$WAIT_CODEX_SCRIPT" "$WAIT_CODER_AGENTS_REVIEW_SCRIPT" "$WAIT_CHECKS_SCRIPT" "$CHECK_CODEX_COMMENTS_SCRIPT" "$CHECK_CODER_AGENTS_COMMENTS_SCRIPT"; do
  if [ ! -x "$required" ]; then
    echo "❌ Required executable script is missing or not executable: $required" >&2
    exit 1
  fi
done

for required_cmd in gh jq git; do
  if ! command -v "$required_cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $required_cmd" >&2
    exit 1
  fi
done

status_from_rc() {
  local rc="$1"

  case "$rc" in
    "$RC_PASSED")
      echo "passed"
      ;;
    "$RC_PENDING")
      echo "pending"
      ;;
    "$RC_FAILED")
      echo "failed"
      ;;
    *)
      echo "❌ assertion failed: unexpected phase status code '$rc'" >&2
      return 1
      ;;
  esac
}

status_from_optional_rc() {
  local rc="$1"

  case "$rc" in
    "$RC_SKIPPED")
      echo "skipped"
      ;;
    *)
      status_from_rc "$rc"
      ;;
  esac
}

optional_gate_allows_ready() {
  local rc="$1"

  [ "$rc" -eq "$RC_PASSED" ] || [ "$rc" -eq "$RC_SKIPPED" ]
}

load_repo_context() {
  local repo_info

  if ! repo_info=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}' 2>/dev/null); then
    echo "❌ Failed to resolve repository owner/name via 'gh repo view'." >&2
    return 1
  fi

  MUX_GH_OWNER=$(echo "$repo_info" | jq -r '.owner // empty')
  MUX_GH_REPO=$(echo "$repo_info" | jq -r '.name // empty')

  if [[ -z "$MUX_GH_OWNER" || -z "$MUX_GH_REPO" ]]; then
    echo "❌ assertion failed: unable to parse repository owner/name from gh output" >&2
    echo "$repo_info" >&2
    return 1
  fi
}

assert_clean_and_synced_branch() {
  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory." >&2
    echo "" >&2
    git status --short >&2
    echo "" >&2
    echo "Please commit or stash your changes before checking PR status." >&2
    return 1
  fi

  assert_branch_synced || return 1
}

load_repo_context
assert_clean_and_synced_branch

# Child scripts reuse this context to avoid repeated gh repo lookups and duplicate git fetch calls.
export MUX_GH_OWNER
export MUX_GH_REPO
export MUX_SKIP_FETCH_SYNC=1

PR_DATA_FILE=$(mktemp)
REACTIONS_SCAN_CACHE_FILE="${PR_DATA_FILE}.reactions-scan"
cleanup() {
  rm -f "$PR_DATA_FILE" "$REACTIONS_SCAN_CACHE_FILE"
}
trap cleanup EXIT

# Share the latest PR GraphQL payload across child scripts to avoid duplicate API calls.
export MUX_PR_DATA_FILE="$PR_DATA_FILE"
export MUX_REACTIONS_SCAN_CACHE_FILE="$REACTIONS_SCAN_CACHE_FILE"

echo "🚦 Waiting for PR #$PR_NUMBER to become ready (Codex + optional coder-agents-review + non-visual-review CI, fail-fast)..."
echo ""

while true; do
  if CODEX_OUT=$("$WAIT_CODEX_SCRIPT" "$PR_NUMBER" --once 2>&1); then
    CODEX_RC=0
  else
    CODEX_RC=$?
  fi

  CODEX_STATUS=$(status_from_rc "$CODEX_RC") || exit 1

  # True fail-fast behavior: if Codex is already terminal-failed, exit immediately
  # without waiting for the optional bot or checks gates.
  if [ "$CODEX_RC" -eq "$RC_FAILED" ]; then
    echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Coder Agents=skipped | Checks=skipped    "
    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Codex gate output ---"
    if [ -n "$CODEX_OUT" ]; then
      echo "$CODEX_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Address Codex feedback (or retry if Codex was rate-limited), push, and request review again:"
    echo ""
    echo "  gh pr comment $PR_NUMBER --body-file - <<'EOF'"
    echo "  @codex review"
    echo ""
    echo "  Please take another look."
    echo "  EOF"
    exit 1
  fi

  if CODER_AGENTS_OUT=$("$WAIT_CODER_AGENTS_REVIEW_SCRIPT" "$PR_NUMBER" --once 2>&1); then
    CODER_AGENTS_RC=0
  else
    CODER_AGENTS_RC=$?
  fi

  CODER_AGENTS_STATUS=$(status_from_optional_rc "$CODER_AGENTS_RC") || exit 1

  if [ "$CODER_AGENTS_RC" -eq "$RC_FAILED" ]; then
    echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Coder Agents=${CODER_AGENTS_STATUS} | Checks=skipped    "
    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- coder-agents-review gate output ---"
    if [ -n "$CODER_AGENTS_OUT" ]; then
      echo "$CODER_AGENTS_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Address coder-agents-review feedback, reply to the finding(s), push, and request another optional review:"
    echo ""
    echo "  gh pr comment $PR_NUMBER --body '/coder-agents-review'"
    exit 1
  fi

  if CHECKS_OUT=$("$WAIT_CHECKS_SCRIPT" "$PR_NUMBER" --once 2>&1); then
    CHECKS_RC=0
  else
    CHECKS_RC=$?
  fi

  CHECKS_STATUS=$(status_from_rc "$CHECKS_RC") || exit 1
  echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Coder Agents=${CODER_AGENTS_STATUS} | Checks=${CHECKS_STATUS}    "

  if [ "$CHECKS_RC" -eq "$RC_FAILED" ]; then
    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Checks gate output ---"
    if [ -n "$CHECKS_OUT" ]; then
      echo "$CHECKS_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Fix issues locally, push, and rerun this script."
    exit 1
  fi

  if [ "$CODEX_RC" -eq "$RC_PASSED" ] && optional_gate_allows_ready "$CODER_AGENTS_RC" && [ "$CHECKS_RC" -eq "$RC_PASSED" ]; then
    # Avoid a false "not ready" result for already-merged PRs: historical unresolved
    # Codex threads should not block a merged terminal state.
    PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null || echo "error")

    case "$PR_STATE" in
      MERGED)
        echo ""
        echo ""
        echo "🎉 PR #$PR_NUMBER is already merged."
        exit 0
        ;;
      OPEN) ;;
      *)
        echo ""
        echo ""
        echo "❌ assertion failed: unable to classify PR state '$PR_STATE' for PR #$PR_NUMBER" >&2
        exit 1
        ;;
    esac

    # Re-check the optional bot gate after checks pass so a newer
    # /coder-agents-review request posted during this loop cannot be missed.
    if optional_gate_allows_ready "$CODER_AGENTS_RC"; then
      if CODER_AGENTS_FINAL_OUT=$("$WAIT_CODER_AGENTS_REVIEW_SCRIPT" "$PR_NUMBER" --once 2>&1); then
        CODER_AGENTS_FINAL_RC=0
      else
        CODER_AGENTS_FINAL_RC=$?
      fi

      case "$CODER_AGENTS_FINAL_RC" in
        "$RC_PASSED")
          CODER_AGENTS_RC="$RC_PASSED"
          ;;
        "$RC_PENDING")
          CODER_AGENTS_STATUS=$(status_from_optional_rc "$CODER_AGENTS_FINAL_RC") || exit 1
          echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Coder Agents=${CODER_AGENTS_STATUS} | Checks=${CHECKS_STATUS}    "
          sleep "$POLL_INTERVAL_SECS"
          continue
          ;;
        "$RC_SKIPPED")
          CODER_AGENTS_RC="$RC_SKIPPED"
          CODER_AGENTS_STATUS=$(status_from_optional_rc "$CODER_AGENTS_FINAL_RC") || exit 1
          ;;
        "$RC_FAILED")
          echo ""
          echo ""
          echo "❌ PR #$PR_NUMBER is not ready."
          echo ""
          echo "--- coder-agents-review gate output ---"
          if [ -n "$CODER_AGENTS_FINAL_OUT" ]; then
            echo "$CODER_AGENTS_FINAL_OUT"
          else
            echo "(no output)"
          fi
          echo ""
          echo "Address coder-agents-review feedback, reply to the finding(s), push, and request another optional review:"
          echo ""
          echo "  gh pr comment $PR_NUMBER --body '/coder-agents-review'"
          exit 1
          ;;
        *)
          echo "❌ assertion failed: unexpected coder-agents-review status code '$CODER_AGENTS_FINAL_RC'" >&2
          exit 1
          ;;
      esac
    fi

    if [ "$CODER_AGENTS_RC" -eq "$RC_PASSED" ]; then
      if ! CODER_AGENTS_COMMENTS_OUT=$("$CHECK_CODER_AGENTS_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
        echo ""
        echo ""
        echo "❌ PR #$PR_NUMBER is not ready."
        echo ""
        echo "--- coder-agents-review comment gate output ---"
        if [ -n "$CODER_AGENTS_COMMENTS_OUT" ]; then
          echo "$CODER_AGENTS_COMMENTS_OUT"
        else
          echo "(no output)"
        fi
        echo ""
        echo "Address coder-agents-review feedback, reply to the finding(s), push, and request another optional review:"
        echo ""
        echo "  gh pr comment $PR_NUMBER --body '/coder-agents-review'"
        exit 1
      fi
      CODER_AGENTS_READY_SUMMARY="coder-agents-review gate passed"
    else
      CODER_AGENTS_READY_SUMMARY="optional coder-agents-review gate skipped"
    fi

    if CODEX_COMMENTS_OUT=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
      echo ""
      echo ""
      echo "🎉 PR #$PR_NUMBER is ready: Codex approved, ${CODER_AGENTS_READY_SUMMARY}, non-visual-review checks passed, and no unresolved Codex comments remain."
      exit 0
    fi

    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Codex comment gate output ---"
    if [ -n "$CODEX_COMMENTS_OUT" ]; then
      echo "$CODEX_COMMENTS_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Resolve outstanding Codex comments (or request another @codex review) and rerun this script."
    exit 1
  fi

  sleep "$POLL_INTERVAL_SECS"
done
