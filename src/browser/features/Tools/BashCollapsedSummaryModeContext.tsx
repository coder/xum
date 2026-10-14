import { createContext, useContext, type ReactNode } from "react";
import {
  normalizeBashCollapsedSummaryMode,
  type BashCollapsedSummaryMode,
} from "@/common/constants/storage";
import { getUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";

const BashCollapsedSummaryModeContext = createContext<BashCollapsedSummaryMode | null>(null);

export function BashCollapsedSummaryModeProvider(props: { children: ReactNode }) {
  const mode = useUserPreferences((preferences) =>
    normalizeBashCollapsedSummaryMode(preferences.appearance?.bashCollapsedSummaryMode)
  );

  return (
    <BashCollapsedSummaryModeContext.Provider value={mode}>
      {props.children}
    </BashCollapsedSummaryModeContext.Provider>
  );
}

export function useBashCollapsedSummaryMode(): BashCollapsedSummaryMode {
  const contextMode = useContext(BashCollapsedSummaryModeContext);
  if (contextMode !== null) {
    return contextMode;
  }

  return normalizeBashCollapsedSummaryMode(
    getUserPreferences().appearance?.bashCollapsedSummaryMode
  );
}
