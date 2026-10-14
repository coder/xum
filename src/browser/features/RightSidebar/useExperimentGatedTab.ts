import React from "react";
import type { ExperimentId } from "@/common/constants/experiments";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import type { TabType } from "@/browser/types/rightSidebar";
import {
  collectAllTabs,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";

/**
 * Removes an experiment-gated tab from the persisted layout while its experiment is off. It
 * never adds the tab: the strip shows only tabs that were opened, and the New tab launcher
 * offers the tool while the experiment is on.
 * Leaves the layout alone while the flag is still loading (or the backend read failed), so a
 * provisional "off" never prunes a tab the user opened.
 */
export function useExperimentGatedTab(args: {
  tab: TabType;
  experimentId: ExperimentId;
  initialActiveTab: TabType | undefined;
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

      if (!enabled && hasTab) {
        return removeTabEverywhere(prev, tab);
      }

      return prev;
    });
  }, [enabled, loaded, initialActiveTab, setLayoutRaw, tab]);
}
