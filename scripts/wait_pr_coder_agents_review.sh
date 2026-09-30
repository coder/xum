#!/usr/bin/env bash
set -euo pipefail

# Optionally wait for coder-agents-review to respond to a `/coder-agents-review` request.
#
# Usage: ./scripts/wait_pr_coder_agents_review.sh <pr_number> [--once]
#
# Exits:
#   0 - coder-agents-review gate passed, or skipped in wait mode
#   1 - coder-agents-review left blocking feedback or the PR is terminally invalid
#  10 - still waiting for coder-agents-review response (only in --once mode)
#  20 - optional gate is inactive/skipped (only in --once mode)

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <pr_number> [--once]" >&2
  exit 1
fi

PR_NUMBER="$1"
MODE="wait"
RC_PASSED=0
RC_FAILED=1
RC_PENDING=10
RC_SKIPPED=20

if [ $# -eq 2 ]; then
  if [ "$2" = "--once" ]; then
    MODE="once"
  else
    echo "❌ Unknown argument: '$2'" >&2
    echo "Usage: $0 <pr_number> [--once]" >&2
    exit 1
  fi
fi

REQUEST_COMMAND="/coder-agents-review"
# Match both the app slug and GitHub's bot-login form.
BOT_LOGIN_REGEX="${CODER_AGENTS_REVIEW_BOT_LOGIN_REGEX:-^coder-agents-review(\[bot\])?$}"
CODER_AGENTS_BOT_APPROVAL_REGEX="^(no (issues|problems)( found)?[.]?|no major issues( found)?[.]?|didn.t find (any )?(major )?(issues|problems)[.]?|review complete(d)?[.]?|zero open findings[.]?|zero open findings across .* (coder-agents-review |review )?complete[.]?|Round [0-9]+[.] zero open findings[.] (coder-agents-review |review )?complete[.]?|Round [0-9]+[.] zero open findings across .* (coder-agents-review |review )?complete[.]?|All [0-9]+ findings.*No open findings[.]?|No new code since .*All [0-9]+ findings remain resolved[.].*Nothing to review[.].*)$"
CODER_AGENTS_BOT_NEGATIVE_BEFORE_APPROVAL_REGEX="^(Round [0-9]+ is blocked|Review failed|Failed to review|Unable to review|Cannot review|Could not review|Review timed out|Request timed out|Review cancelled|Request cancelled)"
CODER_AGENTS_BOT_PROGRESS_REGEX="^(queued|started|running|in progress|reviewing|will review)[[:space:][:punct:]]*$"
POLL_INTERVAL_SECS=30
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SKIP_FETCH_SYNC="${MUX_SKIP_FETCH_SYNC:-0}"
# shellcheck source=./lib/coder_agents_review.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/coder_agents_review.sh"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

if [ "$SKIP_FETCH_SYNC" != "0" ] && [ "$SKIP_FETCH_SYNC" != "1" ]; then
  echo "❌ assertion failed: MUX_SKIP_FETCH_SYNC must be '0' or '1' (got '$SKIP_FETCH_SYNC')" >&2
  exit 1
fi

if [ "$SKIP_FETCH_SYNC" = "0" ]; then
  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory." >&2
    echo "" >&2
    git status --short >&2
    echo "" >&2
    echo "Please commit or stash your changes before checking PR status." >&2
    exit 1
  fi

  assert_branch_synced || exit 1
fi

fetch_pr_snapshot() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        state
        comments(last: 100) {
          pageInfo { hasPreviousPage }
          nodes {
            author { login }
            body
            createdAt
            isMinimized
          }
        }
        reviews(last: 100) {
          pageInfo { hasPreviousPage }
          nodes {
            author { login }
            body
            state
            createdAt
            submittedAt
          }
        }
        reviewThreads(last: 100) {
          pageInfo { hasPreviousPage }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
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

  graphql_with_retries "$graphql_query"
}

fetch_all_comments_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
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
    page_data=$(graphql_with_retries "$graphql_query" "$cursor") || return 1

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_comments=$(echo "$page_data" | jq -c '.data.repository.pullRequest.comments.nodes // []')
    all_comments=$(jq -cn --argjson existing "$all_comments" --argjson page "$page_comments" '$existing + $page')
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

  COMMENTS_JSON="$all_comments"
}

fetch_all_reviews_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviews(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            author { login }
            body
            state
            createdAt
            submittedAt
          }
        }
      }
    }
  }'

  local all_reviews='[]'
  local cursor="null"
  local page_data
  local page_reviews
  local has_next
  local end_cursor

  while true; do
    page_data=$(graphql_with_retries "$graphql_query" "$cursor") || return 1

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_reviews=$(echo "$page_data" | jq -c '.data.repository.pullRequest.reviews.nodes // []')
    all_reviews=$(jq -cn --argjson existing "$all_reviews" --argjson page "$page_reviews" '$existing + $page')
    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviews.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviews.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reviews hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reviews hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  REVIEWS_JSON="$all_reviews"
}

