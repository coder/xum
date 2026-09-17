# Codex now edits a protocol status comment alongside its actionable findings.
# Only recognize completed informational envelopes; extra text/metadata may
# carry findings, so unknown shapes stay blocking. This never supplies approval.
# Strip only the observed help text: a heading alone must not hide a finding
# added inside the details section, or a second section appended after it.
def codex_without_help:
  sub("^### 🛡️ Codex Security Review( · _Automatically triggered_)?\n\n"; "")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n"
    + "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n"
    + "- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\" or \"@codex security review\".\n\n"
    + "Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex security reviews in GitHub</summary>\n<br/>\n\n"
    + "This is an experimental Codex feature. Security reviews are triggered when:\n- You comment \"@codex security review\"\n"
    + "- A regular code review gets triggered (for example, \"@codex review\" or when a PR is opened), and you’re opted in so security review runs alongside code review\n\n"
    + "Once complete, Codex will leave suggestions, or a comment if no findings are found.\n\n\n</details>");

def codex_summary_marker: "<!-- codex-pull-request-review-summary -->";

def codex_review_row_prefix: "^\\| [^[:alnum:]|]*\\*\\*(Code|Security) Review\\*\\* \\| [^[:alnum:]|]*\\*\\*";
def codex_review_row_suffix: " \\| `[0-9a-f]+` \\| (Manual request|New commits|Draft marked ready|PR opened) \\|$";
def codex_relative_time: "<relative-time datetime=\"[0-9TZ:.+-]+\">[0-9TZ:.+-]+</relative-time>";
def codex_completed_row: codex_review_row_prefix + "Completed\\*\\*( " + codex_relative_time + ")?" + codex_review_row_suffix;
def codex_running_row: codex_review_row_prefix + "Running\\*\\* since " + codex_relative_time + codex_review_row_suffix;

# Parse the review summary board Codex edits in place. Emit its metadata status
# ("completed" or "running") only when every line has an observed informational
# shape; emit null for anything else so unknown content stays blocking. A status
# of "completed" with a Running row is contradictory and also emits null.
def codex_summary_status($bot):
  if .author.login != $bot then null
  else
    (.body | codex_without_help) as $body
    | if $body | startswith(codex_summary_marker) then
        (try (
          ($body | split("\n") | map(select(length > 0))) as $lines
          | ($lines[1] | capture("^<!-- codex-security-review:v1 (?<payload>.*) -->$").payload | fromjson) as $security
          | if $lines[0] == codex_summary_marker
            # Unknown security fields or statuses could be authoritative findings.
            # In particular, do not interpret an enabled security merge gate here.
            and ($security | type == "object"
              and ((keys - ["blockingSeverityThreshold", "headSha", "mergeGateEnabled", "pullRequestNumber", "repository", "status"]) | length == 0)
              and .mergeGateEnabled == false
              and (.blockingSeverityThreshold | test("^P[0-3]$"))
              and (.headSha | test("^[0-9a-f]{40}$"))
              and (.pullRequestNumber | type == "number")
              and (.repository | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
              and (.status == "completed" or .status == "running"))
            and ($lines[2:] | length >= 5)
            and ($lines[2:] | all(
              . == "## Codex Review Summary"
              or . == "This comment shows the latest Codex review activity on this pull request."
              or . == "| Review | Status | Commit | Review trigger |"
              or . == "| --- | --- | --- | --- |"
              or test(codex_completed_row)
              or test(codex_running_row)
              # Security advisories stay listed after their review threads are resolved, and
              # Codex adds the Resolved marker only when a later review completes. A bullet
              # without it is a live finding and keeps blocking; other sections stay unknown.
              or . == "### Security findings"
              or test("^#### Advisory findings \\([0-9]+\\)$")
              or test("^- [^[:alnum:]|\\[]*\\[[^\\]]+\\]\\(https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+#discussion_r[0-9]+\\)"
                + " · \\*\\*[A-Za-z]+\\*\\* · \\*\\*Resolved\\*\\*$")
            ))
            and ($security.status == "running" or ($lines[2:] | any(test(codex_running_row)) | not))
            then $security.status
            else null
            end
        # capture() yields empty, not an error, on a non-matching metadata line;
        # `// null` turns that into an explicit unknown so callers never fail open.
        ) catch null) // null
      else null
      end
  end;

# Codex is still reviewing. Callers may wait on this state instead of failing on
# it, but it never supplies approval: after any wait budget it blocks like before.
def codex_review_in_progress($bot):
  codex_summary_status($bot) == "running";

def codex_comment_is_informational($bot):
  if .author.login != $bot then false
  else
    (.body | codex_without_help) as $body
    | if $body | startswith(codex_summary_marker) then
        codex_summary_status($bot) == "completed"
      else
        ($body | test("Didn.t find any major issues|usage limits have been reached|create a Codex account"))
        # codex_without_help removed at most one known heading; a second or
        # unknown heading must not hide finding-bearing text.
        or ($body | test("^Security review completed\\. No security issues were found in this pull request\\."
          + "\n+\\*\\*Reviewed commit:\\*\\* `[0-9a-f]{7,40}`"
          + "\n+\\[View security finding report\\]\\(https://chatgpt\\.com/codex/cloud/tasks/[A-Za-z0-9_-]+\\)"
          + "\n+_Only the user who started this review can view the report in Codex\\._$"))
      end
  end;
