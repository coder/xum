#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[mux-run] %s\n' "$1"
}

fatal() {
  printf '[mux-run] ERROR: %s\n' "$1" >&2
  exit 1
}

instruction=${1:-}
if [[ -z "${instruction}" ]]; then
  fatal "instruction argument is required"
fi

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

MUX_APP_ROOT="${MUX_APP_ROOT:-/opt/mux-app}"

# Prefer an explicit MUX_CONFIG_ROOT, but fall back to MUX_ROOT for callers that
# only override the mux home via MUX_ROOT.
MUX_CONFIG_ROOT="${MUX_CONFIG_ROOT:-${MUX_ROOT:-/root/.mux}}"

# Export MUX_ROOT so mux's getMuxHome() finds providers.jsonc and other config.
# Don't clobber caller-provided MUX_ROOT (e.g. local runs/tests with a custom root).
export MUX_ROOT="${MUX_ROOT:-${MUX_CONFIG_ROOT}}"
MUX_PROJECT_PATH="${MUX_PROJECT_PATH:-}"
MUX_PROJECT_CANDIDATES="${MUX_PROJECT_CANDIDATES:-/workspace:/app:/workspaces:/root/project}"
MUX_MODEL="${MUX_MODEL:-anthropic:claude-sonnet-4-5}"
MUX_TIMEOUT_MS="${MUX_TIMEOUT_MS:-}"
MUX_WORKSPACE_ID="${MUX_WORKSPACE_ID:-mux-bench}"
MUX_EXPERIMENTS="${MUX_EXPERIMENTS:-}"
MUX_RUN_AS_GOAL="${MUX_RUN_AS_GOAL:-}"

mux_run_as_goal_normalized="${MUX_RUN_AS_GOAL,,}"
mux_run_as_goal_normalized="${mux_run_as_goal_normalized#"${mux_run_as_goal_normalized%%[![:space:]]*}"}"
mux_run_as_goal_normalized="${mux_run_as_goal_normalized%"${mux_run_as_goal_normalized##*[![:space:]]}"}"
case "${mux_run_as_goal_normalized}" in
  "" | "0" | "false") mux_run_as_goal_enabled=0 ;;
  "1" | "true") mux_run_as_goal_enabled=1 ;;
  *) fatal "MUX_RUN_AS_GOAL must be one of: 1, true, 0, false" ;;
esac

resolve_project_path() {
  if [[ -n "${MUX_PROJECT_PATH}" ]]; then
    if [[ -d "${MUX_PROJECT_PATH}" ]]; then
      printf '%s\n' "${MUX_PROJECT_PATH}"
      return 0
    fi
    fatal "MUX_PROJECT_PATH=${MUX_PROJECT_PATH} not found"
  fi

  IFS=":" read -r -a candidates <<<"${MUX_PROJECT_CANDIDATES}"
  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  fatal "no project path located (searched ${MUX_PROJECT_CANDIDATES})"
}

command -v bun >/dev/null 2>&1 || fatal "bun is not installed"
project_path=$(resolve_project_path)

log "starting mux agent session for ${project_path}"
cd "${MUX_APP_ROOT}"

# Grant project trust before the agent starts: sub-agent workspace creation
# (task/task_spawn) is hard-gated on trust, and an untrusted benchmark project
# silently strips delegation from every trial. Fatal on failure so a broken
# config root surfaces as an infra error instead of an invisible handicap.
log "trusting project ${project_path}"
bun src/cli/trust.ts --dir "${project_path}" || fatal "failed to trust project ${project_path}"

cmd=(bun src/cli/run.ts
  --dir "${project_path}"
  --model "${MUX_MODEL}"
  --keep-background-processes
  --json)

