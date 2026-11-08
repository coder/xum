#!/usr/bin/env bash
set -euo pipefail

# Wait for Codex to respond to a `@codex review` request.
#
# Usage: ./scripts/wait_pr_codex.sh <pr_number> [--once]
#
# Approval is an approval comment whose `Reviewed commit` names the PR head, after the latest
# request, and only while check_codex_comments.sh finds nothing that blocks the head. A receipt for
# an earlier head and a thumbs-up reaction name no current head (both outlast a push), so neither
# approves.
#
# Exits:
#   0 - Codex approved, or reported a usage limit with no outstanding findings
#   1 - Codex left comments to address OR failed to review for another reason
#  10 - still waiting for Codex response (only in --once mode)

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <pr_number> [--once]"
  exit 1
fi

PR_NUMBER=$1
MODE="wait"

if [ $# -eq 2 ]; then
  if [ "$2" = "--once" ]; then
    MODE="once"
  else
    echo "❌ Unknown argument: '$2'" >&2
    echo "Usage: $0 <pr_number> [--once]" >&2
    exit 1
  fi
fi

# Polling every 30s reduces GitHub API churn while still giving timely readiness updates.
POLL_INTERVAL_SECS=30

# Comment/review authors come back as this login.
BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"
SKIP_FETCH_SYNC="${MUX_SKIP_FETCH_SYNC:-0}"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'"
  exit 1
fi

if [ ! -x "$CHECK_CODEX_COMMENTS_SCRIPT" ]; then
  echo "❌ assertion failed: missing executable helper script: $CHECK_CODEX_COMMENTS_SCRIPT" >&2
  exit 1
fi

if [ "$SKIP_FETCH_SYNC" != "0" ] && [ "$SKIP_FETCH_SYNC" != "1" ]; then
  echo "❌ assertion failed: MUX_SKIP_FETCH_SYNC must be '0' or '1' (got '$SKIP_FETCH_SYNC')" >&2
  exit 1
fi

if [[ -n "$PR_DATA_FILE" ]]; then
  if [ ! -e "$PR_DATA_FILE" ] && ! : >"$PR_DATA_FILE"; then
    echo "❌ assertion failed: unable to create MUX_PR_DATA_FILE at '$PR_DATA_FILE'" >&2
    exit 1
  fi

  if [ ! -w "$PR_DATA_FILE" ]; then
    echo "❌ assertion failed: MUX_PR_DATA_FILE is not writable: '$PR_DATA_FILE'" >&2
    exit 1
  fi
fi

CODEX_APPROVAL_REGEX="Didn't find any major issues"

if [ "$SKIP_FETCH_SYNC" = "0" ]; then
  assert_pr_checkout_synced "$PR_NUMBER" || exit 1
fi

# shellcheck disable=SC2016 # Single quotes are intentional - these are GraphQL queries.
GRAPHQL_QUERY='query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      headRefOid
      comments(last: 100) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          id
          author { login }
          authorAssociation
          body
          createdAt
          isMinimized
        }
      }
      reviewThreads(last: 100) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              id
              fullDatabaseId
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

if [[ -n "${MUX_GH_OWNER:-}" || -n "${MUX_GH_REPO:-}" ]]; then
  if [[ -z "${MUX_GH_OWNER:-}" || -z "${MUX_GH_REPO:-}" ]]; then
    echo "❌ assertion failed: MUX_GH_OWNER and MUX_GH_REPO must both be set when one is provided" >&2
    exit 1
  fi
  OWNER="$MUX_GH_OWNER"
  REPO="$MUX_GH_REPO"
else
  REPO_INFO=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}')
  OWNER=$(echo "$REPO_INFO" | jq -r '.owner')
  REPO=$(echo "$REPO_INFO" | jq -r '.name')
fi

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "❌ assertion failed: owner/repo must be non-empty" >&2
  exit 1
fi

# Depot runners sometimes hit transient network timeouts to api.github.com.
# Retry the GraphQL request a few times before failing.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

