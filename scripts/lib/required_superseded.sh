#!/usr/bin/env bash
# Decide whether this cancelled PR run's `Required` job may stand down (#4547).
#
# Why: a push that updates both a stacked PR's head and its base branch starts two
# pull_request runs for the same head SHA. The concurrency group cancels the older
# one, and its red `Required` blocked the PR although the other run passed.
#
# Exit 0 (stand down) only with proof that another run will publish `Required` for
# this PR's current state. A run qualifies when it:
#   - is for this PR number with the same base SHA as this event (the same commit can
#     head PRs against other bases, and concurrency order is not guaranteed);
#   - is a fresh attempt (run_attempt 1) that started at or after this run: the
#     superseding run is newer, and a rerun keeps its original merge ref while getting
#     a fresh start time;
#   - will publish `Required`: it is `pending` (queued behind this concurrency group),
#     `queued` or `in_progress`, or it completed with success/failure. `Required` is
#     `if: always()`, so a run that gets to execute jobs publishes it even if it is
#     later cancelled (observed in cancelled run 36124817306). A `pending` run has
#     already passed workflow startup; startup_failure, action_required and stale end
#     as completed runs and never count. `requested`/`waiting` runs do not count either.
# Do not wait for the sibling to start a job: it cannot, because it stays `pending`
# until this run (same concurrency group) finishes. On PR #4573 a run polled for its
# sibling's first job for 10 minutes; the sibling started 4 s after that run ended.
# A pending sibling that is later cancelled by hand never publishes; that deliberate
# action is the residual gap, and the merge queue still validates before merging.
# Everything else, including API errors, exits nonzero: `Required` then fails as before.
#
# Env: GITHUB_REPOSITORY, GITHUB_RUN_ID, HEAD_SHA, BASE_SHA, PR_NUMBER.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${HEAD_SHA:?}" "${BASE_SHA:?}" "${PR_NUMBER:?}"

runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/pr.yml/runs?head_sha=$HEAD_SHA&event=pull_request&per_page=100")
started=$(jq -r --argjson id "$GITHUB_RUN_ID" \
  '.workflow_runs[] | select(.id == $id) | .run_started_at // empty' <<<"$runs")
if [[ -z "$started" ]]; then
  echo "This run ($GITHUB_RUN_ID) is not listed for $HEAD_SHA; not standing down."
  exit 1
fi

superseding=$(jq -r --argjson id "$GITHUB_RUN_ID" --argjson pr "$PR_NUMBER" \
  --arg base "$BASE_SHA" --arg started "$started" '
  [.workflow_runs[]
    | select(.id != $id and .run_attempt == 1 and .run_started_at >= $started)
    | select(any(.pull_requests[]; .number == $pr and .base.sha == $base))
    | select(.status == "pending" or .status == "queued" or .status == "in_progress"
        or (.status == "completed" and (.conclusion == "success" or .conclusion == "failure")))
    | "\(.id) (\(.status)\(if .conclusion then "/" + .conclusion else "" end))"]
  | join(", ")' <<<"$runs")
if [[ -z "$superseding" ]]; then
  echo "No newer run for PR #$PR_NUMBER at $HEAD_SHA (base $BASE_SHA) will publish Required; not standing down."
  exit 1
fi
echo "Superseded by $superseding, which will publish Required for PR #$PR_NUMBER."
