# Codex now edits a protocol status comment alongside its actionable findings.
# Only recognize completed informational envelopes; extra text/metadata may
# carry findings, so unknown shapes stay blocking. This never supplies approval.
# Strip only the observed help text: a heading alone must not hide a finding
# added inside the details section, or a second section appended after it.
def codex_without_help:
  # Since 2026-10-15 Codex starts verdicts with one receipt marker. Strip only
  # one, before the heading, so a second marker still blocks.
  sub("^<!-- codex-review-receipt:v1 -->\n\n"; "")
  | sub("^### 🛡️ Codex Security Review( · _Automatically triggered_)?\n\n"; "")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n"
    + "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n"
    + "- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\" or \"@codex security review\".\n\n"
    + "Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex security reviews in GitHub</summary>\n<br/>\n\n"
    + "This is an experimental Codex feature. Security reviews are triggered when:\n- You comment \"@codex security review\"\n"
    + "- A regular code review gets triggered (for example, \"@codex review\" or when a PR is opened), and you’re opted in so security review runs alongside code review\n\n"
    + "Once complete, Codex will leave suggestions, or a comment if no findings are found.\n\n\n</details>")
  # Codex's review failure notice (coder/xum#7002) still carries the older help text.
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n"
    + "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n"
    + "- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\".\n\n"
    + "If Codex has suggestions, it will comment; otherwise it will react with 👍.\n\n\n\n\n"
    + "Codex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".\n            \n</details>");

def codex_summary_marker: "<!-- codex-pull-request-review-summary -->";

# The clean security-review receipt (after codex_without_help). Codex sometimes omits the
# Reviewed commit line (coder/xum#7302). The rest is fixed text that reports no finding.
def codex_clean_security_receipt:
  "^Security review completed\\. No security issues were found in this pull request\\."
  + "(\n+\\*\\*Reviewed commit:\\*\\* `(?<commit>[0-9a-f]{7,40})`)?"
  + "\n+\\[View security finding report\\]\\(https://chatgpt\\.com/codex/cloud/tasks/[A-Za-z0-9_-]+\\)"
  + "\n+_Only the user who started this review can view the report in Codex\\._$";

