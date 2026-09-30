#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from benchmarks.terminal_bench.mux_run_contract import (  # noqa: E402
    MUX_RUN_FAILURE_MARKER,
    OOM_LIKE_RETURN_CODE,
    RUN_COMPLETE_MARKER,
    TIMEOUT_RETURN_CODE,
    mux_run_failure_marker,
)

Category = Literal["infra", "soft", "hard"]

INFRA_ERROR_NAMES = (
    "AgentTimeoutError",
    "VerifierTimeoutError",
    "AgentSetupTimeoutError",
    "EnvironmentStartTimeoutError",
    "DaytonaError",
    "DaytonaTimeoutError",
    "DaytonaConnectionError",
    "DaytonaNetworkError",
    "DaytonaServerError",
    "DaytonaInternalServerError",
    "DaytonaServiceUnavailableError",
    "DaytonaRateLimitError",
    "DaytonaTooManyRequestsError",
    "DaytonaSandboxTimeoutError",
    "DaytonaSandboxStartTimeoutError",
    "DaytonaSandboxNotStartedError",
    "DaytonaSandboxNoIpError",
)
INFRA_ERROR_PATTERN = re.compile(r"\b(" + "|".join(INFRA_ERROR_NAMES) + r")\b")
EXIT_CODE_PATTERN = re.compile(r"\bexit\s+(-?\d+)\b")
TRANSIENT_STREAM_MARKERS = (
    "Stream aborted before completion",
    "EmptyStreamOutputError",
    "model ended the stream before producing any assistant-visible output",
)


@dataclass(frozen=True)
class ResultStats:
    n_trials: int = 0
    n_errors: int = 0
    mean_score: float = 0.0


@dataclass(frozen=True)
class ClassifiedException:
    path: Path
    category: Category
    reason: str
    return_code: int | None
    summary: str


@dataclass(frozen=True)
class CheckResult:
    stats: ResultStats
    exceptions: tuple[ClassifiedException, ...]
    fatal_errors: tuple[str, ...] = ()
    missing_exception_count: int = 0

    @property
    def infra_count(self) -> int:
        return self._count_category("infra")

    @property
    def soft_count(self) -> int:
        return self._count_category("soft")

    @property
    def hard_count(self) -> int:
        return self._count_category("hard") + self.missing_exception_count

    @property
    def is_success(self) -> bool:
        return not self.fatal_errors and self.hard_count == 0

    def _count_category(self, category: Category) -> int:
        return sum(1 for exception in self.exceptions if exception.category == category)


def load_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def read_text(path: Path) -> str:
    try:
        return path.read_text()
    except OSError:
        return ""


def parse_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def extract_result_stats(result: dict) -> ResultStats:
    stats = result.get("stats")
    stats = stats if isinstance(stats, dict) else {}

    n_trials = parse_int(result.get("n_total_trials"))
    if n_trials is None:
        n_trials = parse_int(stats.get("n_trials")) or 0

    n_errors = parse_int(stats.get("n_errors"))
    if n_errors is None:
        n_errors = parse_int(stats.get("n_errored_trials"))
    if n_errors is None:
        n_errors = 0
        evals = stats.get("evals")
        if isinstance(evals, dict):
            for eval_result in evals.values():
                if isinstance(eval_result, dict):
                    n_errors += parse_int(eval_result.get("n_errors")) or 0

    mean_scores: list[float] = []
    evals = stats.get("evals")
    if isinstance(evals, dict):
        for eval_result in evals.values():
            if not isinstance(eval_result, dict):
                continue
            metrics = eval_result.get("metrics")
            if not isinstance(metrics, list) or not metrics:
                continue
            first_metric = metrics[0]
            if isinstance(first_metric, dict):
                mean = first_metric.get("mean")
                if isinstance(mean, (int, float)) and not isinstance(mean, bool):
                    mean_scores.append(float(mean))

    mean_score = sum(mean_scores) / len(mean_scores) if mean_scores else 0.0
    return ResultStats(n_trials=n_trials, n_errors=n_errors, mean_score=mean_score)


def combine_stats(results: list[dict]) -> ResultStats:
    stats = [extract_result_stats(result) for result in results]
    if not stats:
        return ResultStats()
    mean_scores = [item.mean_score for item in stats]
    return ResultStats(
        n_trials=sum(item.n_trials for item in stats),
        n_errors=sum(item.n_errors for item in stats),
        mean_score=sum(mean_scores) / len(mean_scores) if mean_scores else 0.0,
    )


def parse_return_code(exception_text: str, command_dir: Path) -> int | None:
    return_code = parse_int(read_text(command_dir / "return-code.txt"))
    if return_code is not None:
        return return_code
    match = EXIT_CODE_PATTERN.search(exception_text)
    return int(match.group(1)) if match else None


def exception_summary(text: str) -> str:
    non_empty_lines = [line.strip() for line in text.splitlines() if line.strip()]
    return non_empty_lines[-1] if non_empty_lines else "<empty exception>"


def has_transient_stream_marker(text: str) -> bool:
    return any(marker in text for marker in TRANSIENT_STREAM_MARKERS)


