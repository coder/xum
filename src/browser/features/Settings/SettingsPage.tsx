import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useOnboardingPause } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import type { useModalFocusReturn } from "@/browser/hooks/useModalFocusReturn";
import { useBelowMdViewport } from "@/browser/hooks/useNarrowViewport";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { cn } from "@/common/lib/utils";
import { GeneralSection } from "./Sections/GeneralSection";
import { TerminalEditorSection } from "./Sections/TerminalEditorSection";
import { AgentBehaviorSection, AgentDefaultsSection } from "./Sections/TasksSection";
import { HeartbeatSection } from "./Sections/HeartbeatSection";
import { ProvidersSection } from "./Sections/ProvidersSection";
import { ModelsSection } from "./Sections/ModelsSection";
import { MemorySection } from "./Sections/MemorySection";
import { Button } from "@/browser/components/Button/Button";
import { MCPSettingsSection } from "./Sections/MCPSettingsSection";
import { PluginsSettingsSection } from "./Sections/PluginsSettingsSection";
import { SecretsSection } from "./Sections/SecretsSection";
import { InstructionsSection } from "./Sections/InstructionsSection";
import { RuntimesSection } from "./Sections/RuntimesSection";
import { SandboxSection } from "./Sections/SandboxSection";
import { ExperimentsSection } from "./Sections/ExperimentsSection";
import { ServerAccessSection } from "./Sections/ServerAccessSection";
import { RemoteConnectionSection } from "./Sections/RemoteConnectionSection";
import { KeybindsSection } from "./Sections/KeybindsSection";
import { SecuritySection } from "./Sections/SecuritySection";
import { BackupSection } from "./Sections/BackupSection";
import {
  SettingsFocusContext,
  SettingsOpenSettingContext,
  type SettingsFocusTarget,
} from "./Components/SettingsLayout";
import {
  SettingsSearchResults,
  settingsSearchResultDomId,
} from "./Components/SettingsSearchResults";
import { SettingsContentHeader, SettingsNav, SettingsSearchField } from "./Components/SettingsNav";
import { SETTINGS_SECTION_META, SETTING_DEFINITIONS, type SettingId } from "./settingsRegistry";
import type { SettingsSearchResult } from "./settingsSearch";
import { useSettingsSearch, type SettingsSearchState } from "./useSettingsSearch";
import type { SettingsSection } from "./types";

const LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS = new Set(["goals"]);

const SECTION_COMPONENTS: Record<string, React.ComponentType> = {
  general: GeneralSection,
  terminal: TerminalEditorSection,
  keybinds: KeybindsSection,
  behavior: AgentBehaviorSection,
  tasks: AgentDefaultsSection,
  heartbeat: HeartbeatSection,
  instructions: InstructionsSection,
  memory: MemorySection,
  providers: ProvidersSection,
  models: ModelsSection,
  mcp: MCPSettingsSection,
  plugins: PluginsSettingsSection,
  runtimes: RuntimesSection,
  sandbox: SandboxSection,
  security: SecuritySection,
  secrets: SecretsSection,
  "server-access": ServerAccessSection,
  "remote-connection": RemoteConnectionSection,
  experiments: ExperimentsSection,
  backup: BackupSection,
};

interface SettingsSectionRedirect {
  section: string;
  replace?: boolean;
}