fetch_all_threads_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
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
    page_data=$(graphql_with_retries "$graphql_query" "$cursor") || return 1

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_threads=$(echo "$page_data" | jq -c '.data.repository.pullRequest.reviewThreads.nodes // []')
    all_threads=$(jq -cn --argjson existing "$all_threads" --argjson page "$page_threads" '$existing + $page')
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

  THREADS_JSON="$all_threads"
}

load_pr_data() {
  local pr_data
  local pr_state
  local comments_has_previous
  local reviews_has_previous
  local threads_has_previous

  pr_data=$(fetch_pr_snapshot) || return 1

  if [ "$(echo "$pr_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
    echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
    return 1
  fi

  pr_state=$(echo "$pr_data" | jq -r '.data.repository.pullRequest.state // empty')
  case "$pr_state" in
    MERGED)
      echo "✅ PR #$PR_NUMBER has been merged!"
      return "$RC_SKIPPED"
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

  COMMENTS_JSON=$(echo "$pr_data" | jq -c '.data.repository.pullRequest.comments.nodes // []')
  REVIEWS_JSON=$(echo "$pr_data" | jq -c '.data.repository.pullRequest.reviews.nodes // []')
  THREADS_JSON=$(echo "$pr_data" | jq -c '.data.repository.pullRequest.reviewThreads.nodes // []')

  comments_has_previous=$(echo "$pr_data" | jq -r '(.data.repository.pullRequest.comments.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)')
  reviews_has_previous=$(echo "$pr_data" | jq -r '(.data.repository.pullRequest.reviews.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)')
  threads_has_previous=$(echo "$pr_data" | jq -r '(.data.repository.pullRequest.reviewThreads.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)')

  case "$comments_has_previous" in
    false) ;;
    true) fetch_all_comments_via_api || return 1 ;;
    unknown)
      echo "❌ assertion failed: comments pageInfo.hasPreviousPage is missing" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected comments hasPreviousPage value '$comments_has_previous'" >&2
      return 1
      ;;
  esac

  case "$reviews_has_previous" in
    false) ;;
    true) fetch_all_reviews_via_api || return 1 ;;
    unknown)
      echo "❌ assertion failed: reviews pageInfo.hasPreviousPage is missing" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected reviews hasPreviousPage value '$reviews_has_previous'" >&2
      return 1
      ;;
  esac

  case "$threads_has_previous" in
    false) ;;
    true) fetch_all_threads_via_api || return 1 ;;
    unknown)
      echo "❌ assertion failed: reviewThreads pageInfo.hasPreviousPage is missing" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected reviewThreads hasPreviousPage value '$threads_has_previous'" >&2
      return 1
      ;;
  esac
}

