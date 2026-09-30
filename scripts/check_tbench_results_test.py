from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_tbench_results as checker  # noqa: E402


def _write_job(
    tmp_path: Path,
    *,
    n_trials: int = 1,
    n_errors: int = 1,
) -> Path:
    job_dir = tmp_path / "jobs" / "2026-05-26__00-00-00"
    job_dir.mkdir(parents=True)
    (job_dir / "result.json").write_text(
        json.dumps(
            {
                "n_total_trials": n_trials,
                "stats": {
                    "n_errors": n_errors,
                    "evals": {"terminal-bench": {"metrics": [{"mean": 0.5}]}},
                },
            }
        )
    )
    return job_dir


def _write_exception(
    job_dir: Path,
    trial_name: str,
    exception_text: str,
    *,
    return_code: int | None = None,
    stderr: str = "",
    stdout: str = "",
) -> Path:
    trial_dir = job_dir / trial_name
    command_dir = trial_dir / "agent" / "command-0"
    command_dir.mkdir(parents=True)
    (trial_dir / "exception.txt").write_text(exception_text)
    if return_code is not None:
        (command_dir / "return-code.txt").write_text(str(return_code))
    (command_dir / "stderr.txt").write_text(stderr)
    (command_dir / "stdout.txt").write_text(stdout)
    return trial_dir / "exception.txt"


def _analyze(
    tmp_path: Path,
    *,
    allow_transient_agent_errors: bool = False,
) -> checker.CheckResult:
    return checker.check_results(
        tmp_path / "jobs",
        allow_transient_agent_errors=allow_transient_agent_errors,
    )


@pytest.mark.parametrize(
    "exception_name",
    [
        "AgentTimeoutError",
        "VerifierTimeoutError",
        "AgentSetupTimeoutError",
        "EnvironmentStartTimeoutError",
        "DaytonaTimeoutError",
        "DaytonaConnectionError",
    ],
)
def test_known_infrastructure_errors_are_allowed(
    tmp_path: Path, exception_name: str
) -> None:
    job_dir = _write_job(tmp_path)
    _write_exception(job_dir, "task__abc", f"harbor.error.{exception_name}: transient")

    result = _analyze(tmp_path)

    assert result.hard_count == 0
    assert result.infra_count == 1
    assert result.is_success


@pytest.mark.parametrize("exception_name", ["DaytonaAuthenticationError", "DaytonaValidationError"])
def test_daytona_configuration_errors_stay_hard(
    tmp_path: Path, exception_name: str
) -> None:
    job_dir = _write_job(tmp_path)
    _write_exception(job_dir, "task__abc", f"daytona.error.{exception_name}: bad config")

    result = _analyze(tmp_path)

    assert result.hard_count == 1
    assert result.infra_count == 0
    assert not result.is_success


def test_zero_mean_scores_are_included_when_combining_stats() -> None:
    result = checker.combine_stats(
        [
            {
                "n_total_trials": 1,
                "stats": {"n_errors": 0, "evals": {"a": {"metrics": [{"mean": 0.0}]}}},
            },
            {
                "n_total_trials": 1,
                "stats": {"n_errors": 0, "evals": {"b": {"metrics": [{"mean": 1.0}]}}},
            },
        ]
    )

    assert result.mean_score == 0.5

@pytest.mark.parametrize(
    "transient_message",
    [
        "Stream aborted before completion",
        "EmptyStreamOutputError",
        "model ended the stream before producing any assistant-visible output",
    ],
)
def test_exit_1_stream_transients_require_nightly_flag(
    tmp_path: Path, transient_message: str
) -> None:
    job_dir = _write_job(tmp_path)
    _write_exception(
        job_dir,
        "task__abc",
        "RuntimeError: mux agent command failed (command 0, exit 1)",
        return_code=1,
        stderr=(
            f"Error: {transient_message}\n"
            "[mux-run] ERROR: mux agent session failed (exit 1)"
        ),
    )

    strict_result = _analyze(tmp_path)
    allowed_result = _analyze(tmp_path, allow_transient_agent_errors=True)

    assert strict_result.hard_count == 1
    assert not strict_result.is_success
    assert allowed_result.hard_count == 0
    assert allowed_result.soft_count == 1
    assert allowed_result.is_success


def test_exit_137_requires_nightly_flag(tmp_path: Path) -> None:
    job_dir = _write_job(tmp_path)
    _write_exception(
        job_dir,
        "task__abc",
        "RuntimeError: mux agent command failed (command 0, exit 137)",
        return_code=137,
    )

    strict_result = _analyze(tmp_path)
    allowed_result = _analyze(tmp_path, allow_transient_agent_errors=True)

    assert strict_result.hard_count == 1
    assert not strict_result.is_success
    assert allowed_result.hard_count == 0
    assert allowed_result.soft_count == 1
    assert allowed_result.is_success


def test_unknown_exit_1_stays_hard_with_nightly_flag(tmp_path: Path) -> None:
    job_dir = _write_job(tmp_path)
    _write_exception(
        job_dir,
        "task__abc",
        "RuntimeError: mux agent command failed (command 0, exit 1)",
        return_code=1,
        stderr="[mux-run] ERROR: mux agent session failed (exit 1)",
    )

    result = _analyze(tmp_path, allow_transient_agent_errors=True)

    assert result.hard_count == 1
    assert not result.is_success



def test_no_errors_skips_exception_scan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _write_job(tmp_path, n_errors=0)

    def fail_scan(_jobs_dir: Path) -> list[Path]:
        raise AssertionError("exception scan should be skipped when n_errors is zero")

    monkeypatch.setattr(checker, "find_exception_files", fail_scan)

    result = _analyze(tmp_path)

    assert result.is_success
    assert result.hard_count == 0

def test_missing_result_json_fails(tmp_path: Path) -> None:
    (tmp_path / "jobs" / "empty-job").mkdir(parents=True)

    result = _analyze(tmp_path)

    assert not result.is_success
    assert result.fatal_errors == ("No result.json found under jobs directory",)


def test_zero_trials_fails(tmp_path: Path) -> None:
    _write_job(tmp_path, n_trials=0, n_errors=0)

    result = _analyze(tmp_path)

    assert not result.is_success
    assert result.fatal_errors == ("No trials ran",)