export function getSettingsSections(
  memoryEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSection[] {
  return SETTINGS_SECTION_META.filter((meta) => {
    if (meta.id === "memory") return memoryEnabled;
    if (meta.id === "remote-connection") return remoteConnectionAvailable;
    return true;
  }).map((meta) => {
    const component = SECTION_COMPONENTS[meta.id];
    if (!component) throw new Error(`No component for settings section ${meta.id}`);
    return { ...meta, component };
  });
}

// Sections that no longer exist. Old deep links and restored last-visited routes still name them.
const REMOVED_SETTINGS_SECTION_IDS = new Set(["governor", "layouts"]);
const DEFAULT_SECTION_ID = "general";

export function getSettingsSectionRedirect(
  activeSection: string,
  memoryEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSectionRedirect | null {
  if (LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS.has(activeSection)) {
    return { section: "experiments", replace: true };
  }

  // Removed section: replace so the restored URL and back stack drop the dead route.
  if (REMOVED_SETTINGS_SECTION_IDS.has(activeSection)) {
    return { section: DEFAULT_SECTION_ID, replace: true };
  }

  if (!memoryEnabled && activeSection === "memory") {
    return { section: DEFAULT_SECTION_ID };
  }

  if (!remoteConnectionAvailable && activeSection === "remote-connection") {
    return { section: DEFAULT_SECTION_ID };
  }

  return null;
}

/** Redirect restored links when an experiment or desktop bridge is unavailable. */
function useSettingsRedirect(memoryEnabled: boolean, remoteConnectionAvailable: boolean) {
  const { isOpen, activeSection, setActiveSection } = useSettings();
  useEffect(() => {
    if (!isOpen) return;
    const redirect = getSettingsSectionRedirect(
      activeSection,
      memoryEnabled,
      remoteConnectionAvailable
    );
    if (redirect) setActiveSection(redirect.section, { replace: redirect.replace });
  }, [isOpen, activeSection, setActiveSection, memoryEnabled, remoteConnectionAvailable]);
}

/**
 * Phones show one column: the section list (with search) or a section with a back button. The
 * history entry decides which: a plain open's entry (and the back button's) shows the list and
 * every section entry shows its section, so browser Back and Forward restore what that entry
 * showed. No local view state, so nothing can fall out of step with history.
 */
function useMobileSettingsView(narrow: boolean) {
  const { openedWithoutSection, activeSection, setActiveSection } = useSettings();
  return {
    listOpen: openedWithoutSection,
    // Wider screens show the list beside every section: only phones push a list entry.
    showList: () => {
      if (narrow && !openedWithoutSection) setActiveSection(activeSection, { sectionless: true });
    },
  };
}

/**
 * Keys in the search field. Arrows move the active result and Enter opens it. The dialog leaves
 * Escape in a field to the field (allowEditableEscape): the first Escape clears the search, a
 * second one closes Settings.
 */
function handleSearchKeyDown(
  e: React.KeyboardEvent<HTMLInputElement>,
  search: SettingsSearchState,
  openResult: (result: SettingsSearchResult) => void,
  close: () => void
) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    search.moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && search.activeResult) {
    e.preventDefault();
    openResult(search.activeResult);
  } else if (e.key === "Escape") {
    stopKeyboardPropagation(e);
    e.preventDefault();
    if (search.query) search.setQuery("");
    else close();
  }
}

/** Desktop bridges that decide which sections and settings exist here. */
function getSettingsEnvironment() {
  return {
    remoteConnectionAvailable: window.api?.remoteConnection != null,
    platform: window.api ? ("desktop" as const) : ("browser" as const),
  };
}

/** What a search result highlights once its section is open. */
function focusTargetOf(result: SettingsSearchResult): SettingsFocusTarget | null {
  const { anchorId, fallbackAnchorId } = result.entry;
  return anchorId ? { id: anchorId, fallbackId: fallbackAnchorId } : null;
}

/** The left column: title, search field, and the grouped nav (or, on phones, the results). */
function SettingsListColumn(props: {
  narrow: boolean;
  sections: SettingsSection[];
  currentSectionId: string;
  search: SettingsSearchState;
  searchInputRef: React.RefObject<HTMLInputElement>;
  results: React.ReactNode;
  onQueryChange: (query: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onOpenSection: (sectionId: string) => void;
}) {
  const search = props.search;
  return (
    <div
      className={cn(
        "border-border-light flex min-h-0 min-w-0 flex-col",
        props.narrow ? "flex-1" : "w-60 shrink-0 border-r"
      )}
    >
      <div className="flex h-12 shrink-0 items-center px-4">
        <DialogTitle className="text-content-primary text-sm leading-normal tracking-normal">
          Settings
        </DialogTitle>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <SettingsSearchField
          inputRef={props.searchInputRef}
          query={search.query}
          activeDescendant={
            search.activeResult ? settingsSearchResultDomId(search.activeIndex) : undefined
          }
          onQueryChange={props.onQueryChange}
          onKeyDown={props.onSearchKeyDown}
          onClear={() => {
            search.setQuery("");
            props.searchInputRef.current?.focus();
          }}
        />
      </div>
      {props.narrow && search.searching ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4">{props.results}</div>
      ) : (
        <SettingsNav
          sections={props.sections}
          currentSectionId={search.searching ? null : props.currentSectionId}
          matchCounts={search.matchCounts}
          roomy={props.narrow}
          onOpen={props.onOpenSection}
        />
      )}
    </div>
  );
}

