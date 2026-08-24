#!/usr/bin/env python3
"""Audit the project-owned rename boundary without rejecting compatibility contracts."""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

BRANDING_PATTERN = re.compile(r"(?i)cmux|mux")

# This is intentionally a boundary audit, not a blind repository-wide zero-match rule.
# Generated dependencies, docs/history, icon assets, and core TS Mux* types are outside
# this change set; adding a project-owned surface requires an explicit review here.
BOUNDARY_GLOBS = (
    "Makefile",
    ".envrc",
    "public/service-worker.js",
    "benchmarks/terminal_bench/**",
    ".github/workflows/terminal-bench.yml",
    ".github/workflows/nightly-terminal-bench.yml",
    "scripts/check-bench-agent.sh",
    "scripts/check_tbench_results.py",
    "src/node/services/log.ts",
    "src/common/constants/paths.ts",
    "src/cli/server.ts",
    "src/cli/serverCrashLogging.test.ts",
)

EXCLUDED_GLOBS = (
    "**/__pycache__/**",
    "benchmarks/terminal_bench/.leaderboard_cache/**",
)


@dataclass(frozen=True)
class AllowRule:
    path_glob: str
    content_pattern: re.Pattern[str]
    reason: str


# Each retained spelling maps to a compatibility or historical contract. Keep rules
# narrow enough that a new user-facing "Mux" sentence on a canonical surface fails.
ALLOW_RULES = (
    AllowRule(
        "Makefile",
        re.compile(r"MUX_(?:\*|[A-Z0-9_]+)"),
        "legacy developer environment input",
    ),
    AllowRule(
        "Makefile",
        re.compile(r"^mux:|\.PHONY:.*\bmux\b|filter.*\bmux\b"),
        "legacy Make CLI alias",
    ),
    AllowRule("Makefile", re.compile(r"smoke-test-mux-compat\.sh"), "legacy package smoke test"),
    AllowRule(".envrc", re.compile(r"LEGACY_MUX_SHARED_ENVRC|\.mux/"), "legacy shared env fallback"),
    AllowRule("public/service-worker.js", re.compile(r"LEGACY_MUX_CACHE_NAME|mux-v2"), "superseded cache cleanup"),
    AllowRule("benchmarks/terminal_bench/mux_agent.py", re.compile(r".*"), "legacy Harbor import path"),
    AllowRule("benchmarks/terminal_bench/mux-run.sh", re.compile(r".*"), "legacy staged runner entrypoint"),
    AllowRule("benchmarks/terminal_bench/__init__.py", re.compile(r"MuxAgent"), "legacy lazy class alias"),
    AllowRule("benchmarks/terminal_bench/xum_agent.py", re.compile(r"MUX_(?:\*|[A-Z0-9_]+|\$?\{)"), "legacy benchmark environment input"),
    AllowRule(
        "benchmarks/terminal_bench/xum_agent_test.py",
        re.compile(r"MUX_[A-Z0-9_]+|MuxAgent|mux_agent|mux-run\.sh"),
        "compatibility behavior coverage",
    ),
    AllowRule(
        "benchmarks/terminal_bench/prepare_leaderboard_submission.py",
        re.compile(r"[\"']mux-(?:app\.tar\.gz|tokens\.json)[\"']"),
        "pre-rename trial artifacts must remain excluded from mixed leaderboard submissions",
    ),
    AllowRule("benchmarks/terminal_bench/xum-run.sh", re.compile(r"MUX_(?:\*|[A-Z0-9_]+|\$?\{)"), "legacy runner environment input"),
    AllowRule("benchmarks/terminal_bench/xum_setup.sh.j2", re.compile(r"MUX_(?:\*|[A-Z0-9_]+|\$?\{)"), "legacy setup environment input"),
    AllowRule(
        "benchmarks/terminal_bench/README.md",
        re.compile(r"mux_run_(?:args|as_goal)"),
        "legacy workflow-dispatch input required by GitHub's input limit",
    ),
    AllowRule(
        "benchmarks/terminal_bench/README.md",
        re.compile(r"mux-benchmarks"),
        "existing BigQuery project ID",
    ),
    AllowRule("benchmarks/terminal_bench/analyze_failure_rates.py", re.compile(r"mux-benchmarks"), "existing BigQuery project ID"),
    AllowRule("benchmarks/terminal_bench/analyze_failure_rates.py", re.compile(r"--mux-model|[\"']mux[\"']|historical Mux"), "legacy CLI alias and leaderboard history"),
    AllowRule(".github/workflows/terminal-bench.yml", re.compile(r"inputs\.mux_|^\s*mux_"), "legacy reusable-workflow input"),
    AllowRule(
        ".github/workflows/nightly-terminal-bench.yml",
        re.compile(r"inputs\.mux_|^\s*mux_"),
        "legacy workflow-dispatch input",
    ),
    AllowRule(".github/workflows/terminal-bench.yml", re.compile(r"mux-benchmarks"), "existing BigQuery project ID"),
    AllowRule(
        "src/node/services/log.ts",
        re.compile(r"common/compat/legacyMux"),
        "centralized compatibility resolver import",
    ),
    AllowRule(
        "src/node/services/log.ts",
        re.compile(r"old Mux logs|[\"'`]mux(?:\.\$?\{?i\}?|\.log)"),
        "clear action removes pre-rename log files that may contain sensitive output",
    ),
    AllowRule("src/node/services/log.ts", re.compile(r"MUX_(?:DEBUG|LOG_LEVEL)"), "legacy logging environment input"),
    AllowRule(
        "src/common/constants/paths.ts",
        re.compile(r"LEGACY_(?:C?MUX)|legacyC?Mux|MUX_ROOT", re.IGNORECASE),
        "centralized storage compatibility",
    ),
    AllowRule(
        "src/cli/server.ts",
        re.compile(r"common/compat/legacyMux"),
        "centralized compatibility resolver import",
    ),
    AllowRule("src/cli/server.ts", re.compile(r"MUX_SERVER_(?:URL|AUTH_TOKEN)"), "legacy server environment output"),
    AllowRule("src/cli/serverCrashLogging.test.ts", re.compile(r"[\"']mux[\"']"), "legacy CLI argv redaction coverage"),
)


