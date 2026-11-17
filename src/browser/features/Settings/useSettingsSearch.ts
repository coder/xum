import { useEffect, useState } from "react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { settingsSearchResultDomId } from "./Components/SettingsSearchResults";
import {
  buildSettingsSearchIndex,
  groupSettingsSearchResults,
  searchSettings,
  type SettingsSearchResult,
} from "./settingsSearch";
import type { SettingsSectionMeta } from "./settingsRegistry";

function countBySection(results: readonly SettingsSearchResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.section.id, (counts.get(result.section.id) ?? 0) + 1);
  }
  return counts;
}

/** Query, grouped results and the keyboard-active result of the settings search. */
export function useSettingsSearch(
  sections: readonly SettingsSectionMeta[],
  platform: "desktop" | "browser"
) {
  const { registerOnClose } = useSettings();
  const [query, setQueryState] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  // The page stays mounted between opens; last time's search must not greet the next open.
  useEffect(() => registerOnClose(() => setQueryState("")), [registerOnClose]);
  const searching = query.trim().length > 0;
  const groups = groupSettingsSearchResults(
    searchSettings(buildSettingsSearchIndex(sections, platform), sections, query)
  );
  // Keyboard order is render order (grouped by section), not raw score order.
  const ordered = groups.flatMap((group) => group.results);
  const activeIndex = Math.min(activeResultIndex, Math.max(ordered.length - 1, 0));

  const setQuery = (next: string) => {
    setQueryState(next);
    setActiveResultIndex(0);
  };

  const moveActive = (delta: number) => {
    if (ordered.length === 0) return;
    const next = (activeIndex + delta + ordered.length) % ordered.length;
    setActiveResultIndex(next);
    // The option already exists (only its highlight changes), so scroll it now, no effect.
    document
      .getElementById(settingsSearchResultDomId(next))
      ?.scrollIntoView?.({ block: "nearest" });
  };

  return {
    query,
    setQuery,
    searching,
    groups,
    resultCount: ordered.length,
    activeIndex,
    activeResult: searching ? ordered[activeIndex] : undefined,
    setActiveIndex: setActiveResultIndex,
    moveActive,
    /** Hits per section while searching, null otherwise. */
    matchCounts: searching ? countBySection(ordered) : null,
  };
}

export type SettingsSearchState = ReturnType<typeof useSettingsSearch>;
