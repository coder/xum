from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor.trial.trial import AgentTimeoutError

from .mux_agent import MuxAgent
from .mux_payload import build_app_archive


@pytest.fixture(autouse=True)
def _clear_mux_env(monkeypatch: pytest.MonkeyPatch) -> None:
    keys = (*MuxAgent._PROVIDER_ENV_KEYS, *MuxAgent._CONFIG_ENV_KEYS)
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class _RunnerSmokeResult:
    completed: subprocess.CompletedProcess[str]
    log_dir: Path
    token_file: Path
    timeout_marker: Path
    args_file: Path


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def _run_mux_runner_smoke(
    tmp_path: Path,
    *,
    exit_code: int,
    goal_mode: str | None = None,
    timeout_ms: str | None = None,
) -> _RunnerSmokeResult:
    app_root = tmp_path / "app"
    project_path = tmp_path / "project"
    fake_bun_root = tmp_path / "bun-root"
    fake_bin = fake_bun_root / "bin"
    log_dir = tmp_path / "logs" / "agent" / "command-0"
    token_file = tmp_path / "mux-tokens.json"
    args_file = tmp_path / "bun-args.txt"
    timeout_marker = tmp_path / "timeout-invoked.txt"

    app_root.mkdir()
    project_path.mkdir()
    fake_bin.mkdir(parents=True)

    _write_executable(
        fake_bin / "bun",
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "src/cli/trust.ts" ]]; then
  printf '%s\n' "$*" >"${FAKE_BUN_ARGS_FILE}.trust"
  exit 0
fi
printf '%s\n' "$*" >"${FAKE_BUN_ARGS_FILE}"
cat >/dev/null
printf '{"type":"run-complete","usage":{"inputTokens":7,"outputTokens":11,"cachedTokens":5,"cacheCreateTokens":3},"cost_usd":0.42}\n'
exit "${FAKE_MUX_EXIT_CODE}"
""",
    )
    _write_executable(
        fake_bin / "timeout",
        """#!/usr/bin/env bash