# Add experiment flags (comma-separated → repeated --experiment flags)
if [[ -n "${MUX_EXPERIMENTS}" ]]; then
  IFS=',' read -r -a experiments <<<"${MUX_EXPERIMENTS}"
  for exp in "${experiments[@]}"; do
    # Trim whitespace
    exp="${exp#"${exp%%[![:space:]]*}"}"
    exp="${exp%"${exp##*[![:space:]]}"}"
    if [[ -n "${exp}" ]]; then
      cmd+=(--experiment "${exp}")
    fi
  done
fi

if [[ "${mux_run_as_goal_enabled}" == "1" ]]; then
  log "strict mux goal mode enabled"
  cmd+=(--goal "${instruction}")
fi

mux_run_args=()
# Append arbitrary mux run flags (e.g., --thinking high --mode exec --use-1m --budget 5.00)
if [[ -n "${MUX_RUN_ARGS:-}" ]]; then
  # Word-split intentional: MUX_RUN_ARGS contains space-separated CLI flags.
  # shellcheck disable=SC2206
  mux_run_args=(${MUX_RUN_ARGS})
  if [[ "${mux_run_as_goal_enabled}" == "1" ]]; then
    for arg in "${mux_run_args[@]}"; do
      if [[ "${arg}" == "--goal" || "${arg}" == --goal=* ]]; then
        fatal "MUX_RUN_ARGS must not include --goal when MUX_RUN_AS_GOAL is enabled"
      fi
    done
  fi
  cmd+=("${mux_run_args[@]}")
fi

# NOTE: Harbor only automatically collects /logs/agent on timeouts.
# Persist stdout/stderr there so partial agent output survives cancellation.
MUX_LOG_DIR="${MUX_LOG_DIR:-/logs/agent/command-0}"
mkdir -p "${MUX_LOG_DIR}"
MUX_OUTPUT_FILE="${MUX_LOG_DIR}/stdout.txt"
MUX_STDERR_FILE="${MUX_LOG_DIR}/stderr.txt"
MUX_TOKEN_FILE="${MUX_TOKEN_FILE:-/tmp/mux-tokens.json}"

# Let Harbor classify task timeouts; GNU timeout would surface as exit 124.
if [[ -n "${MUX_TIMEOUT_MS}" ]]; then
  if [[ ! "${MUX_TIMEOUT_MS}" =~ ^[0-9]+$ ]]; then
    fatal "MUX_TIMEOUT_MS must be an integer"
  fi
  log "MUX_TIMEOUT_MS=${MUX_TIMEOUT_MS} forwarded; Harbor remains timeout authority"
fi

# Capture output to file while streaming to terminal for token extraction.
# Keep stderr separate so the stdout log stays valid JSONL.
set +e
printf '%s' "${instruction}" \
  | "${cmd[@]}" \
    2> >(tee "${MUX_STDERR_FILE}" >&2) \
  | tee "${MUX_OUTPUT_FILE}"
pipeline_status=("${PIPESTATUS[@]}")
set -e
stdin_status="${pipeline_status[0]}"
mux_status="${pipeline_status[1]}"
tee_status="${pipeline_status[2]}"

# Extract usage and cost from the JSONL output.
# Prefer the run-complete event (emitted at end of --json run) which has aggregated
# totals. Fall back to summing usage-delta + session-usage-delta events when
# run-complete is missing (e.g. process killed by timeout, stdout not flushed).
python3 -c '
import json, sys
result = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost_usd": None}
# Track cumulative usage from usage-delta events (keyed by messageId).
# Each usage-delta contains cumulative totals for its message, so we keep the
# latest per message and sum across messages at the end.
cumulative_by_msg = {}
# Track sub-agent usage from session-usage-delta events. These carry per-model
# byModelDelta dicts with {input: {tokens, cost_usd}, output: {tokens, cost_usd}, ...}.
# Each event is an incremental delta, so we sum them all.
subagent_input = 0
subagent_output = 0
for line in open(sys.argv[1]):
    try:
        obj = json.loads(line)
        if obj.get("type") == "run-complete":
            usage = obj.get("usage") or {}
            result["input"] = usage.get("inputTokens", 0) or 0
            result["output"] = usage.get("outputTokens", 0) or 0
            # run-complete reports cache traffic separately from (uncached) input.
            result["cache_read"] = usage.get("cachedTokens", 0) or 0
            result["cache_write"] = usage.get("cacheCreateTokens", 0) or 0
            result["cost_usd"] = obj.get("cost_usd")
            print(json.dumps(result))
            sys.exit(0)
        # Nested event wrapper: {"type":"event","payload":{"type":"usage-delta",...}}
        payload = obj.get("payload") or obj
        if payload.get("type") == "usage-delta":
            msg_id = payload.get("messageId", "")
            # Prefer cumulativeUsage (running total across all steps in a message)
            # over usage (per-step delta). Keeping the latest cumulative per message
            # gives the correct total when summed across messages.
            usage = payload.get("cumulativeUsage") or payload.get("usage") or {}
            cumulative_by_msg[msg_id] = usage
        elif payload.get("type") == "session-usage-delta":
            for model_usage in (payload.get("byModelDelta") or {}).values():
                subagent_input += (model_usage.get("input") or {}).get("tokens", 0)
                subagent_output += (model_usage.get("output") or {}).get("tokens", 0)
    except Exception:
        pass
# No run-complete found — aggregate the last usage-delta per message + sub-agent totals
for usage in cumulative_by_msg.values():
    result["input"] += (usage.get("inputTokens", 0) or 0)
    result["output"] += (usage.get("outputTokens", 0) or 0)
    # AI SDK usage shape only exposes cache reads; cache writes stay 0 here.
    result["cache_read"] += (usage.get("cachedInputTokens", 0) or 0)
result["input"] += subagent_input
result["output"] += subagent_output
print(json.dumps(result))
' "${MUX_OUTPUT_FILE}" >"${MUX_TOKEN_FILE}" 2>/dev/null || true

if [[ "${mux_status}" -eq 3 && "${mux_run_as_goal_enabled}" == "1" ]]; then
  printf '[mux-run] WARNING: mux goal run stopped incomplete (exit 3); leaving workspace for verifier scoring\n' >&2
  mux_status=0
fi

if [[ "${mux_status}" -ne 0 ]]; then
  printf '[mux-run] ERROR: mux agent session failed (exit %s)\n' "${mux_status}" >&2
  exit "${mux_status}"
fi

if [[ "${tee_status}" -ne 0 ]]; then
  printf '[mux-run] ERROR: failed to capture mux stdout (exit %s)\n' "${tee_status}" >&2
  exit "${tee_status}"
fi

if [[ "${stdin_status}" -ne 0 ]]; then
  printf '[mux-run] ERROR: failed to send instruction to mux (exit %s)\n' "${stdin_status}" >&2
  exit "${stdin_status}"
fi
