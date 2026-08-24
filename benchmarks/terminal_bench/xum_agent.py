from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.trial.trial import AgentTimeoutError

from .xum_run_contract import (
    XUM_RUN_TIMEOUT_FAILURE_MARKER,
    RUN_COMPLETE_MARKER,
    TIMEOUT_RETURN_CODE,
)
from .xum_payload import build_app_archive


@dataclass(frozen=True)
class _AgentCommand:
    command: str
    env: dict[str, str]
    cwd: str | None = None
    timeout_sec: float | None = None


class XumAgent(BaseInstalledAgent):
    """
    Minimal Terminal-Bench adapter that installs Xum into the task container and
    forwards the benchmark instruction to the Xum headless runner.
    """

    _ARCHIVE_NAME = "xum-app.tar.gz"
    _RUNNER_NAME = "xum-run.sh"
    _SETUP_SCRIPT_NAME = "xum_setup.sh"
    _COMMAND_STDOUT_NAME = "stdout.txt"
    _COMMAND_STDERR_NAME = "stderr.txt"
    _DEFAULT_MODEL = "anthropic:claude-sonnet-4-5"
    _DEFAULT_PROJECT_CANDIDATES = "/workspace:/app:/workspaces:/root/project"
    _INCLUDE_PATHS: Sequence[str] = (
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "tsconfig.json",
        "tsconfig.main.json",
        "src",
        "dist",
        "scripts/postinstall.sh",
    )

    _PROVIDER_ENV_KEYS: Sequence[str] = (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_ORG_ID",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
        # Google provider uses either GOOGLE_GENERATIVE_AI_API_KEY or the legacy
        # GOOGLE_API_KEY env var. Forward both (and base URL override) into the
        # sandbox to avoid confusing "api_key_not_found" failures.
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_BASE_URL",
    )

    _CONFIG_ENV_SUFFIXES: Sequence[str] = (
        "AGENT_GIT_URL",
        "BUN_INSTALL_URL",
        "PROJECT_PATH",
        "PROJECT_CANDIDATES",
        "MODEL",
        "TIMEOUT_MS",
        "CONFIG_ROOT",
        "APP_ROOT",
        "WORKSPACE_ID",
        "EXPERIMENTS",
        # Generic pass-through for arbitrary Xum run CLI flags (e.g., --thinking
        # high --use-1m --budget 5.00). Avoids per-flag plumbing.
        "RUN_ARGS",
        "RUN_AS_GOAL",
    )
    _CONFIG_ENV_KEYS: Sequence[str] = tuple(
        f"XUM_{suffix}" for suffix in _CONFIG_ENV_SUFFIXES
    )
    # Terminal-Bench jobs may still inject the pre-rename names. Read them only
    # as fallback and emit canonical XUM_* names into the task environment.
    _LEGACY_CONFIG_ENV_KEYS: Sequence[str] = tuple(
        f"MUX_{suffix}" for suffix in _CONFIG_ENV_SUFFIXES
    )

    def __init__(
        self,
        logs_dir: Path,
        model_name: str = "anthropic:claude-sonnet-4-5",
        experiments: str | None = None,
        timeout: float | int | str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self._timeout_sec = self._parse_timeout_sec(timeout)
        self._timeout_ms = (
            str(round(self._timeout_sec * 1000))
            if self._timeout_sec is not None
            else None
        )
        repo_root_env = self._environment_alias_value(
            "XUM_AGENT_REPO_ROOT",
            "MUX_AGENT_REPO_ROOT",
        )
        repo_root = (
            Path(repo_root_env).resolve()
            if repo_root_env
            else Path(__file__).resolve().parents[2]
        )
        if not repo_root.exists():
            raise RuntimeError(f"xum repo root {repo_root} does not exist")

        runner_path = Path(__file__).with_name(self._RUNNER_NAME)
        if not runner_path.is_file():
            raise RuntimeError(f"xum runner script missing at {runner_path}")

        self._runner_path = runner_path
        self._repo_root = repo_root
        self._archive_bytes: bytes | None = None
        self._model_name = (model_name or "").strip()
        self._experiments = (experiments or "").strip() if experiments else None
        self._last_environment: BaseEnvironment | None = None

    @staticmethod
    def name() -> str:
        return "xum"

    @staticmethod
    def _environment_alias_value(canonical_key: str, legacy_key: str) -> str | None:
        """Prefer the canonical key by presence so an empty value clears legacy state."""
        if canonical_key in os.environ:
            return os.environ[canonical_key]
        return os.environ.get(legacy_key)

    @property
    def _env(self) -> dict[str, str]:
        env: dict[str, str] = {}

        for key in self._PROVIDER_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                env[key] = value

        for suffix in self._CONFIG_ENV_SUFFIXES:
            canonical_key = f"XUM_{suffix}"
            legacy_key = f"MUX_{suffix}"
            # Presence, not truthiness, determines precedence: an explicit empty
            # canonical value must clear a legacy variable left in the developer shell.
            value = self._environment_alias_value(canonical_key, legacy_key)
            if value:
                env[canonical_key] = value

        env.setdefault("XUM_MODEL", self._DEFAULT_MODEL)
        env.setdefault("XUM_CONFIG_ROOT", "/root/.xum")
        env.setdefault("XUM_APP_ROOT", "/opt/xum-app")
        env.setdefault("XUM_WORKSPACE_ID", "xum-bench")
        env.setdefault("XUM_PROJECT_CANDIDATES", self._DEFAULT_PROJECT_CANDIDATES)
        if self._timeout_ms is not None:
            env["XUM_TIMEOUT_MS"] = self._timeout_ms

        model_value = self._model_name or env["XUM_MODEL"]
        model_value = model_value.strip()
        if not model_value:
            raise ValueError("XUM_MODEL must be a non-empty string")
        if "/" in model_value and ":" not in model_value:
            provider, model_name = model_value.split("/", 1)
            model_value = f"{provider}:{model_name}"

        # Fail fast for Google models if credentials weren't forwarded into the
        # sandbox env. Otherwise Harbor/Xum will fail later with a less actionable
        # "api_key_not_found" error.
        if model_value.startswith("google:") and not (
            env.get("GOOGLE_GENERATIVE_AI_API_KEY") or env.get("GOOGLE_API_KEY")
        ):
            raise ValueError(
                "Google models require GOOGLE_GENERATIVE_AI_API_KEY (preferred) or GOOGLE_API_KEY"
            )
        env["XUM_MODEL"] = model_value

        # These env vars are all set with defaults above, no need to validate
        for key in (
            "XUM_CONFIG_ROOT",
            "XUM_APP_ROOT",
            "XUM_WORKSPACE_ID",
            "XUM_PROJECT_CANDIDATES",
        ):
            env[key] = env[key].strip()

        if timeout_value := env.get("XUM_TIMEOUT_MS"):
            self._validate_timeout_ms(timeout_value)

        if project_path := env.get("XUM_PROJECT_PATH"):
            if not project_path.strip():
                raise ValueError("XUM_PROJECT_PATH must be non-empty when provided")

        xum_run_as_goal = self._normalize_xum_run_as_goal(env.get("XUM_RUN_AS_GOAL"))
        if xum_run_as_goal is None:
            env.pop("XUM_RUN_AS_GOAL", None)
        else:
            env["XUM_RUN_AS_GOAL"] = xum_run_as_goal

        # Set experiments from kwarg (takes precedence over env var)
        if self._experiments:
            env["XUM_EXPERIMENTS"] = self._experiments

        return env

    @staticmethod
    def _parse_timeout_sec(value: float | int | str | None) -> float | None:
        if value is None:
            return None

        timeout_sec = float(value)
        if timeout_sec <= 0:
            raise ValueError("timeout must be a positive number")
        return timeout_sec

    @staticmethod
    def _validate_timeout_ms(value: str) -> None:
        if not value.strip().isdigit():
            raise ValueError("XUM_TIMEOUT_MS must be an integer")

    @staticmethod
    def _normalize_xum_run_as_goal(value: str | None) -> str | None:
        if value is None:
            return None

        normalized = value.strip().lower()
        if normalized in ("", "0", "false"):
            return None
        if normalized in ("1", "true"):
            return "1"

        raise ValueError("XUM_RUN_AS_GOAL must be one of: 1, true, 0, false")

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("xum_setup.sh.j2")

    _PROVIDERS_FILE_ENV_KEY = "XUM_PROVIDERS_FILE"
    _LEGACY_PROVIDERS_FILE_ENV_KEY = "MUX_PROVIDERS_FILE"
    _TOKEN_FILE_PATH = "/tmp/xum-tokens.json"

    async def _stage_providers_config(
        self, environment: BaseEnvironment, env: dict[str, str]
    ) -> None:
        """Upload host providers.jsonc into the sandbox when explicitly requested."""
        providers_file_raw = self._environment_alias_value(
            self._PROVIDERS_FILE_ENV_KEY,
            self._LEGACY_PROVIDERS_FILE_ENV_KEY,
        )
        if not providers_file_raw:
            return

        providers_path = Path(providers_file_raw).expanduser().resolve()
        if not providers_path.is_file():
            raise RuntimeError(
                f"{self._PROVIDERS_FILE_ENV_KEY}={providers_path} is not a readable file"
            )

        xum_config_root = (
            env.get("XUM_CONFIG_ROOT") or "/root/.xum"
        ).strip() or "/root/.xum"
        target_path = f"{xum_config_root.rstrip('/')}/providers.jsonc"

        await environment.upload_file(
            source_path=providers_path,
            target_path=target_path,
        )

    def _agent_version(self) -> str:
        version_method = getattr(self, "version", None)
        if callable(version_method):
            return version_method() or ""
        version_value = getattr(self, "_version", "")
        return version_value if isinstance(version_value, str) else ""

    def _write_setup_script(self) -> Path:
        setup_script = self._install_agent_template_path.read_text().replace(
            "{{ version if version is not none else '' }}",
            self._agent_version(),
        )
        setup_path = self.logs_dir / self._SETUP_SCRIPT_NAME
        setup_path.write_text(setup_script)
        return setup_path

    async def install(self, environment: BaseEnvironment) -> None:
        """Run the staged xum setup script inside the task environment."""
        # The setup script may install apt packages and writes under /opt, so run
        # it as root even if Harbor's default agent user changes.
        result = await environment.exec(
            command=f"bash /installed-agent/{self._SETUP_SCRIPT_NAME}",
            env=self._env,
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError(
                "xum setup failed "
                f"(exit {result.return_code}):\nstdout: {result.stdout}\nstderr: {result.stderr}"
            )

    async def setup(self, environment: BaseEnvironment) -> None:
        """Stage the Xum payload before installing it in the task environment."""
        env = self._env

        # Harbor no longer renders installed-agent templates for custom agents.
        # Stage the rendered script ourselves so scheduled tbench runs are not
        # coupled to Harbor internals that have changed over time.
        await environment.exec(command="mkdir -p /installed-agent", user="root")

        if not self._archive_bytes:
            self._archive_bytes = build_app_archive(
                self._repo_root, self._INCLUDE_PATHS
            )

        archive_path = self.logs_dir / self._ARCHIVE_NAME
        archive_path.write_bytes(self._archive_bytes)
        await environment.upload_file(
            source_path=archive_path,
            target_path=f"/installed-agent/{self._ARCHIVE_NAME}",
        )

        await environment.upload_file(
            source_path=self._runner_path,
            target_path=f"/installed-agent/{self._RUNNER_NAME}",
        )

        await environment.upload_file(
            source_path=self._write_setup_script(),
            target_path=f"/installed-agent/{self._SETUP_SCRIPT_NAME}",
        )

        await self.install(environment)

        # Optionally seed the sandbox with providers.jsonc from the host machine.
        # This is required for OAuth-only configs where env var API keys are absent.
        await self._stage_providers_config(environment, env)

        # Store environment reference for token extraction later.
        self._last_environment = environment

    def create_run_agent_commands(self, instruction: str) -> list[_AgentCommand]:
        escaped = shlex.quote(instruction)
        command = f"bash /installed-agent/{self._RUNNER_NAME} {escaped}"
        return [
            _AgentCommand(command=command, env=self._env, timeout_sec=self._timeout_sec)
        ]

    async def _exec_agent_command(
        self,
        environment: BaseEnvironment,
        exec_input: _AgentCommand,
    ) -> ExecResult:
        try:
            return await environment.exec(
                command=exec_input.command,
                cwd=exec_input.cwd,
                env=exec_input.env,
                timeout_sec=exec_input.timeout_sec,
            )
        except asyncio.TimeoutError as exc:
            if exec_input.timeout_sec is None:
                raise
            raise self._agent_timeout_error(exec_input.timeout_sec) from exc
        except RuntimeError as exc:
            if exec_input.timeout_sec is not None and "timed out" in str(exc).lower():
                raise self._agent_timeout_error(exec_input.timeout_sec) from exc
            raise

    @staticmethod
    def _agent_timeout_error(timeout_sec: float) -> AgentTimeoutError:
        return AgentTimeoutError(
            f"Agent execution timed out after {timeout_sec:g} seconds"
        )

    @staticmethod
    def _is_exec_timeout_return(
        result: ExecResult,
        timeout_sec: float | None,
        elapsed_sec: float,
    ) -> bool:
        if timeout_sec is None or result.return_code != TIMEOUT_RETURN_CODE:
            return False

        assert timeout_sec > 0, "timeout_sec is validated when XumAgent is constructed"
        timeout_threshold = max(timeout_sec * 0.95, timeout_sec - 10)
        if elapsed_sec < timeout_threshold:
            return False

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        if RUN_COMPLETE_MARKER in stdout:
            return False
        if XUM_RUN_TIMEOUT_FAILURE_MARKER in stderr:
            return False

        return True

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run agent commands, download token file, then populate context."""
        # Execute commands (from base class logic, but without calling populate_context)
        failed_command: tuple[int, int] | None = None
        timeout_error: AgentTimeoutError | None = None
        for i, exec_input in enumerate(self.create_run_agent_commands(instruction)):
            command_dir = self.logs_dir / f"command-{i}"
            command_dir.mkdir(parents=True, exist_ok=True)
            (command_dir / "command.txt").write_text(exec_input.command)

            # /logs is bind-mounted; pre-create files so sandbox tee output
            # does not leave root-owned files that host-side log writes cannot replace.
            stdout_path = command_dir / self._COMMAND_STDOUT_NAME
            stderr_path = command_dir / self._COMMAND_STDERR_NAME
            for output_path in (stdout_path, stderr_path):
                output_path.write_text("")

            started_at = time.monotonic()
            try:
                result = await self._exec_agent_command(environment, exec_input)
            except AgentTimeoutError as exc:
                timeout_error = exc
                break
            elapsed_sec = time.monotonic() - started_at

            (command_dir / "return-code.txt").write_text(str(result.return_code))
            if result.stdout:
                stdout_path.write_text(result.stdout)
            if result.stderr:
                stderr_path.write_text(result.stderr)
            if self._is_exec_timeout_return(
                result, exec_input.timeout_sec, elapsed_sec
            ):
                assert exec_input.timeout_sec is not None
                timeout_error = self._agent_timeout_error(exec_input.timeout_sec)
                break
            if result.return_code != 0:
                failed_command = (i, result.return_code)
                break

        # Download token file from container BEFORE populating context
        # Clear any stale token file first to avoid reading outdated data if download fails
        token_file = self.logs_dir / "xum-tokens.json"
        token_file.unlink(missing_ok=True)
        try:
            await environment.download_file(self._TOKEN_FILE_PATH, token_file)
        except Exception:
            pass  # Token file may not exist if agent crashed early

        self.populate_context_post_run(context)

        if timeout_error is not None:
            raise timeout_error

        if failed_command is not None:
            command_index, return_code = failed_command
            raise RuntimeError(
                f"xum agent command failed (command {command_index}, exit {return_code})"
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Extract token usage and cost from the token file written by xum-run.sh."""
        token_file = self.logs_dir / "xum-tokens.json"
        if token_file.exists():
            try:
                data = json.loads(token_file.read_text())
                context.n_input_tokens = data.get("input", 0)
                context.n_output_tokens = data.get("output", 0)
                # cost_usd is computed by xum CLI from model pricing
                if data.get("cost_usd") is not None:
                    context.cost_usd = data["cost_usd"]
            except Exception:
                pass  # Token/cost extraction is best-effort
