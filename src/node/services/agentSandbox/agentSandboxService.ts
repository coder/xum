import {
  resolveAgentSandboxSettings,
  type AgentSandboxPatch,
  type ResolvedAgentSandboxSettings,
} from "@/common/config/schemas/agentSandbox";
import type { AgentSandboxState, AgentSandboxSupport } from "@/common/orpc/schemas/agentSandbox";
import { getErrorMessage } from "@/common/utils/errors";
import * as path from "node:path";
import { configFilePath, type Config, type ProjectsConfig } from "@/node/config";
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
  private readonly hiddenFiles: readonly string[];

  /**
   * `privateConfigRoot`: where `xum run` and `xum workflow` keep their copy of the keys and
   * settings. It is in the temp folder, which sandboxed commands can read and write.
   */
  constructor(
    private readonly config: Config,
    options: { privateConfigRoot?: string } = {}
  ) {
    this.hiddenFiles =
      options.privateConfigRoot === undefined ? [] : privateConfigFiles(options.privateConfigRoot);
  }

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

  async set(patch: AgentSandboxPatch): Promise<AgentSandboxState> {
    await this.config.updateAgentSandbox(patch);
    await this.apply();
    return this.get();
  }

  async setProject(projectPath: string, patch: AgentSandboxPatch): Promise<AgentSandboxState> {
    await this.config.updateProjectAgentSandbox(projectPath, patch);
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
    setAgentSandboxTargets({
      fallback: resolveAgentSandboxSettings(config.agentSandbox, undefined),
      byProject: projectAgentSandboxSettings(config),
      hiddenFiles: this.hiddenFiles,
    });
    if (!anyAgentSandboxEnabled() || !isAgentSandboxSupported()) return;
    try {
      await ensureAgentSandboxRuntime();
    } catch (error) {
      log.warn("The agent sandbox could not start", { reason: getErrorMessage(error) });
    }
  }
}

/** Also the temp files that writeFileAtomic() renames over each one, and config.json's backups. */
function privateConfigFiles(rootDir: string): string[] {
  return [
    configFilePath(rootDir),
    path.join(rootDir, "providers.jsonc"),
    path.join(rootDir, "secrets.json"),
  ].flatMap((file) => [file, `${file}.*`]);
}

/** The resolved setting of each project with an override. */
function projectAgentSandboxSettings(
  config: ProjectsConfig
): Map<string, ResolvedAgentSandboxSettings> {
  const byProject = new Map<string, ResolvedAgentSandboxSettings>();
  for (const [projectPath, project] of config.projects) {
    // A sub-project has its parent's setting, as it has its parent's resource limit: its
    // workspaces work in the parent's checkout, and their commands look the setting up by the
    // parent's path (agentCgroupProjectPath). Settings offers no sub-project setting, so one in
    // config.json would look applied and change nothing.
    if (project.parentProjectPath !== undefined && project.agentSandbox !== undefined) {
      log.warn(
        `Ignoring the agentSandbox setting of sub-project ${projectPath}: it has the setting of ${project.parentProjectPath}`
      );
    }
    const override =
      project.parentProjectPath === undefined
        ? project.agentSandbox
        : config.projects.get(project.parentProjectPath)?.agentSandbox;
    if (override !== undefined) {
      byProject.set(projectPath, resolveAgentSandboxSettings(config.agentSandbox, override));
    }
  }
  return byProject;
}

function agentSandboxSupport(): AgentSandboxSupport {
  if (isAgentSandboxSupported()) return { state: "supported" };
  // wrapForAgentSandbox throws on a Mac that cannot sandbox and skips the sandbox elsewhere.
  const onMac = process.platform === "darwin";
  return {
    state: "unsupported",
    reason: onMac ? "/usr/bin/sandbox-exec is missing on this Mac." : "Available on macOS only.",
    failsClosed: onMac,
  };
}