/** The right column: header and the open section, or the results while searching. */
function SettingsContentColumn(props: {
  section: SettingsSection;
  search: SettingsSearchState;
  results: React.ReactNode;
  focusedSetting: SettingsFocusTarget | null;
  onOpenSetting: (id: SettingId) => void;
  onBack: (() => void) | null;
  onReturnToSetup: (() => void) | null;
  /** The list column (and its title) is off screen: the dialog still needs its name. */
  titleHidden: boolean;
}) {
  const SectionComponent = props.section.component;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {props.titleHidden ? <DialogTitle className="sr-only">Settings</DialogTitle> : null}
      <SettingsContentHeader
        section={props.section}
        resultCount={props.search.searching ? props.search.resultCount : null}
        onBack={props.onBack}
      />
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {/* Keep settings content width bounded so long forms remain readable on wide screens.
            min-h-full + flex-col lets full-height sections (Settings → Memory editor) grow to
            the bottom via flex-1 while content-sized sections keep their natural height. */}
        <div className="flex min-h-full w-full max-w-4xl flex-col">
          {props.onReturnToSetup ? (
            <div className="bg-accent/10 border-accent/30 text-foreground mb-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Setup is paused while you configure providers.</span>
              <Button variant="secondary" size="sm" onClick={props.onReturnToSetup}>
                Return to setup
              </Button>
            </div>
          ) : null}
          {props.search.searching ? props.results : null}
          {/* Hidden, not unmounted, while results show: a section's unsaved draft (a Backup URL,
              an MCP server form) must survive a search the user clears again. */}
          <div className={props.search.searching ? "hidden" : "flex flex-1 flex-col"}>
            <SettingsOpenSettingContext.Provider value={props.onOpenSetting}>
              <SettingsFocusContext.Provider value={props.focusedSetting}>
                <SectionComponent />
              </SettingsFocusContext.Provider>
            </SettingsOpenSettingContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The search shortcut inside the dialog: show the list (phones) and focus and select the search
 * field once it is on screen. Returns whether the key was the shortcut.
 */
export function handleFocusSearchKey(
  e: React.KeyboardEvent,
  showList: () => void,
  searchInputRef: React.RefObject<HTMLInputElement | null>
): boolean {
  if (!matchesKeybind(e, KEYBINDS.FOCUS_SETTINGS_SEARCH)) return false;
  // Settings is modal: keep the shortcut from also reaching window listeners behind it (the
  // review panel binds the same chord to its own search).
  e.preventDefault();
  stopKeyboardPropagation(e);
  showList();
  // On phones the field mounts with the list; focus once it is on screen.
  requestAnimationFrame(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });
  return true;
}

/** Opening sections and results, and the shortcut that focuses the search field. */
function useSettingsActions(
  search: SettingsSearchState,
  mobile: ReturnType<typeof useMobileSettingsView>,
  setFocusedSetting: (target: SettingsFocusTarget | null) => void,
  searchInputRef: React.RefObject<HTMLInputElement>
) {
  const { open, activeSection, openedWithoutSection, setActiveSection } = useSettings();
  // A plain open's list entry must give way to a section entry even for the section it already
  // names, or a phone would stay on the list.
  const goToSection = (sectionId: string) => {
    if (sectionId !== activeSection || openedWithoutSection) setActiveSection(sectionId);
  };
  const openSection = (sectionId: string) => {
    search.setQuery("");
    setFocusedSetting(null);
    setActiveSection(sectionId);
  };
  const openSetting = (id: SettingId) => {
    search.setQuery("");
    setFocusedSetting({ id });
    goToSection(SETTING_DEFINITIONS[id].section);
  };
  const openResult = (result: SettingsSearchResult) => {
    const { sectionId, expandProvider } = result.entry;
    search.setQuery("");
    setFocusedSetting(focusTargetOf(result));
    // A provider result uses the same deep link the onboarding and model pickers use: open
    // Providers with that card expanded.
    if (expandProvider) open("providers", { expandProvider });
    else goToSection(sectionId);
  };
  const focusSearch = (e: React.KeyboardEvent) =>
    handleFocusSearchKey(e, mobile.showList, searchInputRef);
  return { openSection, openSetting, openResult, focusSearch };
}

