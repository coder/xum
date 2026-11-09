#!/usr/bin/env bash
# Check for unresolved review comments from coder-agents-review.
# Usage: ./scripts/check_coder_agents_review_comments.sh <pr_number> [--counts-only]
# Exits 0 if all bot-authored review threads are resolved, 1 otherwise.
#
# Default output lists each unresolved thread with its path, user and body: reading them is
# this script's job. The bot quotes PR code, so those bodies carry text that the PR author
# controls. --counts-only prints the count and fixed text instead, for gates that must not
# print them (wait_pr_ready.sh).

set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <pr_number> [--counts-only]" >&2
  exit 1
fi

PR_NUMBER="$1"
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

COUNTS_ONLY=0
if [ $# -eq 2 ]; then
  if [ "$2" != "--counts-only" ]; then
    echo "❌ Unknown argument: '$2'" >&2
    echo "Usage: $0 <pr_number> [--counts-only]" >&2
    exit 1
  fi
  COUNTS_ONLY=1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./lib/coder_agents_review.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/coder_agents_review.sh"
BOT_LOGIN_REGEX="${CODER_AGENTS_REVIEW_BOT_LOGIN_REGEX:-^coder-agents-review(\[bot\])?$}"
UNRESOLVED=""

append_unresolved_records() {
  local records="$1"

  if [[ -z "$records" ]]; then
    return 0
  fi

  if [[ -n "$UNRESOLVED" ]]; then
    UNRESOLVED+=$'\n'
  fi

  UNRESOLVED+="$records"
}

fetch_unresolved_via_api() {
  # Query all review-thread pages so older unresolved bot feedback cannot be missed.
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

  resolve_repo_context

  local cursor="null"
  local page_data
  local page_threads
  local unresolved_page
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
    unresolved_page=$(coder_agents_unresolved_threads_from_json "$page_threads" "$BOT_LOGIN_REGEX")
    append_unresolved_records "$unresolved_page"

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
}

echo "Checking for unresolved coder-agents-review comments in PR #${PR_NUMBER}..."

fetch_unresolved_via_api

if [ -n "$UNRESOLVED" ]; then
  if [ "$COUNTS_ONLY" -eq 1 ]; then
    echo "❌ Unresolved coder-agents-review threads: $(echo "$UNRESOLVED" | jq -s 'length')"
    echo "Read them with: ./scripts/check_coder_agents_review_comments.sh $PR_NUMBER"
  else
    coder_agents_print_unresolved_threads "$UNRESOLVED"
  fi
  echo ""

  echo "View PR: https://github.com/${OWNER}/${REPO}/pull/$PR_NUMBER"
  exit 1
fi

echo "✅ No unresolved coder-agents-review comments found"
exit 0
