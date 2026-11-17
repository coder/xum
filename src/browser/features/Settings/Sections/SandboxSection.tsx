import { SETTINGS_CARD_CLASS, SettingsMark } from "../Components/SettingsLayout";
import { AgentResourceLimitsSettings } from "./AgentResourceLimitsSettings";
import { AgentSandboxSettings } from "./AgentSandboxSettings";
import { ArtifactsExperimentConfig } from "./ArtifactsExperimentConfig";

/**
 * Sandbox & limits: what agent commands may touch and use. These were inside Agents, next to
 * model defaults; they are workspace security concerns, so they sit with Project trust.
 */
export function SandboxSection() {
  return (
    <div className="min-w-0 space-y-8">
      <div className={SETTINGS_CARD_CLASS}>
        <SettingsMark id="agent-sandbox" />
        <AgentSandboxSettings />
      </div>
      <div className={SETTINGS_CARD_CLASS}>
        <SettingsMark id="resource-limits" />
        <AgentResourceLimitsSettings />
      </div>
      <ArtifactsExperimentConfig />
    </div>
  );
}
