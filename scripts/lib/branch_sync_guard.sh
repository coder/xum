#!/usr/bin/env bash
# Shared checkout guard for the wait_pr_*.sh scripts.
#
# Usage: source this file, then call assert_pr_checkout_synced <pr_number>.
# Returns 0 when the checkout cannot hide work from the PR; non-zero otherwise.
#
# The guard applies only when this checkout is on the PR's head branch. There it fails on
# uncommitted changes, or when HEAD is not the PR's head commit, so a watcher never reports
# on a PR that is missing local work. Agents often watch several stacked PRs from one
# checkout (#7877). On any other branch the local state says nothing about the PR, so the
# guard passes. It never pushes, and it never reads @{u}: a stack branch's upstream is
# often its parent's branch (#7874).

set -euo pipefail

assert_pr_checkout_synced() {
  local pr_number="$1"
  local pr_head
  local head_ref
  local head_oid
  local current_branch
  local local_hash

  if ! pr_head=$(gh pr view "$pr_number" --json headRefName,headRefOid); then
    echo "❌ Error: Failed to read PR #$pr_number's head branch with 'gh pr view'." >&2
    return 1
  fi
  head_ref=$(jq -r '.headRefName // empty' <<<"$pr_head")
  head_oid=$(jq -r '.headRefOid // empty' <<<"$pr_head")
  if [[ -z "$head_ref" ]] || ! [[ "$head_oid" =~ ^[0-9a-f]{40}$ ]]; then
    echo "❌ assertion failed: gh returned no head branch or head commit for PR #$pr_number" >&2
    echo "$pr_head" >&2
    return 1
  fi

  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$head_ref" ]]; then
    echo "ℹ️  Skipping the local sync check: this checkout is on '$current_branch', not PR #$pr_number's branch '$head_ref'." >&2
    return 0
  fi

  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory." >&2
    echo "" >&2
    git status --short >&2
    echo "" >&2
    echo "Please commit or stash your changes before checking PR status." >&2
    return 1
  fi

  local_hash=$(git rev-parse HEAD)
  if [[ "$local_hash" == "$head_oid" ]]; then
    return 0
  fi

  echo "❌ Error: Local branch is not in sync with PR #$pr_number." >&2
  echo "" >&2
  echo "Local:   $local_hash" >&2
  echo "PR head: $head_oid" >&2
  echo "" >&2

  # Fetch the PR's branch so the ahead/behind report can reach a PR head pushed from elsewhere.
  git fetch origin "$head_ref" --quiet 2>/dev/null || true
  if ! git cat-file -e "$head_oid^{commit}" 2>/dev/null; then
    echo "The PR head commit is not in this checkout. Fetch it with: git fetch origin $head_ref" >&2
  elif git merge-base --is-ancestor "$head_oid" HEAD; then
    echo "Your branch is $(git rev-list --count "$head_oid"..HEAD) commit(s) ahead of PR #$pr_number." >&2
    echo "Push your changes with: git push origin $head_ref" >&2
  elif git merge-base --is-ancestor HEAD "$head_oid"; then
    echo "Your branch is $(git rev-list --count HEAD.."$head_oid") commit(s) behind PR #$pr_number." >&2
    echo "Pull the latest changes with: git pull origin $head_ref" >&2
  else
    echo "Your branch has diverged from PR #$pr_number." >&2
    echo "You may need to rebase or merge." >&2
  fi
  return 1
}
