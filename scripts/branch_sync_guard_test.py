"""Offline wait_pr_* checkout-guard regressions: python3 scripts/branch_sync_guard_test.py.

Each wait script runs in a real clone of a local bare origin, with a fixture-only gh.
No credentials, network calls or polling sleeps.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PR = "4194"
WAIT_SCRIPTS = (
    "wait_pr_ready.sh",
    "wait_pr_checks.sh",
    "wait_pr_codex.sh",
    "wait_pr_coder_agents_review.sh",
)
SYNC_ERROR = "not in sync"

# Strict protocol double. Every PR read reports the PR as closed, so each wait script stops at
# its first gate instead of polling.
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_GH_CALLS'], 'a') as calls:
    calls.write(json.dumps(args) + '\\n')
pr = {
    'state': 'CLOSED',
    'headRefName': os.environ['FAKE_PR_HEAD_REF'],
    'headRefOid': os.environ['FAKE_PR_HEAD_OID'],
    'isCrossRepository': os.environ.get('FAKE_PR_FROM_FORK') == '1',
}
if args[:2] == ['repo', 'view']:
    print(json.dumps({'owner': 'fixture', 'name': 'repo'}))
elif args[:2] == ['pr', 'view']:
    print(json.dumps(pr))
elif args[:2] == ['api', 'graphql']:
    print(json.dumps({'data': {'repository': {'pullRequest': pr}}}))
else:
    raise AssertionError(args)
"""


def is_head_lookup(call):
    """The guard's read of the PR's head branch, as opposed to a gate's PR read."""
    return call[:2] == ["pr", "view"] and any("headRefName" in arg for arg in call)


class CheckoutGuardTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="checkout-guard-test-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "bin").mkdir()
        gh = root / "bin" / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.calls_file = root / "calls.jsonl"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("MUX_", "GH_", "GITHUB_", "GIT_"))
        }
        self.env.update({
            "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"],
            "FAKE_GH_CALLS": str(self.calls_file),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.com",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.com",
        })
        self.origin = root / "origin.git"
        self.work = root / "work"
        subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(self.origin)], env=self.env, check=True)
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(self.work)], env=self.env, check=True, capture_output=True)
        (self.work / "tracked.txt").write_text("base\n")
        self.git("add", "tracked.txt")
        self.git("commit", "--quiet", "-m", "base")
        self.git("push", "--quiet", "-u", "origin", "main")
        self.git("remote", "set-head", "origin", "main")
        # The watched PR: `feature`, pushed, its head on GitHub equal to origin/feature.
        self.git("switch", "--quiet", "-c", "feature")
        self.git("commit", "--quiet", "--allow-empty", "-m", "feature")
        self.git("push", "--quiet", "-u", "origin", "feature")
        self.pr_head("feature")

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.work, env=self.env, check=True, text=True, capture_output=True,
        ).stdout.strip()

    def pr_head(self, branch):
        self.env["FAKE_PR_HEAD_REF"] = branch
        self.env["FAKE_PR_HEAD_OID"] = self.git("rev-parse", f"origin/{branch}")

    def remote_heads(self):
        return self.git("ls-remote", "--heads", "origin")

    def run_script(self, script):
        self.calls_file.write_text("")
        args = ["bash", str(SCRIPTS / script), PR]
        if script != "wait_pr_ready.sh":
            args.append("--once")
        result = subprocess.run(args, cwd=self.work, env=self.env, text=True, capture_output=True, timeout=30, check=False)
        calls = [json.loads(line) for line in self.calls_file.read_text().splitlines()]
        result.gate_calls = [call for call in calls if call[:2] != ["repo", "view"] and not is_head_lookup(call)]
        return result

    def assert_reaches_gates(self, script):
        """The guard let the script read the PR's gate state."""
        result = self.run_script(script)
        output = result.stdout + result.stderr
        self.assertNotIn(SYNC_ERROR, output)
        self.assertNotIn("uncommitted changes", output)
        self.assertTrue(result.gate_calls, output)
        return result

    def assert_blocked_before_gates(self, script, reason):
        result = self.run_script(script)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, output)
        self.assertIn(reason, output)
        self.assertEqual(result.gate_calls, [], output)
        return result

    def test_another_stack_branch_ahead_of_its_upstream_does_not_block_the_pr(self):
        self.git("switch", "--quiet", "-c", "stack-b")
        self.git("push", "--quiet", "-u", "origin", "stack-b")
        self.git("commit", "--quiet", "--allow-empty", "-m", "unpushed stack-b work")
        for script in WAIT_SCRIPTS:
            with self.subTest(script=script):
                self.assert_reaches_gates(script)

    def test_an_unpushed_branch_is_never_pushed(self):
        self.git("switch", "--quiet", "-c", "scratch")
        self.git("commit", "--quiet", "--allow-empty", "-m", "local only")
        for script in WAIT_SCRIPTS:
            with self.subTest(script=script):
                self.assert_reaches_gates(script)
                self.assertNotIn("refs/heads/scratch", self.remote_heads())

    def test_uncommitted_changes_on_another_branch_do_not_block_the_pr(self):
        self.git("switch", "--quiet", "-c", "stack-b")
        (self.work / "tracked.txt").write_text("edited\n")
        self.assert_reaches_gates("wait_pr_checks.sh")

    def test_a_stack_branch_tracking_its_parent_is_compared_with_its_own_pr(self):
        # `git switch -c <branch> origin/<parent>` makes the parent PR's branch the upstream (#7874).
        self.git("switch", "--quiet", "-c", "stack-b", "origin/feature")
        self.git("commit", "--quiet", "--allow-empty", "-m", "stack-b")
        self.git("push", "--quiet", "origin", "stack-b")
        self.pr_head("stack-b")
        self.assert_reaches_gates("wait_pr_checks.sh")

    def test_the_synced_pr_branch_reaches_the_gates(self):
        for script in WAIT_SCRIPTS:
            with self.subTest(script=script):
                self.assert_reaches_gates(script)

    def test_the_pr_branch_ahead_of_the_pr_head_is_blocked(self):
        self.git("commit", "--quiet", "--allow-empty", "-m", "unpushed feature work")
        for script in WAIT_SCRIPTS:
            with self.subTest(script=script):
                result = self.assert_blocked_before_gates(script, SYNC_ERROR)
                self.assertIn("1 commit(s) ahead", result.stderr)
        self.assertEqual(self.git("rev-parse", "origin/feature"), self.env["FAKE_PR_HEAD_OID"])

    def test_a_pasted_push_hint_pushes_the_pr_branch_and_runs_nothing_else(self):
        # Git allows `$(...)` in branch names, so a PR author controls this text.
        branch = "feature-$(touch${IFS}pwned)"
        self.git("switch", "--quiet", "-c", branch)
        self.git("push", "--quiet", "-u", "origin", branch)
        self.pr_head(branch)
        self.git("commit", "--quiet", "--allow-empty", "-m", "unpushed work")
        result = self.assert_blocked_before_gates("wait_pr_checks.sh", SYNC_ERROR)
        hint = next(line for line in result.stderr.splitlines() if line.startswith("Push your changes with: "))
        paste = Path(self.calls_file).parent / "paste"
        (paste / "bin").mkdir(parents=True)
        recorder = paste / "bin" / "git"
        recorder.write_text("#!/usr/bin/env python3\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n")
        recorder.chmod(0o755)
        pasted = subprocess.run(
            ["bash", "-c", hint.removeprefix("Push your changes with: ")], cwd=paste, text=True, capture_output=True,
            env=dict(self.env, PATH=str(paste / "bin") + os.pathsep + self.env["PATH"]), check=True,
        )
        self.assertEqual(json.loads(pasted.stdout), ["push", "origin", f"refs/heads/{branch}"])
        self.assertFalse((paste / "pwned").exists())

    def test_a_fork_pr_sharing_the_checkout_branch_name_does_not_block_the_pr(self):
        # The fork's `feature` is unrelated to this checkout's `feature`, and origin is not the fork.
        self.env["FAKE_PR_FROM_FORK"] = "1"
        self.env["FAKE_PR_HEAD_OID"] = "f" * 40
        self.assert_reaches_gates("wait_pr_checks.sh")

    def test_a_pr_head_pushed_elsewhere_is_fetched_by_branch_even_when_a_tag_shares_its_name(self):
        self.git("push", "--quiet", "origin", "main:refs/tags/feature")
        other = Path(self.calls_file).parent / "other"
        subprocess.run(["git", "clone", "--quiet", "-b", "feature", str(self.origin), str(other)], env=self.env, check=True)
        subprocess.run(["git", "commit", "--quiet", "--allow-empty", "-m", "pushed elsewhere"], cwd=other, env=self.env, check=True)
        subprocess.run(["git", "push", "--quiet", "origin", "HEAD:refs/heads/feature"], cwd=other, env=self.env, check=True)
        self.env["FAKE_PR_HEAD_OID"] = self.git("ls-remote", "origin", "refs/heads/feature").split()[0]
        result = self.assert_blocked_before_gates("wait_pr_checks.sh", SYNC_ERROR)
        self.assertIn("1 commit(s) behind", result.stderr)

    def test_uncommitted_changes_on_the_pr_branch_are_blocked(self):
        (self.work / "tracked.txt").write_text("edited\n")
        self.assert_blocked_before_gates("wait_pr_checks.sh", "uncommitted changes")


if __name__ == "__main__":
    unittest.main()
