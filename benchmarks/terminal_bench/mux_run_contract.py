from __future__ import annotations

TIMEOUT_RETURN_CODE = 124
OOM_LIKE_RETURN_CODE = 137
RUN_COMPLETE_MARKER = "run-complete"
MUX_RUN_FAILURE_MARKER = "[mux-run] ERROR: mux agent session failed"


def mux_run_failure_marker(return_code: int) -> str:
    return f"{MUX_RUN_FAILURE_MARKER} (exit {return_code})"


MUX_RUN_TIMEOUT_FAILURE_MARKER = mux_run_failure_marker(TIMEOUT_RETURN_CODE)