set -euo pipefail
printf 'timeout invoked\n' >"${FAKE_TIMEOUT_MARKER}"
exit 99
""",
    )

    env = os.environ.copy()
    env.update(
        {
            "BUN_INSTALL": str(fake_bun_root),
            "FAKE_BUN_ARGS_FILE": str(args_file),
            "FAKE_MUX_EXIT_CODE": str(exit_code),
            "FAKE_TIMEOUT_MARKER": str(timeout_marker),
            "MUX_APP_ROOT": str(app_root),
            "MUX_LOG_DIR": str(log_dir),
            "MUX_PROJECT_PATH": str(project_path),
            "MUX_TOKEN_FILE": str(token_file),
            "PATH": f"{fake_bin}{os.pathsep}{env.get('PATH', '')}",
        }
    )
    if goal_mode is not None:
        env["MUX_RUN_AS_GOAL"] = goal_mode
    if timeout_ms is not None:
        env["MUX_TIMEOUT_MS"] = timeout_ms

    runner_path = _repo_root() / "benchmarks/terminal_bench/mux-run.sh"
    completed = subprocess.run(
        ["bash", str(runner_path), "solve it"],
        capture_output=True,
        env=env,
        text=True,
        check=False,
        timeout=10,
    )

    return _RunnerSmokeResult(
        completed=completed,
        log_dir=log_dir,
        token_file=token_file,
        timeout_marker=timeout_marker,
        args_file=args_file,
    )


def test_env_defaults_are_normalized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, model_name="anthropic/claude-sonnet-4-5")

    env = agent._env

    assert env["MUX_MODEL"] == "anthropic:claude-sonnet-4-5"
    assert env["MUX_PROJECT_CANDIDATES"] == agent._DEFAULT_PROJECT_CANDIDATES


def test_goal_mode_env_is_forwarded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "true")

    agent = MuxAgent(logs_dir=tmp_path)

    assert agent._env["MUX_RUN_AS_GOAL"] == "1"


def test_goal_mode_defaults_to_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))

    agent = MuxAgent(logs_dir=tmp_path)

    assert "MUX_RUN_AS_GOAL" not in agent._env


def test_goal_mode_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "yes")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError, match="MUX_RUN_AS_GOAL"):
        _ = agent._env


def test_timeout_must_be_numeric(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_TIMEOUT_MS", "not-a-number")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError):
        _ = agent._env


def test_timeout_kwarg_is_instance_local(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))

    agent = MuxAgent(logs_dir=tmp_path, timeout=1)

    assert os.environ.get("MUX_TIMEOUT_MS") is None
    assert agent._env["MUX_TIMEOUT_MS"] == "1000"
    assert "MUX_TIMEOUT_MS" not in MuxAgent(logs_dir=tmp_path / "other")._env


def test_mux_runner_scores_goal_mode_incomplete_exit(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=3, goal_mode="1")

    assert result.completed.returncode == 0, result.completed.stderr
    assert "WARNING: mux goal run stopped incomplete" in result.completed.stderr
    args = result.args_file.read_text()
    assert "--goal" in args
    assert "solve it" in args
    # Trust must be granted (against the resolved project dir) before the
    # agent starts, or sub-agent spawns fail the trust gate inside the run.
    trust_args = Path(f"{result.args_file}.trust").read_text()
    assert "src/cli/trust.ts" in trust_args
    assert str(tmp_path / "project") in trust_args
    assert json.loads(result.token_file.read_text()) == {
        "input": 7,
        "output": 11,
        "cache_read": 5,
        "cache_write": 3,
        "cost_usd": 0.42,
    }
    stdout_event = json.loads((result.log_dir / "stdout.txt").read_text())
    assert stdout_event["type"] == "run-complete"


def test_mux_runner_preserves_incomplete_exit_outside_goal_mode(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=3)

    assert result.completed.returncode == 3
    assert "mux agent session failed (exit 3)" in result.completed.stderr
    assert result.token_file.exists()


def test_mux_runner_preserves_fatal_exit(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=1, goal_mode="1")

    assert result.completed.returncode == 1
    assert "mux agent session failed (exit 1)" in result.completed.stderr
    assert "WARNING: mux goal run stopped incomplete" not in result.completed.stderr
    assert json.loads(result.token_file.read_text()) == {
        "input": 7,
        "output": 11,
        "cache_read": 5,
        "cache_write": 3,
        "cost_usd": 0.42,
    }


def test_mux_runner_leaves_timeout_to_harbor(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=0, timeout_ms="1000")

    assert result.completed.returncode == 0, result.completed.stderr
    assert "Harbor remains timeout authority" in result.completed.stdout
    assert not result.timeout_marker.exists()


@dataclass
class _ExecResult:
    return_code: int
    stdout: str = ""
    stderr: str = ""


class _FakeEnvironment:
    def __init__(
        self,
        result: _ExecResult,
        command_dir: Path | None = None,
        delay_sec: float = 0,
    ) -> None:
        self.result = result
        self.command_dir = command_dir
        self.delay_sec = delay_sec
        self.download_attempts: list[tuple[str, Path]] = []

    async def exec(self, **_kwargs: object) -> _ExecResult:
        timeout_sec = _kwargs.get("timeout_sec")
        if self.delay_sec:
            if isinstance(timeout_sec, (int, float)) and timeout_sec < self.delay_sec:
                await asyncio.sleep(timeout_sec)
                raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
            await asyncio.sleep(self.delay_sec)
        if self.command_dir is not None:
            stdout_path = self.command_dir / MuxAgent._COMMAND_STDOUT_NAME
            stderr_path = self.command_dir / MuxAgent._COMMAND_STDERR_NAME
            assert stdout_path.exists()
            assert stderr_path.exists()
            stdout_path.write_text("sandbox out")
            stderr_path.write_text("sandbox err")
        return self.result

    async def download_file(self, source_path: str, target_path: Path) -> None:
        self.download_attempts.append((source_path, target_path))
        target_path.write_text('{"input": 7, "output": 11, "cost_usd": 0.42}')


def test_run_raises_after_preserving_logs_for_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=7, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="mux agent command failed"):
        asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "7"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"
    assert environment.download_attempts == [
        (agent._TOKEN_FILE_PATH, tmp_path / "mux-tokens.json")
    ]
    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_run_timeout_surfaces_agent_timeout_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err"),
        delay_sec=0.05,
    )
    context = SimpleNamespace()

    with pytest.raises(AgentTimeoutError, match="timed out after 0.01 seconds"):
        asyncio.run(agent.run("do the task", environment, context))

    assert environment.download_attempts == [
        (agent._TOKEN_FILE_PATH, tmp_path / "mux-tokens.json")
    ]
    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_run_maps_near_timeout_return_code_124_to_agent_timeout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=124, stdout="partial event", stderr=""),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(AgentTimeoutError, match="timed out after 0.01 seconds"):
        asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "124"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "partial event"


def test_run_keeps_fast_return_code_124_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=10)
    environment = _FakeEnvironment(_ExecResult(return_code=124))
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="exit 124"):
        asyncio.run(agent.run("do the task", environment, context))


@pytest.mark.parametrize("return_code", [1, 137])
def test_run_keeps_non_timeout_agent_exits_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, return_code: int
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=return_code, stdout="partial event", stderr=""),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match=f"exit {return_code}"):
        asyncio.run(agent.run("do the task", environment, context))


def test_run_keeps_explicit_return_code_124_failure_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(
            return_code=124,
            stdout="partial event",
            stderr="[mux-run] ERROR: mux agent session failed (exit 124)",
        ),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="exit 124"):
        asyncio.run(agent.run("do the task", environment, context))


def test_run_preseeds_command_logs_before_sandbox_exec(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    command_dir = tmp_path / "command-0"
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err"),
        command_dir=command_dir,
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"


def test_run_populates_context_for_successful_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "0"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"
    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_app_archive_includes_postinstall_script() -> None:
    assert "scripts/postinstall.sh" in MuxAgent._INCLUDE_PATHS

    repo_root = _repo_root()
    postinstall = repo_root / "scripts/postinstall.sh"
    assert postinstall.is_file()

    archive_bytes = build_app_archive(repo_root, ["scripts/postinstall.sh"])
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        assert "scripts/postinstall.sh" in archive.getnames()
