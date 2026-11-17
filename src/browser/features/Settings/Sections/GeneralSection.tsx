import { useRef } from "react";
import { useTheme, THEME_OPTIONS, type ThemePreference } from "@/browser/contexts/ThemeContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import {
  saveConfigOptimistically,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import { useChatTranscriptFullWidth } from "@/browser/hooks/useChatTranscriptFullWidth";
import { useTranscriptDensity } from "@/browser/hooks/useTranscriptDensity";
import { useLiveAPI } from "@/browser/contexts/API";
import {
  BASH_COLLAPSED_SUMMARY_MODES,
  TRANSCRIPT_DENSITIES,
  normalizeBashCollapsedSummaryMode,
  normalizeTranscriptDensity,
  type BashCollapsedSummaryMode,
  type TranscriptDensity,
  type LaunchBehavior,
} from "@/common/constants/storage";
import {
  SETTING_SELECT_TRIGGER_CLASS,
  SettingRow,
  SettingsGroup,
} from "../Components/SettingsLayout";

// Keep the legacy "dashboard" storage value for backwards compatibility even
// though the dedicated landing page has been removed. It now means "open the
// recent project page".
const LAUNCH_BEHAVIOR_OPTIONS = [
  { value: "dashboard", label: "Recent project" },
  { value: "new-chat", label: "New chat on recent project" },
  { value: "last-workspace", label: "Last visited workspace" },
] as const;
const BASH_COLLAPSED_SUMMARY_MODE_LABELS: Record<BashCollapsedSummaryMode, string> = {
  command: "Command",
  "intent-command": "Intent and command",
  intent: "Intent",
};
const BASH_COLLAPSED_SUMMARY_MODE_OPTIONS = BASH_COLLAPSED_SUMMARY_MODES.map((value) => ({
  value,
  label: BASH_COLLAPSED_SUMMARY_MODE_LABELS[value],
}));
const TRANSCRIPT_DENSITY_LABELS: Record<TranscriptDensity, string> = {
  normal: "Normal",
  hyper: "Hyper",
};
const TRANSCRIPT_DENSITY_OPTIONS = TRANSCRIPT_DENSITIES.map((value) => ({
  value,
  label: TRANSCRIPT_DENSITY_LABELS[value],
}));

/**
 * Appearance (route id "general", kept for deep links). General used to hold nine unrelated
 * groups; terminal/editor, compaction, keep-awake, archiving and the project folder now live in
 * the sections they belong to (Terminal & editor, Agents, Runtimes).
 */
export function GeneralSection() {
  const { themePreference, setTheme } = useTheme();
  const liveApi = useLiveAPI();
  const launchBehavior = useUserPreferences(
    (preferences) => preferences.navigation?.launchBehavior ?? "dashboard"
  );
  const bashCollapsedSummaryMode = useUserPreferences((preferences) =>
    normalizeBashCollapsedSummaryMode(preferences.appearance?.bashCollapsedSummaryMode)
  );
  const sidebarAgeGrouping =
    useUserPreferences((preferences) => preferences.ui?.sidebarAgeGrouping) ?? true;
  const sidebarFlatMode =
    useUserPreferences((preferences) => preferences.ui?.sidebarFlatMode) ?? false;
  const sidebarHideSubAgents =
    useUserPreferences((preferences) => preferences.ui?.sidebarHideSubAgents) ?? false;
  const [transcriptDensity, setTranscriptDensity] = useTranscriptDensity();
  const chatTranscriptFullWidth = useChatTranscriptFullWidth();
  const chatTranscriptFullWidthUpdateChainRef = useRef<Promise<void>>(Promise.resolve());

  const handleChatTranscriptFullWidthChange = (checked: boolean) => {
    saveConfigOptimistically(liveApi, { chatTranscriptFullWidth: checked }, (client) => {
      // Chained so a quick toggle back cannot land before the toggle it reverses.
      const update = chatTranscriptFullWidthUpdateChainRef.current.then(() =>
        client.config.updateChatTranscriptFullWidth({ enabled: checked })
      );
      chatTranscriptFullWidthUpdateChainRef.current = update.catch(() => undefined);
      return update;
    });
  };

  return (
    <div className="space-y-8">
      <SettingsGroup title="Theme & startup">
        <SettingRow id="theme">
          <Select
            value={themePreference}
            onValueChange={(value) => setTheme(value as ThemePreference)}
          >
            <SelectTrigger aria-label="Theme" className={SETTING_SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow id="launch-behavior">
          <Select
            value={launchBehavior}
            onValueChange={(value) =>
              updateUserPreferences({ navigation: { launchBehavior: value as LaunchBehavior } })
            }
          >
            <SelectTrigger aria-label="Launch behavior" className={SETTING_SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LAUNCH_BEHAVIOR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Sidebar">
        <SettingRow id="sidebar-flat">
          <Switch
            checked={sidebarFlatMode}
            onCheckedChange={(checked) =>
              updateUserPreferences({ ui: { sidebarFlatMode: checked } })
            }
            aria-label="Toggle flat chat list"
          />
        </SettingRow>
        <SettingRow id="sidebar-age-grouping">
          <Switch
            checked={sidebarAgeGrouping}
            onCheckedChange={(checked) =>
              updateUserPreferences({ ui: { sidebarAgeGrouping: checked } })
            }
            aria-label="Toggle sidebar workspace age grouping"
          />
        </SettingRow>
        <SettingRow id="sidebar-hide-sub-agents">
          <Switch
            checked={sidebarHideSubAgents}
            onCheckedChange={(checked) =>
              updateUserPreferences({ ui: { sidebarHideSubAgents: checked } })
            }
            aria-label="Toggle hiding sub-agents in the sidebar"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Transcript">
        <SettingRow id="transcript-full-width">
          <Switch
            checked={chatTranscriptFullWidth}
            onCheckedChange={handleChatTranscriptFullWidthChange}
            aria-label="Toggle full-width chat transcript"
          />
        </SettingRow>
        <SettingRow id="transcript-density">
          <Select
            value={transcriptDensity}
            onValueChange={(value) => setTranscriptDensity(normalizeTranscriptDensity(value))}
          >
            <SelectTrigger aria-label="Transcript density" className={SETTING_SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSCRIPT_DENSITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow id="bash-collapsed-summaries">
          <Select
            value={bashCollapsedSummaryMode}
            onValueChange={(value) =>
              updateUserPreferences({
                appearance: { bashCollapsedSummaryMode: value as BashCollapsedSummaryMode },
              })
            }
          >
            <SelectTrigger
              aria-label="Collapsed bash summaries"
              className={SETTING_SELECT_TRIGGER_CLASS}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BASH_COLLAPSED_SUMMARY_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
