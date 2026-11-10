#!/usr/bin/env bash
# Shared PR check filters for scripts that gate merge readiness.

visual_check_jq_defs() {
  cat <<'JQ'
def check_text($field): (.[$field] // "" | tostring | ascii_downcase);
# A PR author names the jobs and workflows of its own Actions runs, so a check run counts as
# visual review only with both names of Pixel's real job. Only repo writers and installed apps
# can post a status context, so a status keeps the name and link rules. A check run can still
# copy both names: GitHub's required checks gate the merge, and the gates print how many
# checks they ignored.
def is_visual_review_check:
  if .kind == "status" then
    (check_text("name") == "visual regression testing")
    or (check_text("name") | startswith("pixel /"))
    or (check_text("link") | contains("pixel.coder.com"))
  else
    (check_text("workflow") == "pixel") and (check_text("name") == "visual regression testing")
  end;
def is_failed_check:
  (.bucket | IN("fail", "cancel"))
  or (.state | IN("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"));
def is_pending_check:
  (.bucket == "pending")
  or (.state | IN("PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"));
def is_passing_check:
  (.bucket == "pass") or (.state == "SUCCESS");
def is_skipped_check: .state | IN("SKIPPED", "NEUTRAL");
def is_unready_check: is_failed_check or is_pending_check;
# One statusCheckRollup context, as selected by check_context_graphql_fields.
def normalize_check($oid):
  if .__typename == "CheckRun" then
    {id, kind: "check_run", name, state: (if .status == "COMPLETED" then .conclusion // "PENDING" else .status end),
     link: .detailsUrl, description: "", workflow: (.checkSuite.workflowRun.workflow.name // ""),
     suite: .checkSuite.id}
  elif .__typename == "StatusContext" then
    {id, kind: "status", name: .context, state, link: .targetUrl, description, workflow: ""}
  else error("Unknown check context") end
  | .commit = $oid
  | .bucket = (if .state == "CANCELLED" then "cancel"
    elif is_failed_check then "fail" elif is_passing_check then "pass"
    elif is_skipped_check then "skipping"
    else "pending" end);
# A field of another type than GitHub's schema gives it (a name that is an array, say) prints as fixed
# text: @tsv fails on such a value, and jq then quotes the start of it in its message.
def text_or($default): if . == null then $default elif type == "string" then . else "<not text>" end;
def check_line:
  [
    (.name | text_or("<unnamed>")),
    (.bucket | text_or("<unknown>")),
    (.state | text_or("<unknown>")),
    (.link | text_or("")),
    (.description | text_or("")),
    (.commit | text_or(""))
  ] | @tsv;
JQ
}

# The fields normalize_check reads from one statusCheckRollup context node.
check_context_graphql_fields() {
  cat <<'GRAPHQL'
__typename
... on CheckRun {
  id name status conclusion detailsUrl
  checkSuite { id workflowRun { workflow { name } } }
}
... on StatusContext { id context state targetUrl description }
GRAPHQL
}

# shellcheck disable=SC2016 # These are GraphQL variables, not shell variables.
fetch_pr_check_state() {
  local pr
  pr=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F number="$1" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          state mergeable mergeStateStatus reviewDecision headRefOid potentialMergeCommit { oid }
        }
      }
    }') || return 1
  jq -cSe '
    .data.repository.pullRequest
    | if (.headRefOid | type) != "string" or .headRefOid == ""
        or (has("potentialMergeCommit") | not)
        or (.potentialMergeCommit != null and ((.potentialMergeCommit.oid | type) != "string" or .potentialMergeCommit.oid == ""))
      then error("Missing PR refs")
      else .reviewDecision = (.reviewDecision // "") end
  ' <<<"$pr"
}

# gh pr checks deduplicates by display name, hiding a failed run behind another
# suite's success. GitHub's rollup retains those independent runs but omits
# superseded attempts. Return 10 if a push/base update invalidates the snapshot.
# shellcheck disable=SC2016 # GraphQL/jq variables must not expand in the shell.
fetch_pr_checks() {
  local pr latest expected refs oid pages normalized checks='[]'
  pr=$(fetch_pr_check_state "$1") || return 1
  if [ "$#" -gt 1 ]; then
    # Do not combine an earlier CLEAN verdict with checks for a different head.
    expected=$(jq -cS . <<<"$2") || return 1
    latest=$(jq -cS 'del(.potentialMergeCommit)' <<<"$pr") || return 1
    [ "$latest" = "$expected" ] || return 10
  fi
  refs=$(jq -r '[.headRefOid, .potentialMergeCommit.oid] | map(select(. != null)) | unique[]' <<<"$pr") || return 1

  for oid in $refs; do
    pages=$(gh api graphql --paginate --slurp -F owner='{owner}' -F name='{repo}' -f oid="$oid" -f query='
      query($owner: String!, $name: String!, $oid: GitObjectID!, $endCursor: String) {
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              oid
              statusCheckRollup {
                contexts(first: 100, after: $endCursor) {
                  pageInfo { hasNextPage endCursor }
                  nodes { '"$(check_context_graphql_fields)"' }
                }
              }
            }
          }
        }
      }') || return 1
    normalized=$(jq -cer --arg oid "$oid" "$(visual_check_jq_defs)"'
      if type != "array" or length == 0
        or any(.[]; ((.errors // []) | length) > 0 or .data.repository.object.oid != $oid
          or (.data.repository.object | has("statusCheckRollup") | not))
      then error("Missing check snapshot")
      elif any(.[]; .data.repository.object.statusCheckRollup |
        . != null and ((.contexts.nodes | type) != "array" or (.contexts.pageInfo.hasNextPage | type) != "boolean"))
        or (.[-1].data.repository.object.statusCheckRollup |
          . != null and .contexts.pageInfo.hasNextPage != false)
      then error("Incomplete check pagination")
      else [ .[].data.repository.object.statusCheckRollup.contexts.nodes[]? | normalize_check($oid) ] end
    ' <<<"$pages") || return 1
    checks=$(printf '%s\n%s\n' "$checks" "$normalized" | jq -cs 'add') || return 1
  done
  # A passing old commit is not evidence that a concurrently pushed PR is ready.
  latest=$(fetch_pr_check_state "$1") || return 1
  [ "$latest" = "$pr" ] || return 10
  printf '%s\n' "$checks"
}