@dataclass(frozen=True)
class Violation:
    path: str
    line_number: int
    line: str


def _matches_any(path: str, globs: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in globs)


def _is_allowed(path: str, text: str) -> bool:
    return any(
        fnmatch.fnmatch(path, rule.path_glob) and rule.content_pattern.search(text)
        for rule in ALLOW_RULES
    )


def audit_paths(root: Path, paths: Iterable[str]) -> list[Violation]:
    violations: list[Violation] = []
    for relative_path in sorted(set(paths)):
        if not _matches_any(relative_path, BOUNDARY_GLOBS):
            continue
        if _matches_any(relative_path, EXCLUDED_GLOBS):
            continue

        # Filenames are branding too. Compatibility entrypoint names need their own rule.
        if BRANDING_PATTERN.search(relative_path) and not _is_allowed(relative_path, relative_path):
            violations.append(Violation(relative_path, 0, "project-owned path contains legacy branding"))

        path = root / relative_path
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue

        for line_number, line in enumerate(lines, start=1):
            if BRANDING_PATTERN.search(line) and not _is_allowed(relative_path, line):
                violations.append(Violation(relative_path, line_number, line.strip()))
    return violations


def _tracked_paths(root: Path) -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.splitlines()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--verbose", action="store_true", help="Print boundary and allowlist counts")
    args = parser.parse_args()

    root = args.root.resolve()
    violations = audit_paths(root, _tracked_paths(root))
    if violations:
        print("Non-allowlisted legacy branding found in the Xum rename boundary:", file=sys.stderr)
        for violation in violations:
            location = f"{violation.path}:{violation.line_number}" if violation.line_number else violation.path
            print(f"  {location}: {violation.line}", file=sys.stderr)
        print("Update the branding or add a narrow ALLOW_RULES entry with a compatibility reason.", file=sys.stderr)
        return 1

    if args.verbose:
        print(
            f"Xum branding audit passed ({len(BOUNDARY_GLOBS)} boundary globs, "
            f"{len(ALLOW_RULES)} explicit allowlist rules)."
        )
    else:
        print("Xum branding audit passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
