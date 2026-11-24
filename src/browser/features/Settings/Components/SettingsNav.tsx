import type { KeyboardEventHandler, RefObject } from "react";
import { ChevronLeft, FlaskConical, Search, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import { SETTINGS_GROUPS } from "../settingsRegistry";
import type { SettingsSection } from "../types";
import { SETTINGS_SEARCH_LISTBOX_ID } from "./SettingsSearchResults";

/** The search field at the top of the nav (a combobox over the results listbox). */
export function SettingsSearchField(props: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  activeDescendant: string | undefined;
  onQueryChange: (query: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onClear: () => void;
}) {
  return (
    <label className="border-border-medium bg-surface-secondary focus-within:border-accent flex h-9 items-center gap-2 rounded-md border px-2.5">
      <Search aria-hidden="true" className="text-muted h-3.5 w-3.5 shrink-0" />
      <input
        ref={props.inputRef}
        type="search"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={props.query.trim().length > 0}
        aria-controls={SETTINGS_SEARCH_LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={props.activeDescendant}
        value={props.query}
        onChange={(e) => props.onQueryChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        className="text-content-primary placeholder:text-content-secondary min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {props.query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={props.onClear}
          className="text-muted hover:text-foreground"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ) : (
        <kbd className="mobile-hide-shortcut-hints text-muted border-border-medium rounded border px-1 font-mono text-[10px]">
          {formatKeybind(KEYBINDS.FOCUS_SETTINGS_SEARCH)}
        </kbd>
      )}
    </label>
  );
}

function navItemClass(selected: boolean, dimmed: boolean): string {
  if (selected) {
    return "bg-surface-tertiary text-content-primary hover:bg-surface-tertiary hover:text-content-primary";
  }
  return cn(
    "hover:bg-surface-secondary hover:text-content-primary",
    dimmed ? "text-content-secondary/50" : "text-content-secondary"
  );
}

function SettingsNavItem(props: {
  section: SettingsSection;
  selected: boolean;
  /** Search hits in this section, or null when not searching. */
  matchCount: number | null;
  roomy: boolean;
  onOpen: (sectionId: string) => void;
}) {
  const count = props.matchCount ?? 0;
  return (
    <Button
      variant="ghost"
      aria-current={props.selected ? "page" : undefined}
      onClick={() => props.onOpen(props.section.id)}
      className={cn(
        "flex h-auto w-full items-center justify-start gap-2 rounded-md px-2.5 text-left text-sm whitespace-nowrap",
        props.roomy ? "py-2.5" : "py-1.5",
        navItemClass(props.selected, props.matchCount === 0)
      )}
    >
      {props.section.icon}
      <span className="min-w-0 truncate">{props.section.label}</span>
      {props.section.experimental && (
        <FlaskConical aria-hidden="true" className="text-warning h-3 w-3 shrink-0" />
      )}
      {count > 0 ? (
        <span className="text-accent-text counter-nums ml-auto text-xs">{count}</span>
      ) : null}
    </Button>
  );
}

/**
 * Sections grouped under uppercase group labels, each with its icon. While searching, sections
 * show their hit count and sections without hits dim.
 */
export function SettingsNav(props: {
  sections: SettingsSection[];
  currentSectionId: string | null;
  matchCounts: ReadonlyMap<string, number> | null;
  /** Phones get taller rows (touch targets). */
  roomy: boolean;
  onOpen: (sectionId: string) => void;
}) {
  return (
    <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {SETTINGS_GROUPS.map((group) => {
        const groupSections = props.sections.filter((section) => section.group === group.id);
        if (groupSections.length === 0) return null;
        return (
          <div key={group.id} className="mt-3 first:mt-1">
            <div className="text-content-secondary px-2.5 pb-1 text-[10.5px] font-medium tracking-wider uppercase">
              {group.label}
            </div>
            {groupSections.map((section) => (
              <SettingsNavItem
                key={section.id}
                section={section}
                selected={section.id === props.currentSectionId}
                matchCount={props.matchCounts ? (props.matchCounts.get(section.id) ?? 0) : null}
                roomy={props.roomy}
                onOpen={props.onOpen}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

/** Group / section breadcrumb, or the result count while searching; phones get a back button. */
export function SettingsContentHeader(props: {
  section: SettingsSection;
  resultCount: number | null;
  onBack: (() => void) | null;
}) {
  const groupLabel = SETTINGS_GROUPS.find((g) => g.id === props.section.group)?.label;
  // "Agents / Agents" says nothing twice: skip the group when it matches. Phones show the
  // section alone (the back button already leads to the grouped list).
  const showGroup =
    props.onBack == null && groupLabel != null && groupLabel !== props.section.label;
  return (
    <div className="border-border-light flex h-12 shrink-0 items-center gap-2 border-b pr-14 pl-2 md:pl-6">
      {props.onBack ? (
        <Button
          variant="ghost"
          onClick={props.onBack}
          className="text-muted hover:text-foreground h-11 shrink-0 gap-1 px-2"
          aria-label="All settings"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
      ) : null}
      {props.resultCount != null ? (
        <span className="text-foreground truncate text-sm font-medium">
          {props.resultCount === 1 ? "1 result" : `${props.resultCount} results`}
        </span>
      ) : (
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {showGroup ? (
            <>
              <span className="text-content-secondary shrink-0">{groupLabel}</span>
              <span aria-hidden="true" className="text-muted shrink-0">
                /
              </span>
            </>
          ) : null}
          <span className="text-content-primary truncate font-medium">{props.section.label}</span>
        </div>
      )}
    </div>
  );
}
