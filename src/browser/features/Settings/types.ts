import type { SettingsSectionMeta } from "./settingsRegistry";

export interface SettingsSection extends SettingsSectionMeta {
  component: React.ComponentType;
}
