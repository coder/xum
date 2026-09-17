#!/usr/bin/env bash
set -euo pipefail

USAGE="Usage: $0 <pr_number> [--wait-for-review <seconds>]"

# Exit codes: 0 no unresolved Codex comments; 1 unresolved comments or threads;
# 10 Codex is still reviewing and nothing else blocks (wait_pr_codex.sh keeps
# polling on 10 instead of reporting a failure).

if [ $# -eq 0 ]; then
  echo "$USAGE"
  exit 1
fi

PR_NUMBER=$1
shift
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

# CI runs this gate on every push, at the same moment Codex starts reviewing that
# push. Without a wait budget the gate fails on the in-progress summary and nobody
# re-runs it. The budget only delays the verdict; an unfinished review still fails.
WAIT_FOR_REVIEW_SECS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait-for-review)
      if [ $# -lt 2 ] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "❌ --wait-for-review requires a non-negative integer number of seconds" >&2
        echo "$USAGE" >&2
        exit 1
      fi
      WAIT_FOR_REVIEW_SECS=$2
      shift 2
      ;;
    *)
      echo "❌ Unknown argument: '$1'" >&2
      echo "$USAGE" >&2
      exit 1
      ;;
  esac
done

WAIT_POLL_SECS="${MUX_CODEX_WAIT_POLL_SECS:-30}"
if ! [[ "$WAIT_POLL_SECS" =~ ^[0-9]+$ ]]; then
  echo "❌ assertion failed: MUX_CODEX_WAIT_POLL_SECS must be a non-negative integer (got '$WAIT_POLL_SECS')" >&2
  exit 1
fi

BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
REGULAR_COMMENTS='[]'
UNRESOLVED_THREADS='[]'
REGULAR_COUNT=0
UNRESOLVED_COUNT=0
IN_PROGRESS_COUNT=0

resolve_repo_context() {
  if [[ -n "${MUX_GH_OWNER:-}" || -n "${MUX_GH_REPO:-}" ]]; then
    if [[ -z "${MUX_GH_OWNER:-}" || -z "${MUX_GH_REPO:-}" ]]; then
      echo "❌ assertion failed: MUX_GH_OWNER and MUX_GH_REPO must both be set when one is provided" >&2
      return 1
    fi

    OWNER="$MUX_GH_OWNER"
    REPO="$MUX_GH_REPO"
  else
    local repo_info
    if ! repo_info=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}'); then
      echo "❌ Failed to resolve repository owner/name via 'gh repo view'." >&2
      return 1
    fi

    OWNER=$(echo "$repo_info" | jq -r '.owner // empty')
    REPO=$(echo "$repo_info" | jq -r '.name // empty')
  fi

  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    echo "❌ assertion failed: owner/repo must be non-empty" >&2
    return 1
  fi
}

# Retry GraphQL calls to avoid transient network/API hiccups from failing readiness checks.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

graphql_with_retries() {
  local query="$1"
  local cursor="$2"
  local attempt
  local backoff="$BACKOFF_SECS"
  local response

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if response=$(gh api graphql \
      -f query="$query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor"); then
      printf '%s\n' "$response"
      return 0
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "❌ GraphQL query failed after ${MAX_ATTEMPTS} attempts" >&2
      return 1
    fi

    echo "⚠️ GraphQL query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${backoff}s..." >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
  done
}

