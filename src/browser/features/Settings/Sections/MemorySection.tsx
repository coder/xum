import { MemoryBrowser } from "@/browser/features/Memory/MemoryBrowser";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  SETTINGS_GROUP_HEADING_CLASS,
  SettingsAnchor,
  SettingsMark,
} from "../Components/SettingsLayout";
import { MemoryDreamCostCeilingSetting } from "./MemoryDreamCostCeilingSetting";
import { MemoryDreamEditLimitSetting } from "./MemoryDreamEditLimitSetting";
import { MemoryDreamRunTimeoutSetting } from "./MemoryDreamRunTimeoutSetting";

/**
 * Limits of the dream agent, shown while Memory Consolidation is on. Moved from under its row in
 * Experiments (which now only turns it on) to sit with the memory files it edits.
 */
export function MemoryConsolidationGroup() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION);
  if (!enabled) return null;
  return (
    <section className="space-y-2">
      <h3 className={`${SETTINGS_GROUP_HEADING_CLASS} px-1`}>Consolidation</h3>
      <div className="border-border-light bg-surface-secondary rounded-lg border px-4 [&>*:first-child>*]:border-t-0">
        <SettingsAnchor id="dream-cost-ceiling">
          <MemoryDreamCostCeilingSetting />
        </SettingsAnchor>
        <SettingsAnchor id="dream-edit-limit">
          <MemoryDreamEditLimitSetting />
        </SettingsAnchor>
        <SettingsAnchor id="dream-run-timeout">
          <MemoryDreamRunTimeoutSetting />
        </SettingsAnchor>
      </div>
    </section>
  );
}

/**
 * Settings → Memory (experiment: "memory") — manages GLOBAL memory files
 * without a workspace: the memory.* routes are called with workspaceId null,
 * so only the global scope (~/.xum/memory/global) is reachable. Project/workspace
 * memories are curated from each workspace's Memory tab instead.
 */
export function MemorySection() {
  return (
    // flex-1/min-h-0 lets the file editor (and the browser list) fill the
    // remaining settings-page height instead of collapsing to its min-height.
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <MemoryConsolidationGroup />
      <div>
        <SettingsMark id="global-memories" />
        <h3 className="text-foreground mb-1 text-sm font-medium">Global Memories</h3>
        <p className="text-muted text-xs">
          Memory files the agent shares across every project and workspace. Project and workspace
          memories live in the Memory tab of each workspace.
        </p>
      </div>
      {/* Bordered panel so the editable area is visually distinct from the
          settings dialog background (the sidebar Memory tab has its own chrome). */}
      <div className="border-border-light flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <MemoryBrowser workspaceId={null} scopes={["global"]} />
      </div>
    </div>
  );
}
