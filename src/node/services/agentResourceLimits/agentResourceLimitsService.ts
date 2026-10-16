import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type { AgentResourceLimitsStatus } from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import { setAgentCgroupEnrollmentTarget } from "@/node/runtime/agentCgroupEnrollment";
import { log } from "@/node/services/log";
import { applyAgentCgroupLimits, linuxAgentCgroupHost, type AgentCgroupHost } from "./agentCgroup";

export interface AgentResourceLimitsState {
  limits: AgentResourceLimits;
  status: AgentResourceLimitsStatus;
}

/**
 * Keeps the agent cgroup in line with the `agentResourceLimits` setting: at startup, after every
 * config change, and when the setting is saved. Applies run one at a time.
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
      void this.apply();
    });
    await this.apply();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The saved limits and their status, after the applies queued so far. */
  async get(): Promise<AgentResourceLimitsState> {
    await this.applying;
    return { limits: this.readLimits(), status: this.status };
  }

  /** Saves `limits` and applies them, even when unchanged, so saving again retries a failure. */
  async set(limits: AgentResourceLimits): Promise<AgentResourceLimitsState> {
    // The save notifies the config listener, whose apply then runs even for unchanged limits.
    this.appliedLimits = undefined;
    await this.config.updateAgentResourceLimits(limits);
    await this.apply();
    return this.get();
  }

  private readLimits(): AgentResourceLimits {
    return this.config.loadConfigOrDefault().agentResourceLimits ?? {};
  }

  private apply(): Promise<void> {
    this.applying = this.applying.then(async () => {
      const previous = this.status;
      try {
        const limits = this.readLimits();
        const key = JSON.stringify(limits);
        // Limits that failed to apply retry on any config change: Try again in another
        // backend's Settings saves them unchanged, and this backend sees only the change.
        if (key === this.appliedLimits && previous.state !== "unavailable") {
          return;
        }
        this.appliedLimits = key;
        const result = await applyAgentCgroupLimits(limits, this.host);
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
