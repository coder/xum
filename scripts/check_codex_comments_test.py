"""Offline gate regressions: python3 scripts/check_codex_comments_test.py.

Run the real shell entrypoints with a fixture-only gh, including pagination and
cache refresh. No credentials, network calls, review requests, or polling sleeps.
"""

import json
import os
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


def comment(body, author=BOT, created_at=AFTER, minimized=False):
    return {
        "id": "comment",
        "author": {"login": author},
        "body": body,
        "createdAt": created_at,
        "isMinimized": minimized,
    }


def thread(body, author=BOT, resolved=False):
    return {
        "id": "thread",
        "isResolved": resolved,
        "comments": {"nodes": [comment(body, author)]},
    }


def connection(nodes, more=False):
    return {
        "nodes": nodes,
        "pageInfo": {"hasPreviousPage": more, "hasNextPage": False},
    }


def snapshot(comments=(), threads=(), reactions=(), more=False):
    return {
        "data": {
            "repository": {
                "pullRequest": {
                    "state": "OPEN",
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
assert args[:2] == ['api', 'graphql'], args
query = next(arg[6:] for arg in args if arg.startswith('query='))
cursor = next((arg[7:] for arg in args if arg.startswith('cursor=')), 'null')
fixture_path = pathlib.Path(os.environ['CODEX_GATE_FIXTURE'])
fixture = json.loads(fixture_path.read_text())
with open(os.environ['CODEX_GATE_CALLS'], 'a') as calls:
    calls.write(query + '\\n')
if 'snapshots' in fixture:
    # Sequenced fixtures model Codex editing its summary between polls. Each
    # first-page comments fetch starts a new round; the last snapshot then repeats.
    round_path = fixture_path.with_suffix('.round')
    round_index = int(round_path.read_text()) if round_path.exists() else 0
    if 'comments(first: 100' in query and cursor == 'null':
        round_index += 1
        round_path.write_text(str(round_index))
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
    print(json.dumps({'data': {'repository': {'pullRequest': {field: {
        'nodes': nodes[index:index + 1],
        'pageInfo': {'hasNextPage': more, 'endCursor': str(index + 1) if more else None}
    }}}}}))
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
        # One-comment snapshots make every comments query a new polling round.
        self.comment_fetches = calls.read_text().count("comments(first: 100")
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
            (completed.replace('"status":"completed"', '"status":"running"'), 1),
            (completed.replace("✅ **Completed**", "🔄 **Running** since", 1), 1),
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

    def test_wait_for_review_polls_until_codex_finishes(self):
        running = snapshot([comment(FIXTURES["running_summary"]["body"])])
        completed = snapshot([comment(FIXTURES["summary"]["body"])])
        in_progress = [name for name, fixture in FIXTURES.items() if fixture.get("in_progress")]
        self.assertIn("security_first_summary", in_progress)
        for name in in_progress:
            with self.subTest(name=name):
                data = [snapshot([comment(FIXTURES[name]["body"])]), completed]
                self.assert_gate(0, data, wait=60)
                self.assertEqual(self.comment_fetches, 2)
        with self.subTest("security-first board keeps waiting through a later poll"):
            security_first = snapshot([comment(FIXTURES["security_first_summary"]["body"])])
            self.assert_gate(0, [running, security_first, completed], wait=60)
            self.assertEqual(self.comment_fetches, 3)
        with self.subTest("cache is refreshed before waiting"):
            self.assert_gate(0, [running, completed], cache=running, wait=60)
            self.assertEqual(self.comment_fetches, 2)
        with self.subTest("without a budget the in-progress summary fails at once"):
            result = self.assert_gate(1, [running, completed])
            self.assertEqual(self.comment_fetches, 1)
            self.assertIn("has not finished reviewing", result.stdout)

    def test_wait_for_review_gives_up_and_never_hides_findings(self):
        running = snapshot([comment(FIXTURES["running_summary"]["body"])])
        with self.subTest("still running at the deadline"):
            result = self.assert_gate(1, [running, running], wait=1)
            self.assertGreater(self.comment_fetches, 1)
            self.assertIn("still running after 1s", result.stdout)
        finding = thread("[P1] Validate the caller before reading credentials")
        completed_with_finding = snapshot(
            [comment(FIXTURES["summary"]["body"])], [finding]
        )
        with self.subTest("a finding posted during the wait blocks"):
            self.assert_gate(1, [running, completed_with_finding], wait=60)
        unknown = snapshot(
            [comment(FIXTURES["summary"]["body"].replace(
                '"status":"completed"', '"status":"findings_found"'
            ))]
        )
        with self.subTest("unknown statuses fail without waiting"):
            self.assert_gate(1, [unknown, completed_with_finding], wait=60)
            self.assertEqual(self.comment_fetches, 1)
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
                waiting = fixture["expected_exit_code"] == 0 or fixture.get("in_progress")
                expected = 10 if waiting else 1
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_informational_comments_do_not_hide_findings_or_account_errors(self):
        request = comment("@codex review", "maintainer", REQUEST)
        for name in ("summary", "security_no_findings", "security_no_findings_titled"):
            comments = [request, comment(FIXTURES[name]["body"])]
            for extra_comments, threads in (
                ([comment("[P1] Fix authorization")], []),
                ([], [thread("[P1] Fix authorization")]),
                ([comment("Please create a Codex account to review.")], []),
                ([comment("Codex usage limits have been reached.")], []),
            ):
                with self.subTest(name=name, comments=extra_comments, threads=threads):
                    self.assert_gate(
                        1, snapshot(comments + extra_comments, threads), "wait_pr_codex.sh"
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
                + '")]',
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