compute_codex_sets_from_arrays() {
  local comments_json="$1"
  local threads_json="$2"

  # JSON goes through stdin, never argv: a long review history exceeds Linux's
  # per-argument limit (MAX_ARG_STRLEN, ~128KB) and made --argjson fail with
  # "Argument list too long". printf is a shell builtin, so it has no such limit.
  REGULAR_COMMENTS=$(printf '%s' "$comments_json" | jq -c -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" 'include "codex_comments"; [
    .[]
    | select(.author.login == $bot and .isMinimized == false and (codex_comment_is_informational($bot) | not))
  ]')

  UNRESOLVED_THREADS=$(printf '%s' "$threads_json" | jq -c --arg bot "$BOT_LOGIN_GRAPHQL" '[
    .[]
    | select(.isResolved == false and .comments.nodes[0].author.login == $bot)
  ]')

  REGULAR_COUNT=$(printf '%s' "$REGULAR_COMMENTS" | jq 'length')
  UNRESOLVED_COUNT=$(printf '%s' "$UNRESOLVED_THREADS" | jq 'length')

  # In-progress summaries are a subset of REGULAR_COMMENTS: they block, but the
  # wait loop below may give Codex time to finish before the verdict.
  IN_PROGRESS_COUNT=$(printf '%s' "$REGULAR_COMMENTS" | jq -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" 'include "codex_comments";
    [.[] | select(codex_review_in_progress($bot))] | length')
}

# True while the in-progress summary is the sole blocker. Waiting only helps in
# that state: a review thread or any other Codex comment already fixes the verdict
# at "unresolved", so waiting for the review to finish would only hold the runner.
codex_only_in_progress_blocks() {
  [ "$IN_PROGRESS_COUNT" -gt 0 ] && [ "$((REGULAR_COUNT - IN_PROGRESS_COUNT + UNRESOLVED_COUNT))" -eq 0 ]
}

load_result_from_cache() {
  if [[ -z "$PR_DATA_FILE" || ! -s "$PR_DATA_FILE" ]]; then
    return 1
  fi

  if ! jq -e '.data.repository.pullRequest != null and .data.repository.pullRequest.comments.nodes != null and .data.repository.pullRequest.reviewThreads.nodes != null' "$PR_DATA_FILE" >/dev/null 2>&1; then
    echo "⚠️ MUX_PR_DATA_FILE at '$PR_DATA_FILE' does not contain the expected PR payload; falling back to API query." >&2
    return 1
  fi

  # Cached data from wait_pr_codex uses comments/reviewThreads(last: 100). If either
  # connection has older pages, the cache is incomplete and cannot be trusted for a clean
  # "no unresolved Codex comments" result.
  local comments_has_previous
  local threads_has_previous
  comments_has_previous=$(jq -r '(.data.repository.pullRequest.comments.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)' "$PR_DATA_FILE")
  threads_has_previous=$(jq -r '(.data.repository.pullRequest.reviewThreads.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)' "$PR_DATA_FILE")

  case "$comments_has_previous" in
    false) ;;
    true)
      echo "⚠️ Cached comments window is incomplete (hasPreviousPage=true); fetching full Codex comment set." >&2
      return 1
      ;;
    unknown)
      echo "⚠️ Cached comment pageInfo is missing; fetching full Codex comment set." >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected cached comments hasPreviousPage value '$comments_has_previous'" >&2
      return 1
      ;;
  esac

  case "$threads_has_previous" in
    false) ;;
    true)
      echo "⚠️ Cached reviewThreads window is incomplete (hasPreviousPage=true); fetching full Codex comment set." >&2
      return 1
      ;;
    unknown)
      echo "⚠️ Cached review-thread pageInfo is missing; fetching full Codex comment set." >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected cached reviewThreads hasPreviousPage value '$threads_has_previous'" >&2
      return 1
      ;;
  esac

  local cached_comments
  local cached_threads
  cached_comments=$(jq -c '.data.repository.pullRequest.comments.nodes // []' "$PR_DATA_FILE")
  cached_threads=$(jq -c '.data.repository.pullRequest.reviewThreads.nodes // []' "$PR_DATA_FILE")
  compute_codex_sets_from_arrays "$cached_comments" "$cached_threads"
  return 0
}

fetch_all_comments_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            author { login }
            body
            createdAt
            isMinimized
          }
        }
      }
    }
  }'

  local all_comments='[]'
  local cursor="null"
  local page_data
  local page_comments
  local has_next
  local end_cursor

  while true; do
    if ! page_data=$(graphql_with_retries "$graphql_query" "$cursor"); then
      return 1
    fi

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_comments=$(echo "$page_data" | jq -c '.data.repository.pullRequest.comments.nodes // []')
    # Accumulated pages outgrow MAX_ARG_STRLEN, so concatenate via stdin rather than --argjson.
    all_comments=$(printf '%s\n%s' "$all_comments" "$page_comments" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.comments.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.comments.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: comments hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected comments hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  ALL_COMMENTS_JSON="$all_comments"
}

