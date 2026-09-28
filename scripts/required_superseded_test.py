"""Offline regressions for scripts/lib/required_superseded.sh:
python3 scripts/required_superseded_test.py. A fixture-only gh; no network or sleeps.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "lib/required_superseded.sh"
REPO = "fixture/repo"
HEAD = "1" * 40
BASE = "2" * 40
OTHER_BASE = "3" * 40
PR = 4548
ME = 100
MINE_STARTED = "2026-09-25T10:00:00Z"
RUNS_PATH = f"repos/{REPO}/actions/workflows/pr.yml/runs?head_sha={HEAD}&event=pull_request&per_page=100"


def run(run_id, started=MINE_STARTED, attempt=1, pr=PR, base=BASE, status="pending", conclusion=None):
    return {
        "id": run_id,
        "run_started_at": started,
        "run_attempt": attempt,
        "status": status,
        "conclusion": conclusion,
        "pull_requests": [] if pr is None else [{"number": pr, "base": {"sha": base}}],
    }


class RequiredSupersededTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="required-superseded-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        gh = self.directory / "gh"
        # Strict double: unknown paths fail, like a real API error would.
        gh.write_text(
            """#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[0] == 'api' and len(args) == 2, args
fixture = json.loads(pathlib.Path(os.environ['FIXTURE']).read_text())
counts_path = pathlib.Path(os.environ['FIXTURE'] + '.counts')
counts = json.loads(counts_path.read_text()) if counts_path.exists() else {}
responses = fixture.get(args[1])
if responses is None:
    print('gh: Not Found (HTTP 404)', file=sys.stderr)
    sys.exit(1)
index = counts.get(args[1], 0)
counts[args[1]] = index + 1
counts_path.write_text(json.dumps(counts))
print(json.dumps(responses[min(index, len(responses) - 1)]))
"""
        )
        gh.chmod(0o755)

    def decide(self, fixture):
        path = self.directory / "fixture.json"
        path.write_text(json.dumps(fixture))
        env = {
            **os.environ,
            "PATH": f"{self.directory}{os.pathsep}{os.environ['PATH']}",
            "FIXTURE": str(path),
            "GITHUB_REPOSITORY": REPO,
            "GITHUB_RUN_ID": str(ME),
            "HEAD_SHA": HEAD,
            "BASE_SHA": BASE,
            "PR_NUMBER": str(PR),
        }
        return subprocess.run(
            ["bash", str(SCRIPT)], env=env, text=True, capture_output=True, timeout=30
        )

    def assert_decision(self, expected, runs):
        fixture = {} if runs is None else {RUNS_PATH: [{"workflow_runs": runs}]}
        result = self.decide(fixture)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_newer_sibling_that_will_publish_required_stands_in(self):
        # pending = queued behind this concurrency group: the duplicate-run case.
        for status, conclusion in (
            ("pending", None),
            ("queued", None),
            ("in_progress", None),
            ("completed", "success"),
            ("completed", "failure"),
        ):
            with self.subTest(status=status, conclusion=conclusion):
                self.assert_decision(
                    0, [run(ME), run(101, status=status, conclusion=conclusion)]
                )

    def test_same_second_sibling_stands_in(self):
        # Duplicate events can share a start timestamp.
        self.assert_decision(0, [run(ME), run(101, started=MINE_STARTED)])

    def test_sibling_that_never_publishes_required_does_not_stand_in(self):
        for status, conclusion in (
            ("completed", "startup_failure"),
            ("completed", "action_required"),
            ("completed", "stale"),
            ("completed", "cancelled"),
            ("requested", None),
            ("waiting", None),
        ):
            with self.subTest(status=status, conclusion=conclusion):
                self.assert_decision(
                    1, [run(ME), run(101, status=status, conclusion=conclusion)]
                )

    def test_ineligible_siblings_never_stand_in(self):
        for name, sibling in (
            ("other PR", run(101, pr=9999)),
            ("no PR association (fork)", run(101, pr=None)),
            ("other base", run(101, base=OTHER_BASE)),
            ("older run", run(101, started="2026-09-25T09:59:59Z")),
            ("rerun", run(101, attempt=2)),
        ):
            with self.subTest(name):
                self.assert_decision(1, [run(ME), sibling])

    def test_sole_run_does_not_stand_down(self):
        self.assert_decision(1, [run(ME)])

    def test_unlisted_own_run_does_not_stand_down(self):
        self.assert_decision(1, [run(101)])

    def test_api_errors_fail_closed(self):
        self.assert_decision(1, None)


if __name__ == "__main__":
    unittest.main()
