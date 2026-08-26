/**
 * Process-wide kill-switch for automatic repo-controlled automation:
 * .xum/init hooks, bash tool hooks (tool_env/tool_pre/tool_post),
 * project-local MCP servers (.xum/mcp.jsonc), and project plugin
 * containers (.xum/plugins hooks/commands/MCP).
 *
 * Benchmark harnesses (benchmarks/terminal_bench/mux-run.sh) set this when
 * running dataset-controlled repos: the project needs config trust so
 * sub-agent delegation works, but repo-supplied processes must not execute
 * automatically with provider credentials in the environment.
 */
export const DISABLE_PROJECT_AUTOMATION_ENV = "MUX_DISABLE_PROJECT_AUTOMATION";

export function projectAutomationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISABLE_PROJECT_AUTOMATION_ENV] === "1";
}
