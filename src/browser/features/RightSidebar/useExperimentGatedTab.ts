import React from "react";
import type { ExperimentId } from "@/common/constants/experiments";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
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
  const enabled = useExperimentValue(args.experimentId);
  const store = getAppConfigStore();
  const loaded = React.useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot()?.experiments != null
  );

  React.useEffect(() => {
    if (!loaded) {
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
  }, [enabled, loaded, initialActiveTab, setLayoutRaw, tab]);
}