FETCH_PR_DATA() {
  local attempt
  local backoff
  backoff="$BACKOFF_SECS"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if gh api graphql \
      -f query="$GRAPHQL_QUERY" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER"; then
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

cache_pr_data() {
  local pr_data_json="$1"

  if [[ -z "$PR_DATA_FILE" ]]; then
    return 0
  fi

  if ! printf '%s\n' "$pr_data_json" >"$PR_DATA_FILE"; then
    echo "❌ assertion failed: unable to write PR data to '$PR_DATA_FILE'" >&2
    return 1
  fi
}

LAST_REQUEST_AT=""

# Sets check_output and check_rc (0 clean, 1 unresolved, 10 review still running).
run_codex_comments_gate() {
  if check_output=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
    check_rc=0
  else
    check_rc=$?
  fi
}

# A push-triggered Codex run posts no security receipt (coder/xum#7731), so the gate waits on one.
# The gate reads every comment and says when a request is needed: once per head, because the
# request names the head and the gate skips a head that a request already names.
request_security_review_if_needed() {
  local head="$1"
  [[ "$check_output" == *"No Codex security review was requested for $head"* ]] || return 0
  echo "⏳ Codex finished without a security receipt for ${head:0:10}; requesting a Codex security review."
  gh pr comment "$PR_NUMBER" --repo "$OWNER/$REPO" --body "@codex security review

Head: $head" >/dev/null
}

CHECK_CODEX_STATUS_ONCE() {
  local pr_data
  local pr_state
  local pr_head
  local all_comments
  local all_threads
  local request_at
  local rate_limit_comment
  local approval_comment
  local codex_response_count_comments
  local codex_response_count_threads
  local codex_response_count
  local check_output

  pr_data=$(FETCH_PR_DATA)
  cache_pr_data "$pr_data" || return 1

  if [ "$(echo "$pr_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
    echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
    return 1
  fi

  pr_state=$(echo "$pr_data" | jq -r '.data.repository.pullRequest.state // empty')
  pr_head=$(echo "$pr_data" | jq -r '.data.repository.pullRequest.headRefOid // empty')
  if ! [[ "$pr_head" =~ ^[0-9a-f]{40}$ ]]; then
    echo "❌ assertion failed: PR headRefOid is missing or malformed: '$pr_head'" >&2
    return 1
  fi

  if [[ -z "$pr_state" ]]; then
    echo "❌ Unable to fetch PR state for #$PR_NUMBER in ${OWNER}/${REPO}." >&2
    return 1
  fi

  case "$pr_state" in
    MERGED)
      echo "✅ PR #$PR_NUMBER has been merged!"
      return 0
      ;;
    CLOSED)
      echo "❌ PR #$PR_NUMBER is closed (not merged)!"
      return 1
      ;;
    OPEN) ;;
    *)
      echo "❌ assertion failed: unexpected PR state '$pr_state' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  all_comments=$(echo "$pr_data" | jq '.data.repository.pullRequest.comments.nodes')
  all_threads=$(echo "$pr_data" | jq '.data.repository.pullRequest.reviewThreads.nodes')

  # Ignore Codex's own comments since they mention "@codex review" in boilerplate.
  request_at=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" '[.[] | select(.author.login != $bot and (.body | contains("@codex review")))] | sort_by(.createdAt) | last | .createdAt // empty')

  if [[ -z "$request_at" ]]; then
    echo "❌ No '@codex review' comment found on PR #$PR_NUMBER." >&2
    echo "" >&2
    echo "Post one (example):" >&2
    echo "  gh pr comment $PR_NUMBER --body-file - <<'EOF'" >&2
    echo "  @codex review" >&2
    echo "  " >&2
    echo "  Please take another look." >&2
    echo "  EOF" >&2
    return 1
  fi

  LAST_REQUEST_AT="$request_at"

  # Before any approval returns: an approved head that still lacks its security receipt fails
  # the gate, so request the receipt and keep waiting (coder/xum#7731).
  run_codex_comments_gate
  if [ "$check_rc" -eq 10 ] && [[ "$check_output" == *"Waiting for the Codex security receipt for $pr_head"* ]]; then
    # A usage-limit notice after this head's request means no receipt will come: fail, never pass.
    if [ "$(echo "$all_comments" | jq -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" --arg head "$pr_head" 'include "codex_comments";
      ([.[] | select(.author.login != $bot and (.body | contains("@codex security review") and contains($head))) | .createdAt] | max) as $asked
      | $asked != null and any(.[]; .createdAt > $asked and .isMinimized != true and codex_usage_limit($bot))')" = "true" ]; then
      echo "❌ Codex usage limits reached: no security receipt for $pr_head."
      return 1
    fi
    request_security_review_if_needed "$pr_head" || return 1
    return 10
  fi

  # The gate is the single source of truth for what blocks, and it decides before any approval
  # counts: it paginates every comment and thread, so an unresolved thread from before the
  # request, a failed review or a board pushed out of this script's 100-comment window fails
  # here, and a review of the head that still runs waits. Gate 10 means Codex is still reviewing
  # the current head and nothing else blocks.
  case "$check_rc" in
    0) ;;
    10)
      return 10
      ;;
    *)
      echo ""
      echo "$check_output"
      return 1
      ;;
  esac

  # A fresh quota notice can pass, but only after the gate above found nothing that blocks.
  rate_limit_comment=$(echo "$all_comments" | jq -r -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '
    include "codex_comments";
    [.[] | select(.createdAt > $request_at and .isMinimized != true and codex_usage_limit($bot))]
    | sort_by(.createdAt) | last // empty | .body // empty')

  # An approval counts for the head it names: the receipt's `Reviewed commit` is a short SHA (7 or
  # more hex characters) that starts the PR head. A receipt for an earlier head outlasts a push, and
  # a receipt that names no commit cannot be tied to a head, so neither approves. A thumbs-up
  # reaction names no head either, so it never approves.
  approval_comment=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_APPROVAL_REGEX" --arg head "$pr_head" '
    [.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex)))
      | select(((.body | capture("[*][*]Reviewed commit:[*][*] `(?<sha>[0-9a-f]{7,40})`")?) // {sha: ""}).sha as $sha
          | $sha != "" and ($head | startswith($sha)))
      | {createdAt, body}] | sort_by(.createdAt) | last // empty | .body // empty')

  if [[ -n "$approval_comment" ]]; then
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER"
    echo ""
    echo "$approval_comment"
    return 0
  fi

  # Completed no-findings security envelopes for the current head are neither
  # approval nor a failed review; they are excluded so the poller keeps waiting
  # for the approval signal. Summary boards never count: whether a board blocks
  # depends on every review thread (resolved advisories), and only the paginated
  # gate below sees them all. Other comments, including account errors, count.
  codex_response_count_comments=$(echo "$all_comments" | jq -r -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" --arg head "$pr_head" --arg request_at "$request_at" '
    include "codex_comments";
    [.[] | select(.author.login == $bot and .createdAt > $request_at)
      | select(codex_usage_limit($bot) | not)
      | select(
          ((.body | codex_without_help | startswith("<!-- codex-pull-request-review-summary -->"))
            or ((.body | codex_without_help | startswith("Security review completed."))
              and codex_comment_is_informational($bot; $head; []; {code_review: [], security_review: []}))) | not
        )] | length
  ')
  codex_response_count_threads=$(echo "$all_threads" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select((.comments.nodes | length) > 0 and .comments.nodes[0].author.login == $bot and .comments.nodes[0].createdAt > $request_at)] | length')
  codex_response_count=$((codex_response_count_comments + codex_response_count_threads))

  if [[ -n "$rate_limit_comment" && "$codex_response_count_comments" -eq 0 ]]; then
    echo ""
    echo "✅ Codex gate passed: review skipped because usage limits were reached; no outstanding findings."
    return 0
  fi

  if [ "$codex_response_count" -eq 0 ]; then
    return 10
  fi

  echo ""
  echo "❌ Codex responded, but no approval signal was found after the latest '@codex review'."
  echo "   👉 Expected an approval comment like 'Didn't find any major issues' whose 'Reviewed commit' names the PR head (${pr_head:0:10}). A thumbs-up reaction names no head, so it does not count."
  echo "   👉 If you expected approval, re-comment '@codex review' and run this script again."
  return 1
}

if [ "$MODE" = "once" ]; then
  if CHECK_CODEX_STATUS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0 | 1 | 10)
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for Codex review on PR #$PR_NUMBER..."
echo ""
echo "Tip: after you comment '@codex review', Codex will respond with either:"
echo "  - review comments / threads to address (script exits 1)"
echo "  - an approval comment that names the PR head (script exits 0)"
echo ""

while true; do
  if CHECK_CODEX_STATUS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0)
      exit 0
      ;;
    1)
      exit 1
      ;;
    10)
      echo -ne "\r⏳ Waiting for Codex response... (requested at ${LAST_REQUEST_AT})  "
      sleep "$POLL_INTERVAL_SECS"
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
done
