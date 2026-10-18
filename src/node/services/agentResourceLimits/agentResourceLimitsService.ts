import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsState,
  AgentResourceLimitsStatus,
} from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import { setAgentCgroupEnrollmentTarget } from "@/node/runtime/agentCgroupEnrollment";
import { log } from "@/node/services/log";
import { applyAgentCgroupLimits, linuxAgentCgroupHost, type AgentCgroupHost } from "./agentCgroup";

/**
 * Keeps the agent cgroup in line with the `agentResourceLimits` and `agentResourceLimitsEnabled`
 * settings: at startup, after every config change, and when a setting is saved. Applies run one at
 * a time.
 */
export class AgentResourceLimitsService {
  private status: AgentResourceLimitsStatus = { state: "off" };
  /** The limits of the last apply, so unrelated config changes do not re-run it. */
  private appliedLimits: string | undefined;
  private applying: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly config: Config,
    private readonly host: AgentCgroupHost = linuxAgentCgroupHost
  ) {}

  async start(): Promise<void> {
    this.unsubscribe ??= this.config.onConfigChanged(() => {
      void this.apply({ trySudo: false });
    });
    await this.apply({ trySudo: true });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The saved setting and its status, after the applies queued so far. */
  async get(): Promise<AgentResourceLimitsState> {
    await this.applying;
    return { ...this.readSetting(), status: this.status };
  }

  /** Saves `limits` and applies them, even when unchanged, so saving again retries a failure. */
  async set(limits: AgentResourceLimits): Promise<AgentResourceLimitsState> {
    // The save notifies the config listener, whose apply then runs even for unchanged limits.
    this.appliedLimits = undefined;
    await this.config.updateAgentResourceLimits(limits);
    await this.apply({ trySudo: true });
    return this.get();
  }

  /** Turns the saved limits on or off, without changing them. */
  async setEnabled(enabled: boolean): Promise<AgentResourceLimitsState> {
    await this.config.updateAgentResourceLimitsEnabled(enabled);
    await this.apply({ trySudo: true });
    return this.get();
  }

  private readSetting(): Omit<AgentResourceLimitsState, "status"> {
    const config = this.config.loadConfigOrDefault();
    return {
      enabled: config.agentResourceLimitsEnabled === true,
      limits: config.agentResourceLimits ?? {},
    };
  }

  /** `trySudo`: see applyAgentCgroupLimits; config-change applies never run sudo. */
  private apply(options: { trySudo: boolean }): Promise<void> {
    this.applying = this.applying.then(async () => {
      const previous = this.status;
      try {
        const { enabled, limits } = this.readSetting();
        // Off keeps the saved limits but applies none.
        const applied = enabled ? limits : {};
        const key = JSON.stringify(applied);
        // Limits that failed to apply retry on any config change: Try again in another
        // backend's Settings saves them unchanged, and this backend sees only the change.
        if (key === this.appliedLimits && previous.state !== "unavailable") {
          return;
        }
        this.appliedLimits = key;
        const result = await applyAgentCgroupLimits(applied, this.host, options);
        this.status = result.status;
        setAgentCgroupEnrollmentTarget(result.enrollmentTarget);
      } catch (error) {
        this.status = { state: "unavailable", reason: getErrorMessage(error) };
        setAgentCgroupEnrollmentTarget(null);
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
