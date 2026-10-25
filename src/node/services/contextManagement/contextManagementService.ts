import type { Config } from "@/node/config";
import type { AgentSessionAIService } from "../agentSession";
import type { HistoryService } from "../historyService";
import type { SessionUsageService } from "../sessionUsageService";
import type { TelemetryService } from "../telemetryService";
import { SessionContextController } from "./sessionContextController";
import type { SessionContextHost } from "./sessionContextHost";

export interface ContextManagementDependencies {
  config: Config;
  historyService: HistoryService;
  aiService: AgentSessionAIService;
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  telemetryService?: TelemetryService;
}

/** App-owned dependencies; mutable context-management state belongs to each opened session. */
export class ContextManagementService {
  /** Controllers that still hold session state; the shared config listener fans out to them. */
  private readonly openControllers = new Set<SessionContextController>();
  private unsubscribeConfigChanged: (() => void) | undefined;

  constructor(private readonly deps: ContextManagementDependencies) {}

  openSession(host: SessionContextHost): SessionContextController {
    const controller = new SessionContextController(this.deps, host, () => {
      this.openControllers.delete(controller);
      if (this.openControllers.size === 0) {
        this.unsubscribeConfigChanged?.();
        this.unsubscribeConfigChanged = undefined;
      }
    });
    this.openControllers.add(controller);
    this.ensureConfigSubscription();
    return controller;
  }

  /**
   * One config listener for every live session rather than one per session: `Config` uses a
   * plain EventEmitter, so per-session listeners would trip the default listener limit with a
   * handful of parallel agents. The threshold lives in config.json (owned by the slider through
   * user preferences); a change for the model a session's continuous compaction is working
   * against invalidates its staged fold, exactly as the former RPC setter did.
   */
  private ensureConfigSubscription(): void {
    if (this.unsubscribeConfigChanged) return;
    this.unsubscribeConfigChanged = this.deps.config.onConfigChanged(() => {
      for (const controller of this.openControllers) {
        controller.onPersistedPreferencesChanged();
      }
    });
  }
}