fetch_all_threads_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes {
                id
                author { login }
                body
                createdAt
                path
                line
              }
            }
          }
        }
      }
    }
  }'

  local all_threads='[]'
  local cursor="null"
  local page_data
  local page_threads
  local has_next
  local end_cursor

  while true; do
    if ! page_data=$(graphql_with_retries "$graphql_query" "$cursor"); then
      return 1
    fi

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_threads=$(echo "$page_data" | jq -c '.data.repository.pullRequest.reviewThreads.nodes // []')
    # Same MAX_ARG_STRLEN concern as the comments accumulator above.
    all_threads=$(printf '%s\n%s' "$all_threads" "$page_threads" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reviewThreads hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reviewThreads hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  ALL_THREADS_JSON="$all_threads"
}

fetch_result_via_api() {
  resolve_repo_context
  fetch_all_comments_via_api
  fetch_all_threads_via_api
  compute_codex_sets_from_arrays "$ALL_COMMENTS_JSON" "$ALL_THREADS_JSON"
}

echo "Checking for unresolved Codex comments in PR #${PR_NUMBER}..."

loaded_from_cache=0
if load_result_from_cache; then
  loaded_from_cache=1
else
  fetch_result_via_api
fi

# The shared cache is fetched earlier in wait_pr_ready's loop and can become stale
# before this final Codex comment gate executes. Re-query before returning either
# success or failure so recently-added/resolved Codex comments are not misclassified.
if [ "$loaded_from_cache" -eq 1 ]; then
  fetch_result_via_api
fi

if [ "$WAIT_FOR_REVIEW_SECS" -gt 0 ] && codex_only_in_progress_blocks; then
  wait_deadline=$(($(date +%s) + WAIT_FOR_REVIEW_SECS))
  while codex_only_in_progress_blocks; do
    now=$(date +%s)
    if [ "$now" -ge "$wait_deadline" ]; then
      echo "⚠️ Codex review is still running after ${WAIT_FOR_REVIEW_SECS}s; reporting it as unresolved."
      break
    fi
    echo "⏳ Codex review is still running; re-checking in ${WAIT_POLL_SECS}s (gives up in $((wait_deadline - now))s)..."
    sleep "$WAIT_POLL_SECS"
    fetch_result_via_api
  done
fi

TOTAL_UNRESOLVED=$((REGULAR_COUNT + UNRESOLVED_COUNT))

echo "Found ${REGULAR_COUNT} unminimized regular comment(s) from bot"
echo "Found ${UNRESOLVED_COUNT} unresolved review thread(s) from bot"

if [ "$TOTAL_UNRESOLVED" -gt 0 ]; then
  echo ""
  echo "❌ Found ${TOTAL_UNRESOLVED} unresolved comment(s) from Codex in PR #${PR_NUMBER}"
  echo ""
  echo "Codex comments:"

  if [ "$REGULAR_COUNT" -gt 0 ]; then
    echo "$REGULAR_COMMENTS" | jq -r '.[] | "  - [\(.createdAt)]\n\(.body)\n"'
  fi

  if [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    echo "$UNRESOLVED_THREADS" | jq -r '.[] | "  - [\(.comments.nodes[0].createdAt)] thread=\(.id) \(.comments.nodes[0].path // "comment"):\(.comments.nodes[0].line // "")\n\(.comments.nodes[0].body)\n"'
    echo ""
    echo "Resolve review threads with: ./scripts/resolve_pr_comment.sh <thread_id>"
  fi

  echo ""
  if [ "$IN_PROGRESS_COUNT" -gt 0 ]; then
    echo "⏳ Codex has not finished reviewing this PR. Re-run this check after the review completes."
  fi
  if codex_only_in_progress_blocks; then
    exit 10
  fi
  echo "Please address or resolve all Codex comments before merging."
  exit 1
fi

echo "✅ No unresolved Codex comments found"
exit 0
