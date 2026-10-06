import React from "react";
import type { ExperimentId } from "@/common/constants/experiments";
import { useSettledExperimentValue } from "@/browser/contexts/ExperimentsContext";
import type { TabType } from "@/browser/types/rightSidebar";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";

/**
 * Adds an experiment-gated tab to the persisted layout while the experiment is on, else removes it.
 * Leaves the layout alone while the flag is still loading (or the backend read failed): pruning on
 * the provisional default and re-adding on the loaded value moved the tab to the end of its
 * tabset and dropped its selection after every reload.
 */
export function useExperimentGatedTab(args: {
  tab: TabType;
  experimentId: ExperimentId;
  initialActiveTab: TabType;
  setLayoutRaw: React.Dispatch<React.SetStateAction<RightSidebarLayoutState>>;
}): void {
  const { tab, initialActiveTab, setLayoutRaw } = args;
  const enabled = useSettledExperimentValue(args.experimentId);

  React.useEffect(() => {
    if (enabled == null) {
      return;
    }

    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasTab = collectAllTabs(prev.root).includes(tab);

      if (enabled && !hasTab) {
        return addTabToFocusedTabset(prev, tab, false);
      }

      if (!enabled && hasTab) {
        return removeTabEverywhere(prev, tab);
      }

      return prev;
    });
  }, [enabled, initialActiveTab, setLayoutRaw, tab]);
}
