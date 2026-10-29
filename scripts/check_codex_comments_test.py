"""Offline gate regressions: python3 scripts/check_codex_comments_test.py.

Run the real shell entrypoints with a fixture-only gh, including pagination and
cache refresh. No credentials, network calls, review requests, or polling sleeps.
"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FIXTURES = json.loads((SCRIPTS / "fixtures/codex_comments.json").read_text())
BOT = "chatgpt-codex-connector"
BEFORE = "2026-09-08T14:00:00Z"
REQUEST = "2026-09-08T15:00:00Z"
AFTER = "2026-09-08T16:00:00Z"
USAGE_LIMIT_NOTICES = (
    "Codex usage limits have been reached.",
    "You have reached your Codex usage limits for code reviews.",
    "You have reached your Codex usage limits for code reviews. You can see your limits in the "
    "[Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).\n"
    "To continue using code reviews, add credits to your account and enable them for code reviews "
    "in your [settings](https://chatgpt.com/codex/cloud/settings/code-review).",
)
# A PR head no fixture board was written for.
NEWER_HEAD = "b" * 40


def board_head(body):
    """The head Codex recorded in a summary board's metadata."""
    return re.search(r'"headSha":"([0-9a-f]{40})"', body).group(1)


def board_for(body, head):
    """The same board, re-recorded for another head."""
    return body.replace(board_head(body), head)


def comment(body, author=BOT, created_at=AFTER, minimized=False, association="MEMBER"):
    return {
        "id": "comment",
        "author": {"login": author},
        "authorAssociation": association,
        "body": body,
        "createdAt": created_at,
        "isMinimized": minimized,
    }


def thread(body, author=BOT, resolved=False, created_at=AFTER, discussion="1", commit=None):
    """`discussion` is the root comment ID that board links use (#discussion_r<id>).
    `commit` is the commit the root comment was written on."""
    root = comment(body, author, created_at)
    root["fullDatabaseId"] = discussion
    if commit is not None:
        root["originalCommit"] = {"oid": commit}
    return {
        "id": "thread",
        "isResolved": resolved,
        "comments": {"nodes": [root]},
    }


def connection(nodes, more=False):
    return {
        "nodes": nodes,
        "pageInfo": {"hasPreviousPage": more, "hasNextPage": False},
    }


def snapshot(comments=(), threads=(), reactions=(), more=False, head=None):
    # The PR head defaults to the head of the first board in the snapshot, so a
    # fixture board describes the current head unless a test says otherwise.
    if head is None:
        heads = [board_head(c["body"]) for c in comments if '"headSha"' in c["body"]]
        head = heads[0] if heads else "a" * 40
    return {
        "data": {
            "repository": {
                "pullRequest": {
                    "state": "OPEN",
                    "headRefOid": head,
                    "comments": connection(list(comments), more),
                    "reviewThreads": connection(list(threads), more),
                    "reactions": connection(list(reactions)),
                }
            }
        }
    }


class CodexGateTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="codex-comments-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        # A strict API double: reject unrecognized operations rather than falling
        # through to the host gh. One-node pages ensure every run tests pagination.
        gh = self.directory / "gh"
        gh.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
if args[:2] == ['pr', 'comment']:
    # The only write the scripts may make: a Codex review request (wait_pr_codex.sh).
    with open(os.environ['CODEX_GATE_POSTS'], 'a') as posts:
        posts.write(args[args.index('--body') + 1] + '\\0')
    sys.exit(0)
assert args[:2] == ['api', 'graphql'], args
query = next(arg[6:] for arg in args if arg.startswith('query='))
cursor = next((arg[7:] for arg in args if arg.startswith('cursor=')), 'null')
fixture_path = pathlib.Path(os.environ['CODEX_GATE_FIXTURE'])
fixture = json.loads(fixture_path.read_text())
with open(os.environ['CODEX_GATE_CALLS'], 'a') as calls:
    calls.write(query + '\\n')
# Each first-page comments fetch starts a new polling round.
round_path = fixture_path.with_suffix('.round')
round_index = int(round_path.read_text()) if round_path.exists() else 0
if 'comments(first: 100' in query and cursor == 'null':
    round_index += 1
    round_path.write_text(str(round_index))
if 'snapshots' in fixture:
    # Sequenced fixtures model Codex editing its summary between polls; the
    # last snapshot repeats once the sequence runs out.
    snapshot = fixture['snapshots'][min(max(round_index, 1), len(fixture['snapshots'])) - 1]
else:
    snapshot = fixture['snapshot']
if 'comments(last: 100)' in query:
    print(json.dumps(snapshot))
else:
    field = next(field for field in ['comments', 'reviewThreads', 'reactions']
                 if field + '(first: 100' in query)
    index = 0 if cursor == 'null' else int(cursor)
    nodes = snapshot['data']['repository']['pullRequest'][field]['nodes']
    more = index + 1 < len(nodes)
    pull_request = snapshot['data']['repository']['pullRequest']
    print(json.dumps({'data': {'repository': {'pullRequest': {
        'headRefOid': pull_request['headRefOid'],
        field: {
            'nodes': nodes[index:index + 1],
            'pageInfo': {'hasNextPage': more, 'endCursor': str(index + 1) if more else None}
        }
    }}}}))
