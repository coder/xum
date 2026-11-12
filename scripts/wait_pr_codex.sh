#!/usr/bin/env bash
set -euo pipefail
# gh logs whole replies (check names, comment bodies) to stderr under GH_DEBUG or DEBUG. That would
# bypass what this script prints, so it runs gh without them.
unset GH_DEBUG DEBUG

# Wait for Codex to respond to a `@codex review` request.
#
# Usage: ./scripts/wait_pr_codex.sh <pr_number> [--once]
#
# Approval is an approval comment or a thumbs-up reaction after the latest request, while the
# Codex comments gate counts no open review thread. The only head this script binds is the one that
# a receipt names: its `Reviewed commit` must start the PR head (at least 10 characters, lowercase
# hex in backticks as Codex prints it, and as the gate reads it), because a receipt for an earlier
# head outlasts a push. The first `Reviewed commit` line decides. A line that holds no such SHA
# does not count. A thumbs-up, and a receipt with no `Reviewed commit` label,
# name no head. This script does not read the summary board for them, so one that outlasts a push
# stays an approval here, and so does one on a PR that has no summary board at all. The board
# (head, still running, findings) is the gate's: `wait_pr_ready.sh` and the CI `Codex Comments`
# check run it after this script.
#
# Output carries fixed text, counts, timestamps and GitHub IDs only. Codex comment bodies quote
# PR code, so an approval prints the comment's time instead of its body, and findings print
# counts with the explicit read: ./scripts/check_codex_comments.sh <pr_number>
#
# Exits:
#   0 - Codex approved and the Codex comments gate counted no open review thread, or Codex
#       reported a usage limit with no outstanding findings
#   1 - Codex left comments to address, approved while a review thread is open (or while the
#       gate could not read the threads), OR failed to review for another reason
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

# Comment/review authors come back as this login, but a reaction's `user.login` is the
# bot's User login with a "[bot]" suffix; the reaction matchers accept both.
BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"
SKIP_FETCH_SYNC="${MUX_SKIP_FETCH_SYNC:-0}"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"
# shellcheck source=./lib/reply_shape.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/reply_shape.sh"
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
REACTIONS_SCAN_CACHE_FILE="${MUX_REACTIONS_SCAN_CACHE_FILE:-}"
if [[ -z "$REACTIONS_SCAN_CACHE_FILE" && -n "$PR_DATA_FILE" ]]; then
  REACTIONS_SCAN_CACHE_FILE="${PR_DATA_FILE}.reactions-scan"
fi

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

if [[ -n "$REACTIONS_SCAN_CACHE_FILE" ]]; then
  if [ ! -e "$REACTIONS_SCAN_CACHE_FILE" ] && ! : >"$REACTIONS_SCAN_CACHE_FILE"; then
    echo "❌ assertion failed: unable to create reactions scan cache file at '$REACTIONS_SCAN_CACHE_FILE'" >&2
    exit 1
  fi

  if [ ! -w "$REACTIONS_SCAN_CACHE_FILE" ]; then
    echo "❌ assertion failed: reactions scan cache file is not writable: '$REACTIONS_SCAN_CACHE_FILE'" >&2
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
      reactions(last: 100, content: THUMBS_UP) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          createdAt
          user { login }
        }
      }
    }
  }
}'

# shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
REACTIONS_GRAPHQL_QUERY='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reactions(first: 100, after: $cursor, content: THUMBS_UP) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          createdAt
          user { login }
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

FETCH_REACTIONS_PAGE() {
  local cursor="$1"
  local attempt
  local backoff
  backoff="$BACKOFF_SECS"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if gh api graphql \
      -f query="$REACTIONS_GRAPHQL_QUERY" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor"; then
      return 0
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "❌ GraphQL reactions query failed after ${MAX_ATTEMPTS} attempts" >&2
      return 1
    fi

    echo "⚠️ GraphQL reactions query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${backoff}s..." >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
  done
}

