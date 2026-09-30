/**
 * StatsContainer — unified "Stats" top-level tab with sub-tabs.
 *
 * The context usage meter renders above the sub-tab strip so it stays visible
 * on every sub-tab.
 *
 * Sub-tabs:
 * - "Cost" — renders CostsTab
 * - "Context" — renders ContextTab (artifacts + tokenizer breakdowns)
 * - "Timing" — renders TimingPanel from StatsTab
 * - "Models" — renders ModelBreakdownPanel from StatsTab
 */

import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { CostsTab } from "./CostsTab";
import { ContextTab } from "./ContextTab";
import { ContextUsageSection } from "./ContextUsageSection";
import { TimingPanel, ModelBreakdownPanel } from "./StatsTab";
import { STATS_CONTAINER_SUB_TAB_KEY } from "@/common/constants/storage";

type StatsSubTab = "cost" | "context" | "timing" | "models";

interface StatsOption {
  value: StatsSubTab;
  label: string;
}

const OPTIONS: StatsOption[] = [
  { value: "cost", label: "Cost" },
  { value: "context", label: "Context" },
  { value: "timing", label: "Timing" },
  { value: "models", label: "Models" },
];

interface StatsContainerProps {
  workspaceId: string;
}

export function StatsContainer(props: StatsContainerProps) {
  const [subTab, setSubTab] = usePersistedState<StatsSubTab>(STATS_CONTAINER_SUB_TAB_KEY, "cost");

  const effectiveTab = OPTIONS.some((o) => o.value === subTab) ? subTab : "cost";

  return (
    <div>
      <ContextUsageSection workspaceId={props.workspaceId} />
      <div className="mb-3">
        <div className="flex gap-1">
          {OPTIONS.map((option) => {
            const isActive = option.value === effectiveTab;
            return (
              <button
                key={option.value}
                type="button"
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted hover:text-foreground hover:bg-accent/50"
                }`}
                onClick={() => setSubTab(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {effectiveTab === "cost" && <CostsTab workspaceId={props.workspaceId} />}
      {effectiveTab === "context" && <ContextTab workspaceId={props.workspaceId} />}
      {effectiveTab === "timing" && <TimingPanel workspaceId={props.workspaceId} />}
      {effectiveTab === "models" && <ModelBreakdownPanel workspaceId={props.workspaceId} />}
    </div>
  );
}
