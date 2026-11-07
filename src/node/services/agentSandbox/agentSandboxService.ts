import {
  resolveAgentSandboxSettings,
  type AgentSandboxConfig,
  type ResolvedAgentSandboxSettings,
} from "@/common/config/schemas/agentSandbox";
import type { AgentSandboxState, AgentSandboxSupport } from "@/common/orpc/schemas/agentSandbox";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import {
  anyAgentSandboxEnabled,
  setAgentSandboxTargets,
} from "@/node/runtime/sandbox/agentSandboxTargets";
import {
  ensureAgentSandboxRuntime,
  isAgentSandboxSupported,
  resetAgentSandboxRuntime,
} from "@/node/runtime/sandbox/macosSandbox";
import { log } from "@/node/services/log";

/**
 * Keeps the policy of every agent command in line with the `agentSandbox` settings: at startup,
 * after every config change, and when a setting is saved. Agent tools cannot reach set() or
 * setProject(): only the Settings UI calls them.
 */
export class AgentSandboxService {
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly config: Config) {}

  async start(): Promise<void> {
    this.unsubscribe ??= this.config.onConfigChanged(() => {
      void this.apply();
    });
    await this.apply();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await resetAgentSandboxRuntime();
  }

  get(): AgentSandboxState {
    const config = this.config.loadConfigOrDefault();
    const projects: AgentSandboxState["projects"] = {};
    for (const [projectPath, project] of config.projects) {
      if (project.agentSandbox !== undefined) projects[projectPath] = project.agentSandbox;
    }
    return { global: config.agentSandbox ?? {}, projects, support: agentSandboxSupport() };
  }

  async set(sandbox: AgentSandboxConfig): Promise<AgentSandboxState> {
    await this.config.updateAgentSandbox(sandbox);
    await this.apply();
    return this.get();
  }

  async setProject(projectPath: string, sandbox: AgentSandboxConfig): Promise<AgentSandboxState> {
    await this.config.updateProjectAgentSandbox(projectPath, sandbox);
    await this.apply();
    return this.get();
  }

  /**
   * Publishes the setting of every project before any await, so the next command already gets
   * it. Starting srt's proxy cannot crash startup: a failure is logged, and sandboxed commands
   * then fail closed in wrapForAgentSandbox(), which retries the start.
   */
  private async apply(): Promise<void> {
    const config = this.config.loadConfigOrDefault();
    const byProject = new Map<string, ResolvedAgentSandboxSettings>();
    for (const [projectPath, project] of config.projects) {
      // A sub-project without an override of its own follows its parent's.
      const override =
        project.agentSandbox ??
        (project.parentProjectPath === undefined
          ? undefined
          : config.projects.get(project.parentProjectPath)?.agentSandbox);
      if (override !== undefined) {
        byProject.set(projectPath, resolveAgentSandboxSettings(config.agentSandbox, override));
      }
    }
    setAgentSandboxTargets({
      fallback: resolveAgentSandboxSettings(config.agentSandbox, undefined),
      byProject,
    });
    if (!anyAgentSandboxEnabled() || !isAgentSandboxSupported()) return;
    try {
      await ensureAgentSandboxRuntime();
    } catch (error) {
      log.warn("The agent sandbox could not start", { reason: getErrorMessage(error) });
    }
  }
}

function agentSandboxSupport(): AgentSandboxSupport {
  if (isAgentSandboxSupported()) return { state: "supported" };
  return {
    state: "unsupported",
    reason:
      process.platform === "darwin"
        ? "/usr/bin/sandbox-exec is missing on this Mac."
        : "Available on macOS only.",
  };
}
