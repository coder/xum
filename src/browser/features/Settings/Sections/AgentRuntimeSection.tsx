import { AgentResourceLimitsSettings } from "./AgentResourceLimitsSettings";
import { AgentSandboxSettings } from "./AgentSandboxSettings";

/** How local agent commands run, kept apart from the per-agent defaults in Settings > Agents. */
export function AgentRuntimeSection() {
  return (
    <div className="min-w-0 space-y-6">
      <AgentResourceLimitsSettings />
      <AgentSandboxSettings />
    </div>
  );
}
