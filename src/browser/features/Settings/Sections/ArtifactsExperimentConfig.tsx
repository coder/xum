import { Switch } from "@/browser/components/Switch/Switch";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { SettingRow, SettingsGroup } from "../Components/SettingsLayout";

/**
 * Sandbox & limits → Artifacts: what artifact sandboxes may load. Moved from under the Artifacts
 * row in Experiments (which now only turns the feature on) to sit with the other sandbox policy.
 */
export function ArtifactsExperimentConfig() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  // Same default as SandboxedArtifactFrame and McpAppFrame.
  const allowCdn =
    useUserPreferences((preferences) => preferences.ui?.artifactsAllowCdnScripts) ?? true;
  if (!enabled) return null;
  return (
    <SettingsGroup title="Artifacts" description="Shown while the Artifacts experiment is on.">
      <SettingRow id="artifacts-cdn">
        <Switch
          checked={allowCdn}
          onCheckedChange={(checked) =>
            updateUserPreferences({ ui: { artifactsAllowCdnScripts: checked } })
          }
          aria-label="Toggle CDN assets in artifacts"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