// The caller owns the focus-return hook: this page is lazy-loaded and first mounts already open,
// so it cannot record the opener itself (see LazySettingsPage).
export function SettingsPage(props: { focusReturn: ReturnType<typeof useModalFocusReturn> }) {
  const { isOpen, close, activeSection, registerOnClose } = useSettings();
  const onboardingPause = useOnboardingPause();
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const environment = getSettingsEnvironment();
  const remoteConnectionAvailable = environment.remoteConnectionAvailable;
  // The dialog shell switches between sheet and centered dialog with `md:`; the one-column phone
  // flow must switch at the same width, or 768px would get the phone flow in the desktop shell.
  const narrow = useBelowMdViewport();
  const sections = getSettingsSections(memoryEnabled, remoteConnectionAvailable);
  const search = useSettingsSearch(sections, environment.platform);
  const mobile = useMobileSettingsView(narrow);
  // The row a search result opened: it scrolls into view and stays highlighted until the user
  // moves on (another section or another search).
  const [focusedSetting, setFocusedSetting] = useState<SettingsFocusTarget | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const actions = useSettingsActions(search, mobile, setFocusedSetting, searchInputRef);
  useSettingsRedirect(memoryEnabled, remoteConnectionAvailable);
  // The page stays mounted between opens; a highlight from last time must not greet the next
  // open (the search and phone view hooks reset themselves the same way).
  useEffect(() => registerOnClose(() => setFocusedSetting(null)), [registerOnClose]);

  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0];
  // Phones show one column at a time; wider screens show both.
  const showList = !narrow || mobile.listOpen || search.searching;
  const results = (
    <SettingsSearchResults
      query={search.query}
      groups={search.groups}
      activeIndex={search.activeIndex}
      onOpen={actions.openResult}
      onHover={search.setActiveIndex}
    />
  );

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && close()}>
      {/* Phone widths get a full-screen sheet; md+ gets a large centered dialog. */}
      <DialogContent
        showCloseButton={false}
        allowEditableEscape
        aria-describedby={undefined}
        onOpenAutoFocus={props.focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={props.focusReturn.onCloseAutoFocus}
        onKeyDown={actions.focusSearch}
        className="settings-surfaces bg-surface-primary border-border-light max-md:ios-standalone:top-px max-md:ios-standalone:h-[calc(100%-1px)] top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] max-md:pr-(--safe-area-right) max-md:pl-[env(safe-area-inset-left)] md:top-[50%] md:left-[calc(50%_+_(env(safe-area-inset-left,0px)_-_var(--safe-area-right))/2)] md:h-[min(880px,88vh)] md:w-[min(1160px,calc((100vw_-_env(safe-area-inset-left,0px)_-_var(--safe-area-right))*0.92))] md:translate-x-[-50%] md:translate-y-[-50%] md:flex-row md:rounded-lg md:border"
      >
        {showList ? (
          <SettingsListColumn
            narrow={narrow}
            sections={sections}
            currentSectionId={currentSection.id}
            search={search}
            searchInputRef={searchInputRef}
            results={results}
            onQueryChange={(query) => {
              search.setQuery(query);
              setFocusedSetting(null);
            }}
            onSearchKeyDown={(e) => handleSearchKeyDown(e, search, actions.openResult, close)}
            onOpenSection={actions.openSection}
          />
        ) : null}
        {narrow && showList ? null : (
          <SettingsContentColumn
            section={currentSection}
            search={search}
            results={results}
            focusedSetting={focusedSetting}
            onOpenSetting={actions.openSetting}
            onBack={narrow ? mobile.showList : null}
            titleHidden={!showList}
            onReturnToSetup={onboardingPause.paused ? close : null}
          />
        )}

        {/* One close button for both layouts: it sits in the top-right header row either way.
            Touch screens force buttons to a 44px minimum (globals.css), so a 24px box offset by
            0.75rem grew downward and sat below the "Settings" title. The button is therefore
            placed by its center (the translate classes), at the 48px header row's middle, so any
            box size stays aligned. That matters at exactly 768px on touch, where the md: size
            and the 44px minimum both apply. Phones get a 44px box. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          className="absolute top-[calc(env(safe-area-inset-top)+1.5rem)] right-[calc(1.625rem+var(--safe-area-right))] h-11 w-11 translate-x-1/2 -translate-y-1/2 md:right-9 md:h-6 md:w-6"
          aria-label="Close settings"
        >
          <X className="h-4 w-4" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
