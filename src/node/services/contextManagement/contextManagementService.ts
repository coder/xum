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
  constructor(private readonly deps: ContextManagementDependencies) {}

  openSession(host: SessionContextHost): SessionContextController {
    return new SessionContextController(this.deps, host);
  }
}
