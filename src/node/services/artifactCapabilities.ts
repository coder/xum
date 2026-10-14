/**
 * Runtime capability probes for the Artifacts tab (experiment: "artifacts").
 *
 * The agent checks its own HTML artifacts with `agent-browser` when the runtime has it; the tab
 * warns on HTML artifacts when it does not. One `command -v` exec per workspace, cached for the
 * backend process lifetime. The probe runs like the agent's bash tool: in the workspace's
 * execution cwd and, for trusted projects, after sourcing `.xum/tool_env` (Nix shells, venvs and
 * project-local bins often put agent-browser on PATH only there). The cache key includes the
 * runtime config and the trust state, so recreating a workspace on a different runtime or
 * trusting the project probes again. Failures (timeouts, unreachable runtimes, a tool_env that
 * fails to source) are not cached: they report null ("unknown") and the next request probes
 * again.
 */
import { assert } from "@/common/utils/assert";
import type { ArtifactCapabilities } from "@/common/orpc/schemas/artifacts";
import { getToolEnvPath } from "@/node/services/hooks";
import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { execBuffered } from "@/node/utils/runtime/helpers";

export const AGENT_BROWSER_PROBE_TIMEOUT_SECONDS = 5;

/** Same variable name the bash tool uses to hand the tool_env path to its prelude. */
const PROBE_TOOL_ENV_PATH_ENV = "XUM_INTERNAL_TOOL_ENV_PATH";
/** Exit code for "tool_env failed to source": not an answer, so never cached. */
const TOOL_ENV_FAILED_EXIT = 3;

/** true/false from the exit code; null when the probe could not run or timed out. */
export async function probeAgentBrowser(
  runtime: Runtime,
  options: { cwd?: string; toolEnvPath?: string | null } = {}
): Promise<boolean | null> {
  const prelude = options.toolEnvPath
    ? `. "$${PROBE_TOOL_ENV_PATH_ENV}" >/dev/null 2>&1 </dev/null || exit ${TOOL_ENV_FAILED_EXIT}\n`
    : "";
  try {
    const result = await execBuffered(
      runtime,
      `${prelude}command -v agent-browser >/dev/null 2>&1`,
      {
        cwd: options.cwd ?? "/",
        pathEnv: options.toolEnvPath
          ? { [PROBE_TOOL_ENV_PATH_ENV]: options.toolEnvPath }
          : undefined,
        timeout: AGENT_BROWSER_PROBE_TIMEOUT_SECONDS,
        maxOutputBytes: 4096,
      }
    );
    if (result.exitCode === 0) return true;
    // `command -v` exits 1 (127 in some shells) for a missing command; negative codes are the
    // runtime's own timeout/abort sentinels, and anything else is not a clean answer.
    if (result.exitCode === 1 || result.exitCode === 127) return false;
    return null;
  } catch (error) {
    log.debug("agent-browser probe failed", { error });
    return null;
  }
}

export class AgentBrowserProbeCache {
  private readonly results = new Map<string, boolean>();
  private readonly inFlight = new Map<string, Promise<boolean | null>>();

  async get(
    workspaceId: string,
    runtimeKey: string,
    probe: () => Promise<boolean | null>
  ): Promise<boolean | null> {
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    const key = `${workspaceId}\u0000${runtimeKey}`;
    const cached = this.results.get(key);
    if (cached !== undefined) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;
    // Promise.resolve().then: a probe that throws synchronously still lands in catch.
    const promise = Promise.resolve()
      .then(probe)
      .catch(() => null)
      .then((value) => {
        if (value !== null) this.results.set(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}

/** Process-lifetime cache shared by every artifacts.capabilities request. */
export const agentBrowserProbeCache = new AgentBrowserProbeCache();

export async function getArtifactCapabilities(input: {
  workspaceId: string;
  runtimeKey: string;
  createRuntime: () => Runtime;
  /** The bash tool's cwd for this workspace; tool_env lookup starts here. Default "/". */
  resolveCwd?: (runtime: Runtime) => string;
  /** Source tool_env like the bash tool does; only for trusted projects (repo-controlled code). */
  trusted?: boolean;
  cache?: AgentBrowserProbeCache;
}): Promise<ArtifactCapabilities> {
  const cache = input.cache ?? agentBrowserProbeCache;
  // projectAutomationDisabled: the benchmark kill switch keeps config-trusted dataset repos from
  // running repo code (tool_env) automatically, like agent turns (turnRequestBuilder.ts).
  const trusted = (input.trusted ?? false) && !projectAutomationDisabled();
  const key = JSON.stringify([input.runtimeKey, trusted]);
  const agentBrowserAvailable = await cache.get(input.workspaceId, key, async () => {
    const runtime = input.createRuntime();
    const cwd = input.resolveCwd?.(runtime) ?? "/";
    const toolEnvPath = trusted ? await getToolEnvPath(runtime, cwd) : null;
    return probeAgentBrowser(runtime, { cwd, toolEnvPath });
  });
  return { agentBrowserAvailable };
}