FETCH_ALL_THUMBS_UP_REACTIONS() {
  local all_reactions='[]'
  local cursor="null"
  local reactions_page
  local page_nodes
  local has_next
  local end_cursor

  while true; do
    reactions_page=$(FETCH_REACTIONS_PAGE "$cursor") || return 1

    if [ "$(echo "$reactions_page" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_nodes=$(reply_connection_nodes "$reactions_page" reactions) || return 1
    # Via stdin: accumulated pages can exceed Linux's per-argument limit (MAX_ARG_STRLEN).
    all_reactions=$(printf '%s\n%s' "$all_reactions" "$page_nodes" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$reactions_page" | jq -r '.data.repository.pullRequest.reactions.pageInfo.hasNextPage')
    end_cursor=$(echo "$reactions_page" | jq -r '.data.repository.pullRequest.reactions.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reactions hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reactions hasNextPage value in the GitHub reply" >&2
        return 1
        ;;
    esac
  done

  printf '%s\n' "$all_reactions"
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
# When reactions(last: 100) is incomplete, avoid paginating on every poll while Codex is
# still pending. We do one full scan per @codex request (and at most every 5 minutes after).
FULL_REACTIONS_SCAN_INTERVAL_SECS=300
LAST_FULL_REACTIONS_SCAN_REQUEST_AT=""
LAST_FULL_REACTIONS_SCAN_EPOCH=0

should_scan_full_reactions_for_request() {
  local request_at="$1"
  local now_epoch="$2"
  local cached_request_at="$LAST_FULL_REACTIONS_SCAN_REQUEST_AT"
  local cached_last_scan_epoch="$LAST_FULL_REACTIONS_SCAN_EPOCH"
  local cache_request_at
  local cache_last_scan_epoch

  if [[ -n "$REACTIONS_SCAN_CACHE_FILE" ]] && [ -s "$REACTIONS_SCAN_CACHE_FILE" ]; then
    if jq -e '.requestAt != null and .lastScanEpoch != null' "$REACTIONS_SCAN_CACHE_FILE" >/dev/null 2>&1; then
      cache_request_at=$(jq -r '.requestAt // empty' "$REACTIONS_SCAN_CACHE_FILE")
      cache_last_scan_epoch=$(jq -r '.lastScanEpoch // 0' "$REACTIONS_SCAN_CACHE_FILE")
      cached_request_at="$cache_request_at"
      cached_last_scan_epoch="$cache_last_scan_epoch"
    fi
  fi

  if [[ "$cached_request_at" != "$request_at" ]]; then
    return 0
  fi

  if ! [[ "$cached_last_scan_epoch" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if ((now_epoch - cached_last_scan_epoch >= FULL_REACTIONS_SCAN_INTERVAL_SECS)); then
    return 0
  fi

  return 1
}

record_full_reactions_scan() {
  local request_at="$1"
  local scan_epoch="$2"

  LAST_FULL_REACTIONS_SCAN_REQUEST_AT="$request_at"
  LAST_FULL_REACTIONS_SCAN_EPOCH="$scan_epoch"

  if [[ -z "$REACTIONS_SCAN_CACHE_FILE" ]]; then
    return 0
  fi

  if ! jq -cn --arg request_at "$request_at" --argjson scan_epoch "$scan_epoch" '{requestAt: $request_at, lastScanEpoch: $scan_epoch}' >"$REACTIONS_SCAN_CACHE_FILE"; then
    echo "❌ assertion failed: unable to persist reactions scan cache to '$REACTIONS_SCAN_CACHE_FILE'" >&2
    return 1
  fi
}

# Sets check_output and check_rc (0 clean, 1 unresolved, 10 review still running).
run_codex_comments_gate() {
  # --counts-only: the gate prints counts and fixed lines, never a Codex comment body. That keeps
  # check_output (matched below and printed on failure) free of text that Codex or a PR author wrote.
  if check_output=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" --counts-only 2>&1); then
    check_rc=0
  else
    check_rc=$?
  fi
}

# An approval comment or a thumbs-up says nothing about review threads that are still unresolved:
# only the gate reads every thread. So an approval stands only when the gate (run before it) counted
# 0 unresolved review threads: every run that read the threads prints the count, and a gate that
# could not read them (a malformed page, a crash) prints none, which is no proof that none is open.
# Regular comments do not block an approval here: the gate counts every Codex regular comment except
# the ones that codex_comment_is_informational (scripts/lib/codex_comments.jq) reads as clean, and a
# Codex comment that is not a finding must not turn an approval into exit 1. wait_pr_ready.sh runs
# the gate over them again (its step 6), and CI's Codex Comments job runs on PR pushes, not in the
# merge queue.
approval_stands() {
  if grep -Eq '^Found 0 unresolved review thread' <<<"$check_output"; then
    return 0
  fi
  echo ""
  echo "$check_output"
  echo "❌ Codex approved PR #$PR_NUMBER, but the Codex comments gate did not confirm that no review thread is open."
  return 1
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
  local approval_comment_at
  local approval_reaction_at
  local reactions_has_previous
  local all_thumbs_up_reactions
  local should_scan_full_reactions
  local now_epoch
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
    echo "❌ assertion failed: PR headRefOid is missing or malformed in the GitHub reply" >&2
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
      echo "❌ assertion failed: unexpected PR state in the GitHub reply for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  all_comments=$(reply_connection_nodes "$pr_data" comments) || return 1
  all_threads=$(reply_connection_nodes "$pr_data" reviewThreads) || return 1
  # The reaction times are printed on approval, so the window's reactions get the same check.
  reply_connection_nodes "$pr_data" reactions >/dev/null || return 1

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

  # A fresh quota notice may pass the gate, but only after the full findings check below.
  rate_limit_comment=$(echo "$all_comments" | jq -r -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '
    include "codex_comments";
    [.[] | select(.createdAt > $request_at and .isMinimized != true and codex_usage_limit($bot))]
    | sort_by(.createdAt) | last // empty | .body // empty')

  # Only the time leaves this jq: the approval comment's body is Codex text. A receipt with a
  # `Reviewed commit` label names a commit. The first such line decides: it must hold a lowercase hex
  # SHA in backticks (Codex's format, the one the gate reads) of at least 10 characters that starts
  # the PR head. A shorter SHA, or a line that holds none (uppercase, non-hex, empty, unquoted), is
  # rejected, and not mistaken for a receipt with no line. A receipt with no label names no head and
  # stays as it was.
  approval_comment_at=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_APPROVAL_REGEX" --arg head "$pr_head" '
    [.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex)))
      | select(((.body | capture("[*][*]Reviewed commit:[*][*] ?(?<line>[^\n]*)")?) // null) as $label
          | if $label == null then true
            else (($label.line | capture("^`(?<sha>[0-9a-f]+)`")?) // null) as $named
              | $named != null and ($named.sha | length) >= 10 and ($head | startswith($named.sha))
            end)
      | {createdAt}] | sort_by(.createdAt) | last // empty | .createdAt // empty')

  if [[ -n "$approval_comment_at" ]]; then
    approval_stands || return 1
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER"
    echo ""
    echo "Approval comment time: $approval_comment_at"
    return 0
  fi

  approval_reaction_at=$(echo "$pr_data" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.data.repository.pullRequest.reactions.nodes[]? | select((.user.login == $bot or .user.login == ($bot + "[bot]")) and .createdAt > $request_at) | .createdAt] | sort | last // empty')

  if [[ -n "$approval_reaction_at" ]]; then
    approval_stands || return 1
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER via thumbs-up on the PR description"
    echo ""
    echo "Reaction timestamp: $approval_reaction_at"
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

  reactions_has_previous=$(echo "$pr_data" | jq -r '(.data.repository.pullRequest.reactions.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)')

  should_scan_full_reactions=0
  case "$reactions_has_previous" in
    false) ;;
    true)
      if [ "$codex_response_count" -gt 0 ]; then
        should_scan_full_reactions=1
      else
        # While waiting on Codex, avoid paginating the entire thumbs-up history every poll.
        # Scan once per @codex request and then at a coarse interval.
        now_epoch=$(date +%s)
        if should_scan_full_reactions_for_request "$request_at" "$now_epoch"; then
          should_scan_full_reactions=1
        fi
      fi
      ;;
    unknown)
      echo "❌ assertion failed: reactions pageInfo.hasPreviousPage is missing" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected reactions hasPreviousPage value in the GitHub reply" >&2
      return 1
      ;;
  esac

  if [ "$should_scan_full_reactions" -eq 1 ]; then
    # Codex may react early and later reactions can push that approval out of the
    # most-recent 100 window. Only paginate when needed to keep API churn bounded.
    all_thumbs_up_reactions=$(FETCH_ALL_THUMBS_UP_REACTIONS) || return 1
    now_epoch=$(date +%s)
    record_full_reactions_scan "$request_at" "$now_epoch" || return 1
    approval_reaction_at=$(echo "$all_thumbs_up_reactions" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select((.user.login == $bot or .user.login == ($bot + "[bot]")) and .createdAt > $request_at) | .createdAt] | sort | last // empty')

    if [[ -n "$approval_reaction_at" ]]; then
      approval_stands || return 1
      echo ""
      echo "✅ Codex approved PR #$PR_NUMBER via thumbs-up on the PR description"
      echo ""
      echo "Reaction timestamp: $approval_reaction_at"
      return 0
    fi
  fi

  # No approval yet. The gate is the single source of truth for what blocks: it
  # paginates every comment and thread, so an unresolved thread from before the
  # request or a board pushed out of this script's 100-comment window still fails
  # fast here instead of after the review ends. Gate 10 means Codex is still
  # reviewing the current head and nothing else blocks.
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
  echo "   👉 Expected either a thumbs-up reaction on the PR description or an approval comment like 'Didn't find any major issues'."
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
echo "  - thumbs-up reaction on the PR description OR an explicit approval comment (script exits 0, or 1 while a review thread is open)"
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