""")
        gh.chmod(0o755)

    def run_gate(self, data, script="check_codex_comments.sh", cache=None, wait=None):
        """`data` is one snapshot, or a list of snapshots served round by round."""
        fixture = self.directory / "fixture.json"
        key = "snapshots" if isinstance(data, list) else "snapshot"
        fixture.write_text(json.dumps({key: data}))
        round_marker = fixture.with_suffix(".round")
        if round_marker.exists():
            round_marker.unlink()
        calls = self.directory / "calls"
        calls.write_text("")
        self.posts = self.directory / "posts"
        self.posts.write_text("")
        cache_file = self.directory / "cache.json"
        if cache is not None:
            cache_file.write_text(json.dumps(cache))
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("MUX_", "GH_", "GITHUB_"))
        }
        env.update(
            {
                "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
                "CODEX_GATE_FIXTURE": str(fixture),
                "CODEX_GATE_CALLS": str(calls),
                "CODEX_GATE_POSTS": str(self.posts),
                "MUX_GH_OWNER": "fixture",
                "MUX_GH_REPO": "fixture",
                "MUX_SKIP_FETCH_SYNC": "1",
                "MUX_PR_DATA_FILE": str(cache_file) if cache is not None else "",
                # Wait loops re-poll immediately so tests never sleep.
                "MUX_CODEX_WAIT_POLL_SECS": "0",
            }
        )
        args = ["bash", str(SCRIPTS / script), "4145"]
        if script == "wait_pr_codex.sh":
            args.append("--once")
        if wait is not None:
            args += ["--wait-for-review", str(wait)]
        result = subprocess.run(
            args, env=env, text=True, capture_output=True, timeout=15, check=False
        )
        self.assertTrue(
            calls.read_text(), "a cached verdict must still re-query GitHub"
        )
        # Polling rounds, not pages: the double serves one node per page.
        self.comment_rounds = int(round_marker.read_text()) if round_marker.exists() else 0
        return result

    def assert_gate(
        self, expected, data, script="check_codex_comments.sh", cache=None, wait=None
    ):
        result = self.run_gate(data, script, cache, wait)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_observed_comments_only_exempt_completed_informational_reviews(self):
        for name, fixture in FIXTURES.items():
            for cached in (False, True):
                with self.subTest(name=name, cached=cached):
                    data = snapshot([comment(fixture["body"])])
                    self.assert_gate(
                        fixture["expected_exit_code"],
                        data,
                        cache=data if cached else None,
                    )

    def test_security_headings_do_not_hide_findings(self):
        clean = FIXTURES["security_no_findings"]["body"]
        headers = (
            "### 🛡️ Codex Security Review\n\n",
            "### 🛡️ Codex Security Review · _Automatically triggered_\n\n",
        )
        for header in headers:
            for body, expected in (
                (clean, 0),
                (clean + "\n\n[P1] A security issue still needs fixing.", 1),
                ("Security review completed. Found a P1 credential disclosure.", 1),
                *((duplicate + clean, 1) for duplicate in headers),
            ):
                with self.subTest(header=header, body=body):
                    self.assert_gate(expected, snapshot([comment(header + body)]))

    def test_receipt_marker_does_not_hide_findings(self):
        # Since 2026-10-15 Codex prefixes verdicts with a receipt marker. Only one
        # leading marker is stripped; anything else around it stays blocking.
        receipt = "<!-- codex-review-receipt:v1 -->\n\n"
        clean = FIXTURES["receipt_security_no_findings"]["body"]
        for body, expected in (
            (clean, 0),
            (clean + "\n\n[P1] A security issue still needs fixing.", 1),
            (receipt + clean, 1),
            (clean.replace(receipt, receipt + "[P1] Found an issue.\n\n"), 1),
        ):
            with self.subTest(body=body):
                self.assert_gate(expected, snapshot([comment(body)]))

    def test_receipt_without_reviewed_commit_does_not_hide_findings(self):
        # Codex sometimes omits the Reviewed commit line (coder/xum#7302). That
        # line is optional, but text in its place or around the receipt blocks.
        clean = FIXTURES["receipt_security_no_findings_without_commit"]["body"]
        report = "\n\n[View security finding report]"
        for body, expected in (
            (clean, 0),
            (clean.replace(report, "\n\n[P1] Found an issue." + report), 1),
            (clean.replace(report, "\n\n**Reviewed commit:** `zzz`" + report), 1),
            (clean.replace("No security issues were found", "Found a P1 issue"), 1),
            (clean + "\n\n[P1] A security issue still needs fixing.", 1),
        ):
            with self.subTest(body=body):
                self.assert_gate(expected, snapshot([comment(body)]))

    def test_clean_code_review_receipt_does_not_hide_findings(self):
        # The clean verdict is one sentence, a one-line flourish and an optional
        # Reviewed commit line (coder/xum#7504). Text after it, a flourish that
        # carries a finding badge, or text before it blocks.
        clean = FIXTURES["code_review_no_findings"]["body"]
        flourish = "More of your lovely PRs please."
        help_start = "\n\n<details>"
        account = FIXTURES["account_setup_notice"]["body"]
        for body, expected in (
            (clean, 0),
            (clean.replace(help_start, "\n\n[P1] Fix authorization." + help_start, 1), 1),
            (clean.replace(flourish, "[P1] Fix authorization."), 1),
            (clean.replace(flourish, "![P1 Badge](https://img.shields.io/badge/P1-orange)"), 1),
            (clean.replace("Codex Review:", "[P1] Fix authorization.\n\nCodex Review:"), 1),
            (account + "\n\n[P1] Fix authorization.", 1),
        ):
            with self.subTest(body=body):
                self.assert_gate(expected, snapshot([comment(body)]))

    def test_review_state_line_is_fail_closed(self):
        # Codex added a review-state line to its board on 2026-10-15. Only the
        # observed keys and statuses count; has_any_findings stays true after
        # findings are resolved, so only has_unresolved_findings blocks.
        body = FIXTURES["review_state_summary"]["body"]
        head = board_head(body)
        state = re.search(r"<!-- codex-review-state:v1 .* -->\n", body).group(0)
        security = re.search(r"<!-- codex-security-review:v1 .* -->\n", body).group(0)
        unresolved = '"has_unresolved_findings":false'
        for case, changed, expected in (
            ("observed", body, 0),
            # Codex sends null while a review runs; a completed review must say false.
            ("completed, null findings", body.replace(unresolved, '"has_unresolved_findings":null', 1), 1),
            ("running, null findings", body.replace(
                unresolved + ',"status":"completed"}', '"has_unresolved_findings":null,"status":"running"}', 1), 10),
            ("code unresolved", body.replace(unresolved, '"has_unresolved_findings":true', 1), 1),
            ("security unresolved", body.replace(
                '"has_unresolved_findings":false,"status":"completed"}}',
                '"has_unresolved_findings":true,"status":"completed"}}'), 1),
            ("unknown review key", body.replace(
                '"status":"completed"},', '"status":"completed","blocking":false},'), 1),
            ("unknown top key", body.replace('}} -->', '},"merge_gate":{}} -->', 1), 1),
            ("missing key", body.replace('"has_any_findings":true,', "", 1), 1),
            ("unknown status", body.replace('"status":"completed"}', '"status":"failed"}', 1), 1),
            ("non-boolean findings", body.replace(unresolved, '"has_unresolved_findings":0', 1), 1),
            ("code running", body.replace('"status":"completed"}', '"status":"running"}', 1), 10),
            ("older commit", body.replace(head, "c" * 40, 1), 10),
            ("after security line", body.replace(state + security, security + state), 1),
            ("two state lines", body.replace(state, state + state), 1),
        ):
            for cached in (False, True):
                with self.subTest(case=case, cached=cached):
                    data = snapshot([comment(changed)], head=head)
                    self.assert_gate(expected, data, cache=data if cached else None)

    def test_null_security_flags_pass_only_with_a_clean_receipt_for_this_head(self):
        # Since 2026-10-28 Codex can finish a security review with null findings flags
        # (coder/xum#7727, observed on #7722). That is clean only beside a clean receipt
        # for the current head and with no open Codex thread; every other null blocks.
        board = FIXTURES["review_state_null_security_summary"]["body"]
        receipt = FIXTURES["receipt_security_no_findings_null_board"]["body"]
        head = board_head(board)
        older_receipt = receipt.replace("`" + head[:10] + "`", "`" + "c" * 10 + "`")
        self.assertNotEqual(older_receipt, receipt)
        code_marker = "\n\n<!-- codex-code-review-finding:v1 -->"
        open_thread = thread("[P2] Open" + code_marker, commit=head)
        advisory = board.replace(
            "\n\n\n\n<details>",
            "\n\n### Security findings\n\n#### Advisory findings (1)\n\n"
            "- 🟡 [Leak](https://github.com/coder/xum/pull/7722#discussion_r1) · **Medium**"
            "\n\n\n\n<details>",
            1,
        )
        self.assertNotEqual(advisory, board)
        running = board.replace(
            '"has_unresolved_findings":null,"status":"completed"}}',
            '"has_unresolved_findings":null,"status":"running"}}',
        ).replace('"status":"completed"} -->', '"status":"running"} -->')
        self.assertNotEqual(running, board)
        for case, comments, threads, pr_head, expected in (
            ("clean receipt for this head", [board, receipt], [], head, 0),
            # Pending, not failed: a push-triggered run posts no receipt (coder/xum#7731).
            ("no receipt", [board], [], head, 10),
            ("open Codex thread", [board, receipt], [open_thread], head, 1),
            ("receipt for an older head", [board, older_receipt], [], head, 10),
            # Unknown, not "older review in progress": null flags are clean only for this head.
            ("board and receipt for an older head", [board, receipt], [], NEWER_HEAD, 1),
            ("advisory section", [advisory, receipt], [], head, 1),
            ("merge gate on", [board.replace('"mergeGateEnabled":false', '"mergeGateEnabled":true'), receipt],
             [], head, 1),
            ("running, null findings", [running, receipt], [], head, 10),
        ):
            for cached in (False, True):
                with self.subTest(case=case, cached=cached):
                    data = snapshot([comment(body) for body in comments], threads, head=pr_head)
                    self.assert_gate(expected, data, cache=data if cached else None)
        with self.subTest("a minimized receipt does not count"):
            data = snapshot([comment(board), comment(receipt, minimized=True)], head=head)
            self.assert_gate(10, data)
        with self.subTest("the CI wait ends once the receipt lands"):
            pending = snapshot([comment(board)], head=head)
            self.assert_gate(0, [pending, snapshot([comment(board), comment(receipt)], head=head)], wait=60)
            self.assertEqual(self.comment_rounds, 2)
        with self.subTest("a finding still fails while the receipt is pending"):
            data = snapshot([comment(board)], [open_thread], head=head)
            self.assert_gate(1, data, wait=60)

    def test_missing_security_receipt_is_requested_once_per_head(self):
        board = FIXTURES["review_state_null_security_summary"]["body"]
        receipt = FIXTURES["receipt_security_no_findings_null_board"]["body"]
        head = board_head(board)
        review = comment("@codex review", "maintainer", BEFORE)
        posted = "@codex security review\n\nHead: " + head
        approval = comment("Codex Review: Didn't find any major issues. Nice work!", created_at=AFTER)
        for case, comments, posts, expected in (
            ("no request names the head", [review, comment(board)], 1, 10),
            # A request that names another head (an earlier push) does not count.
            ("request for an older head", [review, comment(posted.replace(head, "c" * 40), "maintainer"),
                                           comment(board)], 1, 10),
            ("request names the head", [review, comment(posted, "maintainer"), comment(board)], 0, 10),
            # Anyone can comment on a public PR: only a member's request counts.
            ("outsider's request names the head",
             [review, comment(posted, "outsider", association="NONE"), comment(board)], 1, 10),
            ("an approval does not end the wait", [review, comment(board), approval], 1, 10),
            ("receipt present", [review, comment(board), comment(receipt), approval], 0, 0),
            # No receipt will come after a usage-limit notice: fail, never pass the security half.
            ("usage limits after the head's request",
             [review, comment(posted, "maintainer", REQUEST), comment(board), comment(USAGE_LIMIT_NOTICES[0])], 0, 1),
            ("usage limits before the head's request",
             [review, comment(USAGE_LIMIT_NOTICES[0], created_at=BEFORE), comment(posted, "maintainer", REQUEST),
              comment(board)], 0, 10),
        ):
            with self.subTest(case=case):
                result = self.run_gate(snapshot(comments, head=head), "wait_pr_codex.sh")
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertEqual(self.posts.read_text().split("\0")[:-1], [posted] * posts)

    def test_resolved_codex_threads_clear_unresolved_review_state(self):
        # Codex keeps has_unresolved_findings true after its threads are resolved
        # until it reviews again (seen on coder/xum#6786), like advisory bullets
        # (coder/xum#5045). Only resolved Codex finding threads of the same review
        # kind on the reviewed commit clear it; other evidence proves nothing.
        clean = FIXTURES["review_state_summary"]["body"]
        head = board_head(clean)
        code = clean.replace('"has_unresolved_findings":false', '"has_unresolved_findings":true', 1)
        security = clean.replace(
            '"has_unresolved_findings":false,"status":"completed"}}',
            '"has_unresolved_findings":true,"status":"completed"}}',
        )
        code_marker = "\n\n<!-- codex-code-review-finding:v1 -->"
        security_marker = "<!-- codex-security-review-finding:v1 -->\n\n"
        fixed = thread("[P2] Fixed" + code_marker, resolved=True, commit=head)
        for case, body, threads, expected in (
            ("resolved code thread", code, [fixed], 0),
            ("unresolved Codex thread", code, [fixed, thread("[P2] Open" + code_marker, commit=head)], 1),
            ("unresolved human thread", code, [fixed, thread("Nit", "human-reviewer")], 0),
            ("thread on an older commit", code,
             [thread("[P2] Fixed" + code_marker, resolved=True, commit="c" * 40)], 1),
            ("thread without a commit", code, [thread("[P2] Fixed" + code_marker, resolved=True)], 1),
            ("thread without a marker", code, [thread("[P2] Fixed", resolved=True, commit=head)], 1),
            ("human thread with a marker", code,
             [thread("[P2] Fixed" + code_marker, "human-reviewer", resolved=True, commit=head)], 1),
            ("no threads", code, [], 1),
            ("security flag, code thread", security, [fixed], 1),
            ("security flag, security thread", security,
             [thread(security_marker + "[P2] Fixed", resolved=True, commit=head)], 0),
            # A marker counts only in its protocol position: code last, security first.
            ("security flag, code thread quoting its marker", security,
             [thread("[P2] Quotes " + security_marker + "Fixed" + code_marker, resolved=True, commit=head)], 1),
            ("code flag, security thread quoting its marker", code,
             [thread(security_marker + "[P2] Quotes " + code_marker + " here", resolved=True, commit=head)], 1),
            ("marker sharing its line", code,
             [thread("[P2] Fixed <!-- codex-code-review-finding:v1 -->", resolved=True, commit=head)], 1),
            ("thread with both markers", security,
             [thread(security_marker + "[P2] Fixed" + code_marker, resolved=True, commit=head)], 1),
        ):
            for cached in (False, True):
                with self.subTest(case=case, cached=cached):
                    data = snapshot([comment(body)], threads, head=head)
                    self.assert_gate(expected, data, cache=data if cached else None)

    def test_summary_completion_requires_metadata_and_every_review_row(self):
        completed = FIXTURES["summary"]["body"]
        completed_pr_opened = (
            FIXTURES["pr_opened_summary"]["body"]
            .replace('"status":"running"', '"status":"completed"')
            .replace("🔄 **Running** since", "✅ **Completed**")
        )
        completed_findings = (
            FIXTURES["security_findings_summary"]["body"]
            .replace('"status":"running"', '"status":"completed"')
            .replace("🔄 **Running** since", "✅ **Completed**")
        )
        # Codex keeps resolved advisories on the board; only its own Resolved marker,
        # not a bare bullet, an unknown section, or a non-thread link, is informational.
        resolved_findings = completed_findings.replace(
            ") · **Medium**", ") · **Medium** · **Resolved**"
        )
        for body, expected in (
            (completed.replace('"status":"completed"', '"status":"running"'), 10),
            (completed.replace("✅ **Completed**", "🔄 **Running** since", 1), 10),
            (completed_pr_opened, 0),
            (completed_findings, 1),
            (resolved_findings, 0),
            (resolved_findings.replace("#### Advisory findings", "#### Blocking findings"), 1),
            (resolved_findings.replace("#discussion_r3960253571", "#issuecomment-1"), 1),
            (resolved_findings.replace("· **Resolved**", "· **Resolved** see below"), 1),
        ):
            for cached in (False, True):
                with self.subTest(body=body, cached=cached):
                    data = snapshot([comment(body)])
                    self.assert_gate(expected, data, cache=data if cached else None)

    def test_resolved_advisory_threads_clear_their_board_bullets(self):
        # Codex can leave a bullet without its Resolved marker after the thread is
        # resolved and later reviews complete (coder/xum#5045).
        board = (
            FIXTURES["security_findings_summary"]["body"]
            .replace('"status":"running"', '"status":"completed"')
            .replace("🔄 **Running** since", "✅ **Completed**")
        )
        advisory = "3960253571"
        for threads, expected in (
            ([thread("[P2] Advisory", resolved=True, discussion=advisory)], 0),
            ([thread("[P2] Other", resolved=True, discussion="1")], 1),
            (
                [
                    thread(
                        "[P2] Advisory",
                        author="human-reviewer",
                        resolved=True,
                        discussion=advisory,
                    )
                ],
                1,
            ),
        ):
            for cached in (False, True):
                with self.subTest(threads=threads, cached=cached):
                    data = snapshot([comment(board)], threads)
                    self.assert_gate(expected, data, cache=data if cached else None)

    def test_wait_for_review_polls_until_codex_finishes(self):
        running = snapshot([comment(FIXTURES["running_summary"]["body"])])
        completed = snapshot([comment(FIXTURES["summary"]["body"])])
        in_progress = [name for name, fixture in FIXTURES.items() if fixture.get("in_progress")]
        self.assertIn("security_first_summary", in_progress)
        for name in in_progress:
            with self.subTest(name=name):
                data = [snapshot([comment(FIXTURES[name]["body"])]), completed]
                self.assert_gate(0, data, wait=60)
                self.assertEqual(self.comment_rounds, 2)
        with self.subTest("security-first board keeps waiting through a later poll"):
            security_first = snapshot([comment(FIXTURES["security_first_summary"]["body"])])
            self.assert_gate(0, [running, security_first, completed], wait=60)
            self.assertEqual(self.comment_rounds, 3)
        with self.subTest("cache is refreshed before waiting"):
            self.assert_gate(0, [running, completed], cache=running, wait=60)
            self.assertEqual(self.comment_rounds, 2)
        with self.subTest("without a budget the in-progress summary exits 10 at once"):
            result = self.assert_gate(10, [running, completed])
            self.assertEqual(self.comment_rounds, 1)
            self.assertIn("has not finished reviewing", result.stdout)

    def test_completed_board_counts_only_for_the_current_head(self):
        # Push B starts CI while the board still describes push A. Codex edits the
        # board in place once it reviews B; until then A's Completed board is not a
        # review of the current head and must never pass the gate for B.
        old_board = comment(FIXTURES["summary"]["body"])
        stale = snapshot([old_board], head=NEWER_HEAD)
        current = snapshot([comment(board_for(FIXTURES["summary"]["body"], NEWER_HEAD))])
        with self.subTest("a completed board for an older head is still in progress"):
            result = self.assert_gate(10, stale)
            self.assertIn("has not finished reviewing", result.stdout)
        with self.subTest("the wait ends once the board is re-recorded for this head"):
            self.assert_gate(0, [stale, current], wait=60)
            self.assertEqual(self.comment_rounds, 2)
        with self.subTest("a running board for an older head keeps waiting"):
            running_old = snapshot(
                [comment(FIXTURES["running_summary"]["body"])], head=NEWER_HEAD
            )
            self.assert_gate(0, [running_old, current], wait=60)
            self.assertEqual(self.comment_rounds, 2)
        with self.subTest("an older head never hides a finding"):
            finding = thread("[P1] Validate the caller before reading credentials")
            self.assert_gate(1, snapshot([old_board], [finding], head=NEWER_HEAD), wait=60)
            self.assertEqual(self.comment_rounds, 1)
        with self.subTest("the poller keeps waiting rather than reporting a missing approval"):
            request = comment("@codex review", "maintainer", REQUEST)
            self.assert_gate(10, snapshot([request, old_board], head=NEWER_HEAD), "wait_pr_codex.sh")

    def test_commitless_code_review_counts_beside_a_current_head_security_review(self):
        # coder/xum#7002: a code review that completed after a failed attempt lost its
        # commit. The security review on the same board still pins the head.
        board = FIXTURES["commitless_code_review_summary"]["body"]
        sha = board_head(board)
        commitless = '"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":"completed"'
        self.assertIn(commitless, board)
        with self.subTest("a security review of an older head keeps it in progress"):
            self.assert_gate(10, snapshot([comment(board)], head=NEWER_HEAD))
        for name, body in (
            (
                "a row without a commit needs a commitless review state",
                board.replace(
                    commitless,
                    f'"commit_sha":"{sha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"',
                ),
            ),
            (
                "only the code review may lose its commit",
                board.replace(f'"security_review":{{"commit_sha":"{sha}"', '"security_review":{"commit_sha":null'),
            ),
            (
                "a commitless review must not report findings",
                board.replace(commitless, commitless.replace('"has_any_findings":null', '"has_any_findings":true')),
            ),
            (
                "a commitless review must not report unresolved findings",
                board.replace(
                    commitless, commitless.replace('"has_unresolved_findings":null', '"has_unresolved_findings":true')
                ),
            ),
            (
                "a commitless review must have completed",
                board.replace(commitless, commitless.replace('"completed"', '"running"')),
            ),
        ):
            with self.subTest(name):
                self.assertNotEqual(body, board)
                self.assert_gate(1, snapshot([comment(body)]))
        with self.subTest("its findings are review threads, which still block"):
            self.assert_gate(1, snapshot([comment(board)], [thread("[P1] Fix authorization")]))

    def test_a_finished_review_supersedes_an_earlier_failure_notice(self):
        # coder/xum#7002: Codex posted a failure notice, then completed a retried review.
        notice = FIXTURES["review_failure"]["body"]
        failure = comment(notice)
        board = FIXTURES["commitless_code_review_summary"]["body"]
        for name in ("commitless_code_review_summary", "summary", "review_state_summary"):
            with self.subTest(board=name):
                self.assert_gate(0, snapshot([comment(FIXTURES[name]["body"]), failure]))
        # A running board, or a board of an older head, may still supersede it.
        running = snapshot([comment(FIXTURES["running_summary"]["body"]), failure])
        stale = snapshot([comment(board), failure], head=NEWER_HEAD)
        for name, waiting in (("a running board", running), ("a board for an older head", stale)):
            head = waiting["data"]["repository"]["pullRequest"]["headRefOid"]
            completed = snapshot([comment(board_for(FIXTURES["summary"]["body"], head)), failure])
            with self.subTest(name):
                self.assert_gate(10, waiting)
                self.assert_gate(0, [waiting, completed], wait=60)
                self.assertEqual(self.comment_rounds, 2)
        for name, data in (
            ("no board", snapshot([failure])),
            ("the failed attempt's board", snapshot([comment(FIXTURES["failed_code_review_summary"]["body"]), failure])),
            ("a minimized board", snapshot([comment(board, minimized=True), failure])),
            ("a finding beside the notice", snapshot([comment(board), failure, comment("[P1] Fix authorization")])),
            ("text appended to the notice", snapshot([comment(board), comment(notice + "\n\n[P1] Fix authorization")])),
        ):
            with self.subTest(name):
                self.assert_gate(1, data)

    def test_wait_for_review_gives_up_and_never_hides_findings(self):
        running = snapshot([comment(FIXTURES["running_summary"]["body"])])
        completed = snapshot([comment(FIXTURES["summary"]["body"])])
        with self.subTest("still running at the deadline"):
            # The loop's integer-second clock may expire before a second poll,
            # so only the give-up outcome is asserted here; polling is covered above.
            result = self.assert_gate(10, [running, running], wait=1)
            self.assertIn("still running after 1s", result.stdout)
        finding = thread("[P1] Validate the caller before reading credentials")
        completed_with_finding = snapshot(
            [comment(FIXTURES["summary"]["body"])], [finding]
        )
        with self.subTest("a finding posted during the wait blocks"):
            self.assert_gate(1, [running, completed_with_finding], wait=60)
        # Waiting cannot resolve a thread or clear another Codex comment, so the
        # gate must not hold the runner once either one exists.
        running_with_finding = snapshot(
            [comment(FIXTURES["running_summary"]["body"])], [finding]
        )
        with self.subTest("an unresolved thread skips the wait"):
            self.assert_gate(1, [running_with_finding, completed], wait=60)
            self.assertEqual(self.comment_rounds, 1)
        running_with_error = snapshot(
            [
                comment(FIXTURES["running_summary"]["body"]),
                comment("Codex Review: Something went wrong. Try again later by commenting “@codex review”."),
            ]
        )
        with self.subTest("another blocking comment skips the wait"):
            self.assert_gate(1, [running_with_error, completed], wait=60)
            self.assertEqual(self.comment_rounds, 1)
        with self.subTest("a finding posted during the wait ends it at once"):
            self.assert_gate(1, [running, running_with_finding, completed], wait=60)
            self.assertEqual(self.comment_rounds, 2)
        unknown = snapshot(
            [comment(FIXTURES["summary"]["body"].replace(
                '"status":"completed"', '"status":"findings_found"'
            ))]
        )
        with self.subTest("unknown statuses fail without waiting"):
            self.assert_gate(1, [unknown, completed_with_finding], wait=60)
            self.assertEqual(self.comment_rounds, 1)
        for extra in (["--wait-for-review"], ["--wait-for-review", "-5"], ["--wait-for-review", "soon"]):
            with self.subTest(extra=extra):
                # Argument errors exit before any GitHub query, so bypass run_gate.
                result = subprocess.run(
                    ["bash", str(SCRIPTS / "check_codex_comments.sh"), "4145", *extra],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("--wait-for-review requires", result.stderr)

    def test_real_findings_survive_metadata_and_pagination(self):
        summary = comment(FIXTURES["summary"]["body"])
        security = comment(
            "Security review completed. Found a P1 credential disclosure."
        )
        for comments, threads in (
            ([summary, security], []),
            (
                [summary],
                [thread("[P1] Validate the caller before reading credentials")],
            ),
            ([summary], [thread(FIXTURES["summary"]["body"])]),
        ):
            with self.subTest(comments=comments, threads=threads):
                self.assert_gate(1, snapshot(comments, threads))

    def test_unknown_or_finding_bearing_summaries_still_block(self):
        body = FIXTURES["summary"]["body"]
        for changed in (
            body + "\n\n[P1] A security issue still needs fixing.",
            body + "\n\n<details>\n[P1] Security findings\n</details>",
            body.replace("</details>", "[P1] A finding inside the footer.\n</details>"),
            body.replace(
                '"status":"completed"',
                '"status":"completed","findings":[{"severity":"P1"}]',
            ),
            body.replace('"status":"completed"', '"status":"findings_found"'),
            body.replace('"status":"completed"', "not valid JSON"),
            body.replace('"mergeGateEnabled":false', '"mergeGateEnabled":true'),
            body.replace("codex-security-review:v1", "codex-security-review:v2"),
            body.replace("codex-security-review:v1", "unknown-metadata"),
            "The review incorrectly says " + FIXTURES["security_no_findings"]["body"],
            FIXTURES["security_no_findings"]["body"]
            + "\n[P1] But the code review found a bug.",
            FIXTURES["security_no_findings_titled"]["body"].replace(
                "No security issues were found in this pull request.",
                "Found a P1 credential disclosure.",
            ),
            FIXTURES["security_no_findings_titled"]["body"].replace(
                "Automatically triggered", "[P1] A finding in the heading"
            ),
            FIXTURES["security_no_findings"]["body"].replace(
                "</details>", "[P1] A finding inside the footer.\n</details>"
            ),
        ):
            with self.subTest(body=changed):
                self.assert_gate(1, snapshot([comment(changed)]))

    def test_cached_verdict_never_hides_new_or_resolved_findings(self):
        clean = snapshot([comment(FIXTURES["summary"]["body"])])
        finding = snapshot([comment("[P1] Fix authorization")])
        for more in (False, True):
            with self.subTest(more=more):
                cached = snapshot(
                    clean["data"]["repository"]["pullRequest"]["comments"]["nodes"],
                    more=more,
                )
                self.assert_gate(1, finding, cache=cached)
                self.assert_gate(0, clean, cache=finding)

    def test_minimized_findings_and_resolved_threads_remain_nonblocking(self):
        self.assert_gate(
            0,
            snapshot(
                [comment("[P1] Fixed", minimized=True)],
                [thread("[P1] Fixed", resolved=True)],
            ),
        )

    def test_other_reviewers_threads_cannot_use_codex_markers_to_bypass_review_gate(
        self,
    ):
        for author in ("human-reviewer", "coder-agents-review", BOT):
            with self.subTest(author=author):
                self.assert_gate(
                    1,
                    snapshot(threads=[thread(FIXTURES["summary"]["body"], author)]),
                    script="check_pr_reviews.sh",
                )

    def test_metadata_is_not_approval(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for name, fixture in FIXTURES.items():
            with self.subTest(name=name):
                result = self.run_gate(
                    snapshot([request, comment(fixture["body"])]), "wait_pr_codex.sh"
                )
                # Completed informational envelopes and in-progress summaries keep
                # polling for approval; unknown reports remain failures under the CI policy.
                # A fixture can name its own readiness result: the clean code-review
                # receipt is approval, and the account notice is a failed review.
                expected = fixture.get(
                    "wait_exit_code", 10 if fixture["expected_exit_code"] in (0, 10) else 1
                )
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_in_progress_review_fails_fast_on_older_blockers(self):
        request = comment("@codex review", "maintainer", REQUEST)
        older = thread("[P1] Fix authorization", created_at=BEFORE)
        # The poller only sees the last 100 comments; the board may be older than
        # that. The gate paginates everything, so it must run even when no Codex
        # comment is visible at all.
        with self.subTest("no visible Codex comment, unresolved older thread"):
            result = self.assert_gate(1, snapshot([request], [older]), "wait_pr_codex.sh")
            self.assertIn("1 unresolved review thread", result.stdout)
        with self.subTest("no visible Codex comment, resolved older thread"):
            resolved = thread("[P1] Fixed", resolved=True, created_at=BEFORE)
            self.assert_gate(10, snapshot([request], [resolved]), "wait_pr_codex.sh")
        # Codex creates the summary board once and edits it in place, so on a
        # re-review the running board predates the request.
        for board_at in (BEFORE, AFTER):
            running = comment(FIXTURES["running_summary"]["body"], created_at=board_at)
            with self.subTest(board_at=board_at, thread="unresolved before the request"):
                result = self.assert_gate(1, snapshot([request, running], [older]), "wait_pr_codex.sh")
                self.assertIn("1 unresolved review thread", result.stdout)
            for resolved_at in (BEFORE, AFTER):
                with self.subTest(board_at=board_at, thread=f"resolved at {resolved_at}"):
                    resolved = thread("[P1] Fixed", resolved=True, created_at=resolved_at)
                    self.assert_gate(10, snapshot([request, running], [resolved]), "wait_pr_codex.sh")

    def test_informational_comments_do_not_hide_findings_or_account_errors(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for name in ("summary", "security_no_findings", "security_no_findings_titled"):
            comments = [request, comment(FIXTURES[name]["body"])]
            for extra_comments, threads in (
                ([comment("[P1] Fix authorization")], []),
                ([], [thread("[P1] Fix authorization")]),
                ([comment("Please create a Codex account to review.")], []),
            ):
                with self.subTest(name=name, comments=extra_comments, threads=threads):
                    self.assert_gate(
                        1, snapshot(comments + extra_comments, threads), "wait_pr_codex.sh"
                    )

    def test_usage_limits_pass_ci_and_readiness_without_claiming_approval(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for notice in USAGE_LIMIT_NOTICES:
            data = snapshot([request, comment(notice)])
            with self.subTest(notice=notice):
                self.assert_gate(0, data, wait=1)
                result = self.assert_gate(0, data, "wait_pr_codex.sh")
                self.assertIn("review skipped", result.stdout)
                self.assertNotIn("Codex approved", result.stdout)

    def test_usage_limits_do_not_hide_findings_or_other_review_failures(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for notice in USAGE_LIMIT_NOTICES:
            for extra_comments, threads in (
                ([comment("[P1] Fix authorization")], []),
                ([], [thread("[P1] Fix authorization", created_at=BEFORE)]),
                ([comment("Codex Review: Something went wrong.")], []),
                ([comment(notice + "\n\n[P1] Fix authorization")], []),
                ([comment("The error was: " + notice)], []),
            ):
                data = snapshot([request, comment(notice)] + extra_comments, threads, more=True)
                for script in ("check_codex_comments.sh", "wait_pr_codex.sh"):
                    with self.subTest(notice=notice, script=script, extra=extra_comments, threads=threads):
                        self.assert_gate(1, data, script)
        # Account setup errors remain failures even though CI treats them as informational.
        self.assert_gate(
            1,
            snapshot([request, comment(USAGE_LIMIT_NOTICES[0]), comment("Please create a Codex account to review.")]),
            "wait_pr_codex.sh",
        )

    def test_usage_limit_skip_requires_a_fresh_unminimized_bot_notice(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for notice in USAGE_LIMIT_NOTICES:
            for author, created_at, minimized in (
                (BOT, BEFORE, False),
                ("human-reviewer", AFTER, False),
                (BOT + "-impostor", AFTER, False),
                (BOT, AFTER, True),
            ):
                with self.subTest(notice=notice, author=author, created_at=created_at, minimized=minimized):
                    self.assert_gate(
                        10,
                        snapshot([request, comment(notice, author, created_at, minimized)]),
                        "wait_pr_codex.sh",
                    )

    def test_usage_limits_still_wait_for_running_reviews(self):
        request = comment("@codex review", "maintainer", REQUEST)
        self.assert_gate(
            10,
            snapshot([request, comment(USAGE_LIMIT_NOTICES[0]), comment(FIXTURES["running_summary"]["body"])]),
            "wait_pr_codex.sh",
        )

    def test_only_authenticated_codex_authors_get_protocol_exemptions(self):
        comments = [
            comment(FIXTURES["summary"]["body"], author)
            for author in (
                BOT,
                "human-reviewer",
                "coder-agents-review",
                "chatgpt-codex-connector-impostor",
            )
        ]
        result = subprocess.run(
            [
                "jq",
                "-L",
                str(SCRIPTS / "lib"),
                'include "codex_comments"; [.[] | codex_comment_is_informational("'
                + BOT
                + '"; "'
                + board_head(FIXTURES["summary"]["body"])
                + '"; []; {code_review: [], security_review: []})]',
            ],
            input=json.dumps(comments),
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout), [True, False, False, False])

    def test_approval_requires_the_real_bot_and_fresh_signal(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for author, created_at, expected in (
            (BOT, BEFORE, 10),
            ("human-reviewer", AFTER, 10),
            (BOT, AFTER, 0),
            # GitHub's GraphQL returns the reacting bot's User login with the
            # [bot] suffix (comment authors come back without it).
            (BOT + "[bot]", AFTER, 0),
            (BOT + "[bot]", BEFORE, 10),
            (BOT + "-impostor[bot]", AFTER, 10),
        ):
            with self.subTest(author=author, created_at=created_at):
                data = snapshot(
                    [request, comment(FIXTURES["summary"]["body"])],
                    reactions=[
                        {
                            "user": {"login": author},
                            "createdAt": created_at,
                        }
                    ],
                )
                self.assert_gate(expected, data, "wait_pr_codex.sh")


if __name__ == "__main__":
    unittest.main()
