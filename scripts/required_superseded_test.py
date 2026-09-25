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


def run(run_id, started=MINE_STARTED, attempt=1, pr=PR, base=BASE, status="in_progress"):
    return {
        "id": run_id,
        "run_started_at": started,
        "run_attempt": attempt,
        "status": status,
        "pull_requests": [] if pr is None else [{"number": pr, "base": {"sha": base}}],
    }


def jobs(*started_conclusions):
    return {
        "jobs": [
            {"started_at": started, "conclusion": conclusion}
            for started, conclusion in started_conclusions
        ]
    }


STARTED_JOB = jobs(("2026-09-25T10:00:05Z", None))
NO_JOBS = jobs()


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

    def decide(self, fixture, max_polls=3):
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
            "POLL_SECS": "0",
            "MAX_POLLS": str(max_polls),
        }
        return subprocess.run(
            ["bash", str(SCRIPT)], env=env, text=True, capture_output=True, timeout=30
        )

    def assert_decision(self, expected, runs, sibling=None, max_polls=3):
        fixture = {RUNS_PATH: [{"workflow_runs": runs}]}
        for run_id, (job_pages, statuses) in (sibling or {}).items():
            fixture[f"repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100"] = job_pages
            fixture[f"repos/{REPO}/actions/runs/{run_id}"] = [{"status": s} for s in statuses]
        result = self.decide(fixture, max_polls)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_newer_same_pr_sibling_that_started_a_job_stands_in(self):
        self.assert_decision(0, [run(ME), run(101)], {101: ([STARTED_JOB], ["in_progress"])})

    def test_same_second_sibling_stands_in(self):
        # Duplicate events can share a start timestamp.
        self.assert_decision(0, [run(ME), run(101, started=MINE_STARTED)], {101: ([STARTED_JOB], ["in_progress"])})

    def test_queued_sibling_is_awaited_until_it_starts_a_job(self):
        self.assert_decision(0, [run(ME), run(101)], {101: ([NO_JOBS, NO_JOBS, STARTED_JOB], ["queued"])})

    def test_sibling_that_never_starts_a_job_does_not_stand_in(self):
        # startup_failure / action_required / stale: completed without jobs.
        for statuses in (["completed"], ["queued", "completed"]):
            with self.subTest(statuses=statuses):
                self.assert_decision(1, [run(ME), run(101)], {101: ([NO_JOBS], statuses)})

    def test_sibling_still_queued_after_the_wait_does_not_stand_in(self):
        self.assert_decision(1, [run(ME), run(101)], {101: ([NO_JOBS], ["queued"])}, max_polls=2)

    def test_skipped_jobs_are_not_proof(self):
        skipped = jobs(("2026-09-25T10:00:05Z", "skipped"))
        self.assert_decision(1, [run(ME), run(101)], {101: ([skipped], ["completed"])})

    def test_ineligible_siblings_never_stand_in(self):
        started_sibling = {101: ([STARTED_JOB], ["in_progress"])}
        for name, sibling in (
            ("other PR", run(101, pr=9999)),
            ("no PR association (fork)", run(101, pr=None)),
            ("other base", run(101, base=OTHER_BASE)),
            ("older run", run(101, started="2026-09-25T09:59:59Z")),
            ("rerun", run(101, attempt=2)),
        ):
            with self.subTest(name):
                self.assert_decision(1, [run(ME), sibling], started_sibling)

    def test_sole_run_does_not_stand_down(self):
        self.assert_decision(1, [run(ME)])

    def test_unlisted_own_run_does_not_stand_down(self):
        self.assert_decision(1, [run(101)], {101: ([STARTED_JOB], ["in_progress"])})

    def test_api_errors_fail_closed(self):
        # Sibling job listing missing from the double -> gh exits 1.
        self.assert_decision(1, [run(ME), run(101)])


if __name__ == "__main__":
    unittest.main()