classify_bot_text_response() {
  local body="$1"
  local created_at="$2"
  local source_label="$3"
  local normalized_body

  normalized_body=$(printf '%s' "$body" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')

  if printf '%s\n' "$normalized_body" | grep -Eiq "$CODER_AGENTS_BOT_NEGATIVE_BEFORE_APPROVAL_REGEX"; then
    echo ""
    echo "❌ coder-agents-review responded with a negative ${source_label} on PR #$PR_NUMBER."
  elif printf '%s\n' "$normalized_body" | grep -Eiq "$CODER_AGENTS_BOT_APPROVAL_REGEX"; then
    echo ""
    echo "✅ coder-agents-review gate passed for PR #$PR_NUMBER via ${source_label}"
    if [[ -n "$created_at" ]]; then
      echo "Timestamp: $created_at"
    fi
    return 0
  elif printf '%s\n' "$normalized_body" | grep -Eiq "$CODER_AGENTS_BOT_PROGRESS_REGEX"; then
    return "$RC_PENDING"
  else
    echo ""
    echo "❌ coder-agents-review responded with an unrecognized ${source_label} on PR #$PR_NUMBER."
  fi

  if [[ -n "$created_at" ]]; then
    echo "Timestamp: $created_at"
  fi
  echo ""
  echo "$body"
  echo ""
  echo "Review the bot response, then reply inline or leave a PR comment summarizing each response before resolving/re-requesting review."
  return 1
}

LAST_REQUEST_AT="none"

check_coder_agents_status_once() {
  local request_at
  local bot_activity_count
  local unresolved_threads
  local unresolved_count
  local response_count
  local latest_review_state
  local latest_review_at
  local latest_review_body
  local latest_issue_comment_body
  local latest_issue_comment_at

  resolve_repo_context || return 1
  if load_pr_data; then
    :
  else
    local load_rc=$?
    if [ "$load_rc" -eq "$RC_SKIPPED" ]; then
      return 0
    fi
    return "$load_rc"
  fi

  request_at=$(jq -rn \
    --argjson comments "$COMMENTS_JSON" \
    --arg command "$REQUEST_COMMAND" \
    --arg bot_regex "$BOT_LOGIN_REGEX" '
      [
        $comments[]
        | select((((.author.login // "") | test($bot_regex)) | not) and ((.body // "") | test("(?m)^\\s*/coder-agents-review\\s*$")))
      ]
      | sort_by(.createdAt)
      | last
      | .createdAt // empty
    ')

  if [[ -n "$request_at" ]]; then
    LAST_REQUEST_AT="$request_at"
  else
    LAST_REQUEST_AT="none"
  fi

  bot_activity_count=$(jq -rn \
    --argjson comments "$COMMENTS_JSON" \
    --argjson reviews "$REVIEWS_JSON" \
    --argjson threads "$THREADS_JSON" \
    --arg bot_regex "$BOT_LOGIN_REGEX" '
      ([
        $comments[]
        | select((.author.login // "") | test($bot_regex))
      ] | length)
      +
      ([
        $reviews[]
        | select(((.author.login // "") | test($bot_regex)) and (.state != "DISMISSED"))
      ] | length)
      +
      ([
        $threads[].comments.nodes[]?
        | select((.author.login // "") | test($bot_regex))
      ] | length)
    ')

  if [[ -z "$request_at" && "$bot_activity_count" -eq 0 ]]; then
    echo "ℹ️ coder-agents-review gate skipped: no '$REQUEST_COMMAND' comment and no bot review activity found."
    return "$RC_SKIPPED"
  fi

  unresolved_threads=$(coder_agents_unresolved_threads_from_json "$THREADS_JSON" "$BOT_LOGIN_REGEX")
  unresolved_count=$(printf '%s' "$unresolved_threads" | jq -s 'length')

  if [ "$unresolved_count" -gt 0 ]; then
    echo ""
    echo "❌ coder-agents-review has ${unresolved_count} unresolved review thread(s)."
    echo ""
    coder_agents_print_unresolved_threads "$unresolved_threads"
    return 1
  fi

  if [[ -n "$request_at" ]]; then
    response_count=$(jq -rn \
      --argjson comments "$COMMENTS_JSON" \
      --argjson reviews "$REVIEWS_JSON" \
      --argjson threads "$THREADS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        ([
          $comments[]
          | select(((.author.login // "") | test($bot_regex)) and (.createdAt > $request_at))
        ] | length)
        +
        ([
          $reviews[]
          | select(
              ((.author.login // "") | test($bot_regex))
              and (.state != "DISMISSED")
              and ((.submittedAt // .createdAt // "") > $request_at)
            )
        ] | length)
        +
        ([
          $threads[].comments.nodes[]?
          | select(((.author.login // "") | test($bot_regex)) and (.createdAt > $request_at))
        ] | length)
      ')

    if [ "$response_count" -eq 0 ]; then
      return "$RC_PENDING"
    fi

    latest_issue_comment_body=$(jq -rn \
      --argjson comments "$COMMENTS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        [
          $comments[]
          | select(((.author.login // "") | test($bot_regex)) and (.createdAt > $request_at))
        ]
        | sort_by(.createdAt)
        | last
        | .body // empty
      ')
    latest_issue_comment_at=$(jq -rn \
      --argjson comments "$COMMENTS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        [
          $comments[]
          | select(((.author.login // "") | test($bot_regex)) and (.createdAt > $request_at))
        ]
        | sort_by(.createdAt)
        | last
        | .createdAt // empty
      ')

    latest_review_body=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        [
          $reviews[]
          | select(
              ((.author.login // "") | test($bot_regex))
              and (.state != "DISMISSED")
              and ((.submittedAt // .createdAt // "") > $request_at)
            )
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .body // empty
      ')
    latest_review_state=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        [
          $reviews[]
          | select(
              ((.author.login // "") | test($bot_regex))
              and (.state != "DISMISSED")
              and ((.submittedAt // .createdAt // "") > $request_at)
            )
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .state // empty
      ')
    latest_review_at=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" \
      --arg request_at "$request_at" '
        [
          $reviews[]
          | select(
              ((.author.login // "") | test($bot_regex))
              and (.state != "DISMISSED")
              and ((.submittedAt // .createdAt // "") > $request_at)
            )
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .reviewedAt // empty
      ')
  else
    latest_issue_comment_body=$(jq -rn \
      --argjson comments "$COMMENTS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" '
        [
          $comments[]
          | select((.author.login // "") | test($bot_regex))
        ]
        | sort_by(.createdAt)
        | last
        | .body // empty
      ')
    latest_issue_comment_at=$(jq -rn \
      --argjson comments "$COMMENTS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" '
        [
          $comments[]
          | select((.author.login // "") | test($bot_regex))
        ]
        | sort_by(.createdAt)
        | last
        | .createdAt // empty
      ')

    latest_review_body=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" '
        [
          $reviews[]
          | select(((.author.login // "") | test($bot_regex)) and (.state != "DISMISSED"))
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .body // empty
      ')
    latest_review_state=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" '
        [
          $reviews[]
          | select(((.author.login // "") | test($bot_regex)) and (.state != "DISMISSED"))
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .state // empty
      ')
    latest_review_at=$(jq -rn \
      --argjson reviews "$REVIEWS_JSON" \
      --arg bot_regex "$BOT_LOGIN_REGEX" '
        [
          $reviews[]
          | select(((.author.login // "") | test($bot_regex)) and (.state != "DISMISSED"))
          | . + {reviewedAt: (.submittedAt // .createdAt // "")}
        ]
        | sort_by(.reviewedAt)
        | last
        | .reviewedAt // empty
      ')
  fi

  if [[ "$latest_review_state" = "CHANGES_REQUESTED" && (-z "$latest_issue_comment_at" || ! "$latest_review_at" < "$latest_issue_comment_at") ]]; then
    echo ""
    echo "❌ coder-agents-review requested changes on PR #$PR_NUMBER."
    if [[ -n "$latest_review_at" ]]; then
      echo "Review timestamp: $latest_review_at"
    fi
    echo "Resolve/address the feedback, reply to the finding(s), and request another review with '$REQUEST_COMMAND'."
    return "$RC_FAILED"
  fi

  if [[ -n "$latest_issue_comment_body" && (-z "$latest_review_at" || "$latest_issue_comment_at" > "$latest_review_at") ]]; then
    classify_bot_text_response "$latest_issue_comment_body" "$latest_issue_comment_at" "issue comment"
    return $?
  fi

  if [[ "$latest_review_state" = "COMMENTED" && -n "$latest_review_body" ]]; then
    classify_bot_text_response "$latest_review_body" "$latest_review_at" "review body"
    return $?
  fi

  case "$latest_review_state" in
    APPROVED)
      echo ""
      echo "✅ coder-agents-review gate passed for PR #$PR_NUMBER"
      if [[ -n "$latest_review_at" ]]; then
        echo "Review timestamp: $latest_review_at"
      fi
      return 0
      ;;
    COMMENTED)
      echo ""
      echo "❌ coder-agents-review left a commented review without approval text on PR #$PR_NUMBER."
      if [[ -n "$latest_review_at" ]]; then
        echo "Review timestamp: $latest_review_at"
      fi
      echo "Reply to the finding(s) and request another review with '$REQUEST_COMMAND'."
      return "$RC_FAILED"
      ;;
    "")
      echo ""
      echo "✅ coder-agents-review gate passed for PR #$PR_NUMBER"
      return 0
      ;;
    PENDING)
      return "$RC_PENDING"
      ;;
    DISMISSED)
      echo "❌ assertion failed: dismissed reviews should be filtered before state classification" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected coder-agents-review state '$latest_review_state'" >&2
      return 1
      ;;
  esac
}

if [ "$MODE" = "once" ]; then
  if check_coder_agents_status_once; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    "$RC_PASSED" | "$RC_FAILED" | "$RC_PENDING" | "$RC_SKIPPED")
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected coder-agents-review status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for optional coder-agents-review gate on PR #$PR_NUMBER..."
echo ""
echo "Tip: comment '$REQUEST_COMMAND' to opt this PR into the optional coder-agents-review gate."
echo "If the bot has already reviewed the PR, this script checks that feedback even without a request comment."
echo ""

while true; do
  if check_coder_agents_status_once; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    "$RC_PASSED")
      exit 0
      ;;
    "$RC_FAILED")
      exit 1
      ;;
    "$RC_PENDING")
      echo -ne "\r⏳ Waiting for coder-agents-review response... (requested at ${LAST_REQUEST_AT})  "
      sleep "$POLL_INTERVAL_SECS"
      ;;
    "$RC_SKIPPED")
      echo "ℹ️ Optional coder-agents-review gate is inactive; skipping."
      exit 0
      ;;
    *)
      echo "❌ assertion failed: unexpected coder-agents-review status code '$rc'" >&2
      exit 1
      ;;
  esac
done