def classify_exception(
    exception_path: Path,
    *,
    allow_transient_agent_errors: bool,
) -> ClassifiedException:
    exception_text = read_text(exception_path)
    command_dir = exception_path.parent / "agent" / "command-0"
    stderr = read_text(command_dir / "stderr.txt")
    stdout = read_text(command_dir / "stdout.txt")
    return_code = parse_return_code(exception_text, command_dir)
    combined_diagnostic = "\n".join((exception_text, stderr))

    if INFRA_ERROR_PATTERN.search(exception_text):
        return ClassifiedException(
            path=exception_path,
            category="infra",
            reason="infrastructure exception",
            return_code=return_code,
            summary=exception_summary(exception_text),
        )

    if allow_transient_agent_errors:
        if return_code == 1 and has_transient_stream_marker(combined_diagnostic):
            return ClassifiedException(
                path=exception_path,
                category="soft",
                reason="provider stream transient",
                return_code=return_code,
                summary=exception_summary(exception_text),
            )
        if return_code == OOM_LIKE_RETURN_CODE:
            return ClassifiedException(
                path=exception_path,
                category="soft",
                reason="agent process killed",
                return_code=return_code,
                summary=exception_summary(exception_text),
            )
        if (
            return_code == TIMEOUT_RETURN_CODE
            and RUN_COMPLETE_MARKER not in stdout
            and mux_run_failure_marker(TIMEOUT_RETURN_CODE) not in stderr
        ):
            return ClassifiedException(
                path=exception_path,
                category="soft",
                reason="timeout-like exit 124",
                return_code=return_code,
                summary=exception_summary(exception_text),
            )

    reason = "non-infrastructure exception"
    if return_code is not None:
        reason = f"agent exit {return_code}"
    if MUX_RUN_FAILURE_MARKER in stderr:
        reason = f"mux-run failure ({reason})"

    return ClassifiedException(
        path=exception_path,
        category="hard",
        reason=reason,
        return_code=return_code,
        summary=exception_summary(exception_text),
    )


def find_result_files(jobs_dir: Path) -> list[Path]:
    if not jobs_dir.is_dir():
        return []
    return sorted(jobs_dir.glob("*/result.json"))


def find_exception_files(jobs_dir: Path) -> list[Path]:
    if not jobs_dir.is_dir():
        return []
    return sorted(jobs_dir.glob("*/**/exception.txt"))


def check_results(
    jobs_dir: Path,
    *,
    allow_transient_agent_errors: bool = False,
) -> CheckResult:
    result_files = find_result_files(jobs_dir)
    if not result_files:
        return CheckResult(
            stats=ResultStats(),
            exceptions=(),
            fatal_errors=("No result.json found under jobs directory",),
        )

    results = [loaded for path in result_files if (loaded := load_json(path)) is not None]
    if len(results) != len(result_files):
        return CheckResult(
            stats=ResultStats(),
            exceptions=(),
            fatal_errors=("Unable to parse one or more result.json files",),
        )

    stats = combine_stats(results)
    fatal_errors: list[str] = []
    if stats.n_trials == 0:
        fatal_errors.append("No trials ran")
    if stats.n_errors == 0:
        return CheckResult(stats=stats, exceptions=(), fatal_errors=tuple(fatal_errors))

    exception_files = find_exception_files(jobs_dir)
    exceptions = tuple(
        classify_exception(
            exception_file,
            allow_transient_agent_errors=allow_transient_agent_errors,
        )
        for exception_file in exception_files
    )
    missing_exception_count = max(stats.n_errors - len(exception_files), 0)

    return CheckResult(
        stats=stats,
        exceptions=exceptions,
        fatal_errors=tuple(fatal_errors),
        missing_exception_count=missing_exception_count,
    )


def format_summary(result: CheckResult) -> str:
    lines = [
        (
            f"Trials: {result.stats.n_trials}, Errors: {result.stats.n_errors}, "
            f"Mean score: {result.stats.mean_score:g}"
        ),
        "",
        "Error classification:",
        f"  {'category':<8} {'count':>5}",
        f"  {'infra':<8} {result.infra_count:>5}",
        f"  {'soft':<8} {result.soft_count:>5}",
        f"  {'hard':<8} {result.hard_count:>5}",
    ]

    if result.exceptions:
        reason_counts = Counter(
            (exception.category, exception.reason) for exception in result.exceptions
        )
        lines.extend(["", "Reasons:"])
        for (category, reason), count in sorted(reason_counts.items()):
            lines.append(f"  {category:<8} {count:>5}  {reason}")

    hard_exceptions = [
        exception for exception in result.exceptions if exception.category == "hard"
    ]
    if hard_exceptions or result.missing_exception_count:
        lines.extend(["", "Hard error details:"])
        for exception in hard_exceptions:
            lines.append(f"=== {exception.path} ===")
            lines.append(exception.summary)
        if result.missing_exception_count:
            lines.append(
                f"Missing exception.txt details for {result.missing_exception_count} error(s)"
            )

    if result.fatal_errors:
        lines.extend(["", "Fatal validation errors:"])
        lines.extend(f"  - {error}" for error in result.fatal_errors)

    if result.is_success:
        lines.append("")
        lines.append(
            f"Agent ran {result.stats.n_trials} trial(s) successfully "
            f"(mean score: {result.stats.mean_score:g})"
        )
    return "\n".join(lines)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Classify Harbor Terminal-Bench result errors."
    )
    parser.add_argument(
        "--jobs-dir",
        type=Path,
        default=Path("jobs"),
        help="Path to Harbor jobs directory (default: jobs)",
    )
    parser.add_argument(
        "--allow-transient-agent-errors",
        action="store_true",
        help="Allow explicitly classified full-nightly agent transients.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    result = check_results(
        args.jobs_dir,
        allow_transient_agent_errors=args.allow_transient_agent_errors,
    )
    print(format_summary(result))
    return 0 if result.is_success else 1


if __name__ == "__main__":
    raise SystemExit(main())
