/**
 * Process-wide kill-switch for automatic repo-controlled code execution:
 * .xum/init hooks and bash tool hooks (tool_env/tool_pre/tool_post).
 *
 * Benchmark harnesses (benchmarks/terminal_bench/mux-run.sh) set this when
 * running dataset-controlled repos: the project needs config trust so
 * sub-agent delegation works, but repo-supplied hooks must not execute
 * automatically with provider credentials in the environment.
 */
export const DISABLE_PROJECT_HOOKS_ENV = "MUX_DISABLE_PROJECT_HOOKS";

export function projectHooksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISABLE_PROJECT_HOOKS_ENV] === "1";
}
