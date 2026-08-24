from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.audit_xum_branding import audit_paths


class AuditXumBrandingTest(unittest.TestCase):
    def test_reports_stale_copy_and_project_owned_filenames(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "Makefile").write_text("# Mux build instructions\n")
            stale_path = root / "benchmarks/terminal_bench/mux_new_adapter.py"
            stale_path.parent.mkdir(parents=True)
            stale_path.write_text("class Adapter:\n    pass\n")

            violations = audit_paths(
                root,
                ["Makefile", "benchmarks/terminal_bench/mux_new_adapter.py"],
            )

            self.assertEqual(
                [(item.path, item.line_number) for item in violations],
                [
                    ("Makefile", 1),
                    ("benchmarks/terminal_bench/mux_new_adapter.py", 0),
                ],
            )

    def test_accepts_reviewed_compatibility_and_ignores_generated_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "Makefile").write_text(
                "XUM_VITE_PORT ?= $(or $(MUX_VITE_PORT),5173)\n"
                "mux: xum ## Legacy alias for `make xum`\n"
            )
            history_path = (
                root
                / "benchmarks/terminal_bench/.leaderboard_cache/Mux__Historical/result.json"
            )
            history_path.parent.mkdir(parents=True)
            history_path.write_text('{"agent": "Mux"}\n')
            leaderboard_script = root / "benchmarks/terminal_bench/prepare_leaderboard_submission.py"
            leaderboard_script.write_text(
                'ignore_patterns("mux-app.tar.gz", "mux-tokens.json")\n'
            )
            log_service = root / "src/node/services/log.ts"
            log_service.parent.mkdir(parents=True)
            log_service.write_text(
                '// Clear old Mux logs after the rename\n'
                'path.join(logsDir, "mux.log")\n'
                'path.join(logsDir, `mux.${i}.log`)\n'
            )

            violations = audit_paths(
                root,
                [
                    "Makefile",
                    "benchmarks/terminal_bench/.leaderboard_cache/Mux__Historical/result.json",
                    "benchmarks/terminal_bench/prepare_leaderboard_submission.py",
                    "src/node/services/log.ts",
                ],
            )

            self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
