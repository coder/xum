import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsState,
  AgentResourceLimitsStatus,
} from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import { setAgentCgroupEnrollmentTargets } from "@/node/runtime/agentCgroupEnrollment";
import { log } from "@/node/services/log";
import {
  applyAgentCgroupLimits,
  checkAgentCgroupSupport,
  linuxAgentCgroupHost,
  type AgentCgroupHost,
  type ProjectAgentResourceLimits,
} from "./agentCgroup";

/**
 * Keeps the agent cgroup in line with the `agentResourceLimits` and `agentResourceLimitsEnabled`
 * settings: at startup, after every config change, and when a setting is saved. Applies run one at
 * a time.
 */
export class AgentResourceLimitsService {
  private status: AgentResourceLimitsStatus = { state: "off" };
  /** The cgroup of each project with a limit of its own, while the limits are active. */
  private projectCgroups: ReadonlyMap<string, string> = new Map();
  /** The limits of the last apply, so unrelated config changes do not re-run it. */
  private appliedLimits: string | undefined;
  /** The limits that the last apply read, which a save does not reset. */
  private seenLimits: string | undefined;
  /** How many applies may have run sudo, so a user action does not run it twice. */
  private sudoApplies = 0;
  private applying: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly config: Config,
    private readonly host: AgentCgroupHost = linuxAgentCgroupHost
  ) {}

  async start(): Promise<void> {
    this.unsubscribe ??= this.config.onConfigChanged(() => {
      void this.apply(null);
    });
    await this.apply(this.sudoApplies);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The saved setting, its status, and what applying it takes, after the applies queued so far. */
  async get(): Promise<AgentResourceLimitsState> {
    await this.applying;
    const setting = this.readSetting();
    const projects: AgentResourceLimitsState["projects"] = {};
    for (const [projectPath, limits] of setting.projects) {
      const cgroup = this.projectCgroups.get(projectPath);
      projects[projectPath] = cgroup === undefined ? { limits } : { limits, cgroup };
    }
    return {
      enabled: setting.enabled,
      limits: setting.limits,
      projects,
      status: this.status,
      support: await checkAgentCgroupSupport(setting.limits, this.host),
    };
  }

  /** Saves `limits` and applies them, even when unchanged, so saving again retries a failure. */
  async set(limits: AgentResourceLimits): Promise<AgentResourceLimitsState> {
    const sudoApplies = this.sudoApplies;
    // The save notifies the config listener, whose apply then runs even for unchanged limits.
    this.appliedLimits = undefined;
    await this.config.updateAgentResourceLimits(limits);
    await this.apply(sudoApplies);
    return this.get();
  }

  /**
   * Saves the limits of one project and applies them, even when unchanged, so saving again retries
   * a failure. Empty `limits` remove the project's own limit.
   */
  async setProject(
    projectPath: string,
    limits: AgentResourceLimits
  ): Promise<AgentResourceLimitsState> {
    const sudoApplies = this.sudoApplies;
    this.appliedLimits = undefined;
    await this.config.updateProjectAgentResourceLimits(projectPath, limits);
    await this.apply(sudoApplies);
    return this.get();
  }

  /** Turns the saved limits on or off, without changing them. */
  async setEnabled(enabled: boolean): Promise<AgentResourceLimitsState> {
    const sudoApplies = this.sudoApplies;
    await this.config.updateAgentResourceLimitsEnabled(enabled);
    await this.apply(sudoApplies);
    return this.get();
  }

  private readSetting(): {
    enabled: boolean;
    limits: AgentResourceLimits;
    projects: ProjectAgentResourceLimits;
  } {
    const config = this.config.loadConfigOrDefault();
    const projects = new Map<string, AgentResourceLimits>();
    for (const [projectPath, project] of config.projects) {
      if (project.agentResourceLimits !== undefined) {
        projects.set(projectPath, project.agentResourceLimits);
      }
    }
    return {
      enabled: config.agentResourceLimitsEnabled === true,
      limits: config.agentResourceLimits ?? {},
      projects,
    };
  }

  /**
   * Applies the setting as it is when the apply runs. Sudo (see applyAgentCgroupLimits) runs for
   * a user action here, at startup, and for a config change that changed the limits, which
   * includes a save in another backend. A config change with the same limits does not run it, and
   * a user action does not run it again after its own save's config change did.
   *
   * @param sudoAppliesBeforeAction `sudoApplies` when the user action began, or null for a config
   *   change.
   */
  private apply(sudoAppliesBeforeAction: number | null): Promise<void> {
    this.applying = this.applying.then(async () => {
      const previous = this.status;
      try {
        const { enabled, limits, projects } = this.readSetting();
        // Off keeps the saved limits, also those of projects, but applies none.
        const applied = enabled ? limits : {};
        const appliedProjects: ProjectAgentResourceLimits = enabled ? projects : new Map();
        // The key holds the project limits too, so a save of one project applies.
        const key = JSON.stringify({ limits: applied, projects: [...appliedProjects] });
        const changed = key !== this.seenLimits;
        this.seenLimits = key;
        // Limits that failed to apply retry on any config change: Try again in another
        // backend's Settings saves them unchanged, and this backend sees only the change.
        if (key === this.appliedLimits && previous.state !== "unavailable") {
          return;
        }
        this.appliedLimits = key;
        const trySudo =
          sudoAppliesBeforeAction === null ? changed : this.sudoApplies === sudoAppliesBeforeAction;
        if (trySudo) {
          this.sudoApplies += 1;
        }
        const result = await applyAgentCgroupLimits(applied, this.host, {
          trySudo,
          projects: appliedProjects,
        });
        this.status = result.status;
        this.projectCgroups = result.projectCgroups;
        setAgentCgroupEnrollmentTargets(result.enrollment);
      } catch (error) {
        this.status = { state: "unavailable", reason: getErrorMessage(error) };
        this.projectCgroups = new Map();
        setAgentCgroupEnrollmentTargets(null);
      }
      if (isNewFailure(previous, this.status)) {
        log.warn("Agent resource limits are not applied", { reason: this.status.reason });
      }
    });
    return this.applying;
  }
}

function isNewFailure(
  previous: AgentResourceLimitsStatus,
  next: AgentResourceLimitsStatus
): next is Extract<AgentResourceLimitsStatus, { state: "unavailable" }> {
  return (
    next.state === "unavailable" &&
    (previous.state !== "unavailable" || previous.reason !== next.reason)
  );
}