# Input: PR comment nodes. Output: whether an unminimized Codex receipt says the security review
# of $head found no issues. Only a receipt that names its reviewed commit counts.
def codex_clean_security_receipt_for($bot; $head):
  any(.[]; .author.login == $bot and .isMinimized == false
    and ([.body | codex_without_help | capture(codex_clean_security_receipt) | .commit // empty]
      | any(. as $commit | $head | startswith($commit))));

# Input: PR comment nodes. Output: whether Codex finished a security review of $head with null
# findings flags and no clean receipt for $head exists yet (see codex_summary_status).
def codex_security_receipt_missing($bot; $head):
  ([.[] | select(.author.login == $bot and .isMinimized == false)
    | .body | select(startswith(codex_summary_marker))
    | first(capture("<!-- codex-review-state:v1 (?<p>.*) -->").p | fromjson? | .security_review)
    | select(.commit_sha == $head and .status == "completed"
        and .has_unresolved_findings == null and .has_any_findings == null)] | length > 0)
  and (codex_clean_security_receipt_for($bot; $head) | not);

# Input: PR comment nodes. Output: whether a repository member already asked for a Codex
# security review of $head. wait_pr_codex.sh names the head in each request it posts. Other
# authors do not count: anyone can comment on a public PR, and Codex may ignore them.
def codex_security_review_requested_for($bot; $head):
  any(.[]; .author.login != $bot and (.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
    and (.body | contains("@codex security review") and contains($head)));

# Input: review thread nodes. Output: the root comment IDs of resolved Codex
# threads, the IDs that board advisory links use (#discussion_r<id>).
def codex_resolved_discussions($bot):
  [.[] | select(.isResolved == true and .comments.nodes[0].author.login == $bot)
    | .comments.nodes[0].fullDatabaseId // empty];

# Input: review thread nodes. Output: per review-state entry, the commits on
# which Codex has finding threads of that review kind and all are resolved.
# Threads without a known marker or commit, and other reviewers', never count.
# security_discussions: the root comment IDs of resolved Codex security finding threads.
def codex_resolved_finding_commits($bot):
  [.[] | select(.comments.nodes[0].author.login == $bot)] as $codex
  # A marker counts only in its protocol position: security as the first line,
  # code as the last non-empty line. A body with both is neither, because
  # findings can quote marker literals.
  | def finding_kind:
      (split("\n") | map(rtrimstr("\r"))) as $body_lines
      | ($body_lines[0] == "<!-- codex-security-review-finding:v1 -->") as $security
      | (($body_lines | map(select(test("\\S"))) | last) == "<!-- codex-code-review-finding:v1 -->") as $code
      | if $code == $security then null
        elif $code then "code_review" else "security_review" end;
    def cleared($kind):
      [$codex[] | select(.comments.nodes[0].body | finding_kind == $kind)
        | {commit: .comments.nodes[0].originalCommit.oid, resolved: (.isResolved == true)}
        | select(.commit | type == "string")]
      | group_by(.commit) | map(select(all(.resolved)) | .[0].commit);
    {code_review: cleared("code_review"), security_review: cleared("security_review"),
      security_discussions: [$codex[] | select(.isResolved == true
          and (.comments.nodes[0].body | finding_kind == "security_review"))
        | .comments.nodes[0].fullDatabaseId // empty]};

def codex_review_row_prefix: "^\\| [^[:alnum:]|]*\\*\\*(Code|Security) Review\\*\\* \\| [^[:alnum:]|]*\\*\\*";
def codex_review_triggers: "(Manual request|New commits|Draft marked ready|PR opened)";
def codex_review_row_suffix: " \\| `[0-9a-f]+` \\| " + codex_review_triggers + " \\|$";
def codex_relative_time: "<relative-time datetime=\"[0-9TZ:.+-]+\">[0-9TZ:.+-]+</relative-time>";
def codex_completed_row: codex_review_row_prefix + "Completed\\*\\*( " + codex_relative_time + ")?" + codex_review_row_suffix;
def codex_running_row: codex_review_row_prefix + "Running\\*\\* since " + codex_relative_time + codex_review_row_suffix;
# A code review that completes after a failed attempt loses its commit (coder/xum#7002): the row
# shows "—", and the review state a null commit_sha and null findings flags.
def codex_commitless_code_review_row:
  "^\\| [^[:alnum:]|]*\\*\\*Code Review\\*\\* \\| [^[:alnum:]|]*\\*\\*Completed\\*\\*( " + codex_relative_time + ")?"
  + " \\| — \\| " + codex_review_triggers + " \\|$";

# The board's fixed lines and review rows, which come before any findings section.
def codex_board_head_line:
  . == "## Codex Review Summary"
  or . == "This comment shows the latest Codex review activity on this pull request."
  or . == "| Review | Status | Commit | Review trigger |"
  or . == "| --- | --- | --- | --- |"
  or test(codex_completed_row)
  or test(codex_running_row);

def codex_advisory_header: capture("^#### Advisory findings \\((?<n>[0-9]+)\\)$").n | tonumber;

# Whether a board line is an advisory bullet with Codex's Resolved marker or a link to one of $ids.
# capture() yields empty on a mismatch, so `// false` keeps an unknown line blocking.
def codex_cleared_advisory_bullet($ids):
  (first(capture("^- [^[:alnum:]|\\[]*\\[[^\\]]+\\]\\(https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+#discussion_r(?<id>[0-9]+)\\)"
    + " · \\*\\*[A-Za-z]+\\*\\*(?<marker> · \\*\\*Resolved\\*\\*)?$"))
    | .marker != null or (.id | IN($ids[]))) // false;

# Input: the board lines after its head lines. Output: whether they are empty or a cleared
# advisory inventory: one "### Security findings", then advisory headers, each followed by
# exactly as many bullets as it declares, every bullet cleared by $ids, and nothing else.
def codex_cleared_advisory_inventory($ids):
  length == 0
  or (.[0] == "### Security findings" and (.[1:] as $rest
    | ($rest | length > 0) and ($rest[0] | [codex_advisory_header] | length == 1)
    and ($rest | all(([codex_advisory_header] | length == 1) or codex_cleared_advisory_bullet($ids)))
    and ([range($rest | length) as $i | $rest[$i] | codex_advisory_header
      | . == (($rest[($i + 1):] | map([codex_advisory_header] | length == 1) | index(true))
        // ($rest | length - $i - 1))] | all)));

# Parse the review summary board Codex edits in place. Emit "completed" or
# "running" only when every line has an observed informational shape; emit null
# for anything else so unknown content stays blocking. The metadata status tracks
# the security review alone (observed on coder/mux#4271: "completed" while the
# Code Review row still read Running), so a Running row also means "running".
# $head is the PR's current head commit. Codex records the reviewed head in the
# board's metadata; a Completed board for another head is a review of an older
# push, not of this one. Codex re-reviews on new commits and edits the board in
# place, so that state is "running" for the current head, never "completed".
# $resolved is the output of codex_resolved_discussions, and $cleared the
# output of codex_resolved_finding_commits.
def codex_summary_status($bot; $head; $resolved; $cleared):
  if .author.login != $bot then null
  else
    (.body | codex_without_help) as $body
    | if $body | startswith(codex_summary_marker) then
        (try (
          ($body | split("\n") | map(select(length > 0))) as $all
          # Since 2026-10-15 Codex may add a review-state line before the security line.
          | (if $all[1] | startswith("<!-- codex-review-state:v1 ")
              then [($all[1] | capture("^<!-- codex-review-state:v1 (?<payload>.*) -->$").payload | fromjson)]
              else [] end) as $state
          | ([$all[0]] + $all[(1 + ($state | length)):]) as $lines
          | ($lines[1] | capture("^<!-- codex-security-review:v1 (?<payload>.*) -->$").payload | fromjson) as $security
          | ([$state[] | .code_review, .security_review]) as $reviews
          # Since 2026-10-28 Codex can finish a security review with null findings flags
          # (coder/xum#7727). That counts as clean only for the current head, beside a
          # completed security line with the merge gate off, a clean receipt for this head
          # and no open Codex thread ($cleared.clean_security_receipt, set by
          # check_codex_comments.sh). Any other null stays unknown, so it blocks.
          # Codex keeps listing an advisory after its thread is resolved (#7859). With null
          # flags the bullets are the only finding list, so the board must end in a complete
          # inventory (codex_cleared_advisory_inventory) whose bullets each name a resolved
          # security finding thread. Any other shape stays unknown.
          | ($security.status == "completed" and $security.headSha == $head
            and $security.mergeGateEnabled == false
            and ($lines[2:]
              | .[(map(codex_board_head_line or test(codex_commitless_code_review_row) | not) | index(true)) // length:]
              | codex_cleared_advisory_inventory($cleared.security_discussions // [])))
            as $null_security_base
          # Runs triggered by a push post no receipt (coder/xum#7731): until a Codex security
          # review request brings one, such a board is pending, so wait budgets cover it.
          | ($state | any(.security_review | .status == "completed"
              and .has_unresolved_findings == null and .has_any_findings == null)) as $null_security
          | if $lines[0] == codex_summary_marker
            # Unknown state fields or statuses could be findings. has_any_findings
            # stays true after findings are resolved, so it is not used.
            and ($state | all(type == "object" and (keys == ["code_review", "security_review"])))
            and ($state | all(to_entries | all(
              .key as $kind | .value
              | type == "object"
              and keys == ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"]
              and (.has_any_findings | type == "boolean" or type == "null")
              and (.status == "completed" or .status == "running")
              and (((.commit_sha | type == "string" and test("^[0-9a-f]{40}$"))
                # Codex sends null only while a review runs; a completed one must say false.
                and (.has_unresolved_findings == false
                  or (.has_unresolved_findings == null and .status == "running")
                  or ($kind == "security_review" and $null_security_base and .commit_sha == $head
                    and .status == "completed" and .has_unresolved_findings == null
                    and .has_any_findings == null)
                  # Since 2026-10-29 a finished code review can also say null (coder/xum#7734). Its
                  # findings are Codex threads and finding comments, which block on their own.
                  or ($kind == "code_review" and .commit_sha == $head and .status == "completed"
                    and .has_unresolved_findings == null)
                  # Codex keeps true after its threads are resolved, until it reviews
                  # again (coder/xum#6786). Codex posts its threads before it updates
                  # the board, so this review's resolved threads clear it.
                  or (.has_unresolved_findings == true and (.commit_sha | IN($cleared[$kind][])))))
                # A commitless code review (codex_commitless_code_review_row) has no
                # findings flags. Its findings are review threads, which the gate
                # checks on their own.
                or ($kind == "code_review" and .commit_sha == null and .has_any_findings == null
                  and .has_unresolved_findings == null and .status == "completed")))))
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
              codex_board_head_line
              or (test(codex_commitless_code_review_row) and ($state | any(.code_review.commit_sha == null)))
              # Security advisories stay listed after their review threads are resolved.
              # Codex's Resolved marker can lag or never appear (coder/xum#5045), so a
              # resolved linked thread also clears its bullet. A bullet with neither is a
              # live finding and keeps blocking; other sections stay unknown.
              or . == "### Security findings"
              or test("^#### Advisory findings \\([0-9]+\\)$")
              or codex_cleared_advisory_bullet($resolved)
            ))
            # A commitless code review counts for the head of the security review beside
            # it, which must be the current head: Codex starts both reviews together on
            # each push or request, so an older push's code review cannot sit next to it.
            then (if $security.status == "running" or ($lines[2:] | any(test(codex_running_row)))
                     or ($null_security and $cleared.clean_security_receipt != true)
                     or $security.headSha != $head
                     or ($reviews | any(.status == "running" or (.commit_sha // $head) != $head))
                  then "running" else "completed" end)
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
def codex_review_in_progress($bot; $head; $resolved; $cleared):
  codex_summary_status($bot; $head; $resolved; $cleared) == "running";

# Quota exhaustion is not a code finding. Recognize only the bot's known notices
# so CI can pass when review credits run out, without hiding appended findings.
def codex_usage_limit($bot):
  .author.login == $bot and (
    (.body | gsub("\r\n"; "\n") | sub("[[:space:]]+$"; "")) as $body
    | "You have reached your Codex usage limits for code reviews." as $notice
    | $body == "Codex usage limits have been reached."
      or $body == $notice
      or $body == ($notice
        + " You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).\n"
        + "To continue using code reviews, add credits to your account and enable them for code reviews in your [settings](https://chatgpt.com/codex/cloud/settings/code-review).")
  );

def codex_comment_is_informational($bot; $head; $resolved; $cleared):
  if .author.login != $bot then false
  else
    (.body | codex_without_help) as $body
    | if $body | startswith(codex_summary_marker) then
        codex_summary_status($bot; $head; $resolved; $cleared) == "completed"
      else
        codex_usage_limit($bot)
        # The clean code-review receipt: one fixed sentence, one free-text
        # flourish line ("Nice work!", ":+1:"; Codex varies it), and an optional
        # Reviewed commit line. Anchored so text after it blocks (coder/xum#7504).
        # Codex findings carry a priority badge, so a flourish with a [P0]-[P3]
        # tag, badge text, or a markdown link or image blocks too.
        or ($body | test("^Codex Review: Didn[’']t find any major issues\\."
          + "( (?![^\n]*(\\[P[0-3]\\]|P[0-3] Badge|!\\[|\\]\\())[^\n]{1,80})?"
          + "(\n\n\\*\\*Reviewed commit:\\*\\* `[0-9a-f]{7,40}`)?$"))
        # Codex's account setup notice reports no finding; wait_pr_codex.sh
        # still counts it as a failed review.
        or $body == "To use Codex here, [create a Codex account and connect to github](https://chatgpt.com/codex/cloud/settings/connectors)."
        # codex_without_help removed at most one known heading; a second or
        # unknown heading must not hide finding-bearing text.
        or ($body | test(codex_clean_security_receipt))
      end
  end;

# Codex's notice that a review attempt failed (coder/xum#7002).
def codex_review_failure($bot):
  .author.login == $bot
  and (.body | codex_without_help
    | test("^Codex Review: Something went wrong\\. Try again later by commenting “@codex review”\\.\n\n```\n[^`\n]+\n```$"));

# Input: PR comment nodes. Output: the Codex comments that block the gate.
# A failed review attempt blocks until Codex finishes a review: Codex edits its board in place,
# so a completed board for the current head means a later attempt succeeded. Without one (no
# board, a failed or running review, another head) the failure notice still blocks.
def codex_blocking_comments($bot; $head; $resolved; $cleared):
  any(.[]; .isMinimized == false and codex_summary_status($bot; $head; $resolved; $cleared) == "completed") as $reviewed
  | [.[]
    | select(.author.login == $bot and .isMinimized == false)
    | select(codex_comment_is_informational($bot; $head; $resolved; $cleared) | not)
    | select(($reviewed and codex_review_failure($bot)) | not)];

# Input: codex_blocking_comments output. Output: how many of them waiting may clear: running
# boards, and failure notices while a board runs, because a review that completes supersedes them.
def codex_pending_count($bot; $head; $resolved; $cleared):
  any(.[]; codex_review_in_progress($bot; $head; $resolved; $cleared)) as $running
  | [.[] | select(codex_review_in_progress($bot; $head; $resolved; $cleared) or ($running and codex_review_failure($bot)))]
  | length;
