import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SETTING_DEFINITIONS, type SettingId } from "../settingsRegistry";

/**
 * Shared settings layout: every section used to hand-write its own heading and row markup, so
 * headings, spacing and description colors differed between sections. These primitives give
 * converted sections one look: an uppercase group label over a bordered card of rows.
 */

export interface SettingsFocusTarget {
  /** `data-setting-id` of the row a search result opened. */
  id: string;
  /** Highlighted instead when the row is a sub-option its parent currently hides. */
  fallbackId?: string;
}

/** The row a search result opened: it scrolls into view and stays highlighted. */
export const SettingsFocusContext = createContext<SettingsFocusTarget | null>(null);

/**
 * Opens a setting from inside a section (an experiment's "Configure in" link) the way a search
 * result opens it: switch section, then scroll to and highlight the row. Null outside the page.
 */
export const SettingsOpenSettingContext = createContext<((id: SettingId) => void) | null>(null);

/**
 * A target inside a closed disclosure (the MCP "Add server" form) is in the DOM but not on
 * screen: open its disclosures so the result shows the fields, not a collapsed summary.
 */
function openEnclosingDetails(element: HTMLElement) {
  for (let details = element.closest("details"); details; ) {
    details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
}

/** True when `hiddenId` names a search target that is not on screen (its parent hides it). */
function isHiddenTarget(element: HTMLElement, hiddenId: string | null): boolean {
  if (hiddenId == null) return false;
  const anchors = element.ownerDocument.querySelectorAll("[data-setting-id]");
  return ![...anchors].some((anchor) => anchor.getAttribute("data-setting-id") === hiddenId);
}

/**
 * Whether this anchor is the search target: the row itself, or the parent of a hidden sub-option
 * the search opened. Scrolls the target into view once it is on screen.
 */
function resolveSearchTarget(target: SettingsFocusTarget | null, id: string) {
  if (!target) return { direct: false, fallbackFor: null };
  return { direct: target.id === id, fallbackFor: target.fallbackId === id ? target.id : null };
}

/** A mark has no box of its own: the block it marks is what scrolls into view. */
function scrollBoxOf(element: HTMLElement): HTMLElement | null {
  return element.hasAttribute("data-setting-mark") ? element.parentElement : element;
}

/** Brings the target (or the parent standing in for it) on screen. */
function revealSearchTarget(element: HTMLElement, direct: boolean, showFallback: boolean) {
  if (direct) openEnclosingDetails(element);
  if (direct || showFallback) scrollBoxOf(element)?.scrollIntoView?.({ block: "center" });
}

function useSearchFocus<T extends HTMLElement>(id: string) {
  const { direct, fallbackFor } = resolveSearchTarget(useContext(SettingsFocusContext), id);
  const [fallbackFocused, setFallbackFocused] = useState(false);
  const ref = useRef<T>(null);
  // The row mounts after the section switch a search result triggers, so it scrolls itself into
  // view once it exists (a DOM sync, not derived state). A parent can only tell whether its
  // hidden sub-option rendered by looking at the committed DOM.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const showFallback = isHiddenTarget(element, fallbackFor);
    setFallbackFocused(showFallback);
    revealSearchTarget(element, direct, showFallback);
  }, [direct, fallbackFor]);
  return { ref, focused: direct || (fallbackFor != null && fallbackFocused) };
}

export function SettingsAnchor(props: { id: string; className?: string; children: ReactNode }) {
  const { ref, focused } = useSearchFocus<HTMLDivElement>(props.id);
  return (
    <div
      ref={ref}
      data-setting-id={props.id}
      data-search-focused={focused ? "true" : undefined}
      className={props.className}
    >
      {props.children}
    </div>
  );
}

/**
 * Search target inside a block that is not a SettingRow (a provider card, a section heading, a
 * form). It renders no box: when search opens it, the block that contains it scrolls into view
 * and gets the same highlight as a row. One line per block, so sections keep their own markup.
 */
export function SettingsMark(props: { id: string }) {
  const { ref, focused } = useSearchFocus<HTMLSpanElement>(props.id);
  // The highlight belongs on the marked block, which this component does not render; React does
  // not manage this attribute on it, so setting it here does not fight a render.
  useEffect(() => {
    const block = ref.current?.parentElement;
    if (!focused || !block) return;
    block.setAttribute("data-search-focused", "true");
    return () => block.removeAttribute("data-search-focused");
  }, [focused, ref]);
  return <span ref={ref} data-setting-id={props.id} data-setting-mark="" hidden />;
}

/** The bordered, divided card under a group heading (also used by search results). */
export const SETTINGS_GROUP_CARD_CLASS =
  "border-border-light bg-surface-secondary divide-border-light divide-y overflow-hidden rounded-lg border";

/** Uppercase label above a group card. */
export const SETTINGS_GROUP_HEADING_CLASS =
  "text-content-secondary text-[11px] font-medium tracking-wider uppercase";

export function SettingsGroup(props: {
  title: string;
  description?: ReactNode;
  /** Controls on the heading line (a docs link, a group switch). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className={SETTINGS_GROUP_HEADING_CLASS}>{props.title}</h3>
          {props.description ? (
            <div className="text-content-secondary mt-1 text-xs">{props.description}</div>
          ) : null}
        </div>
        {props.actions}
      </div>
      <div className={SETTINGS_GROUP_CARD_CLASS}>{props.children}</div>
    </section>
  );
}

/**
 * One setting: label and description come from SETTING_DEFINITIONS, so search shows the same
 * copy the row does. The control wraps below the label at narrow widths.
 */
export function SettingRow(props: {
  id: SettingId;
  /** The control(s). */
  children: ReactNode;
  /** Extra lines under the description (status, warnings, previews). */
  hint?: ReactNode;
}) {
  const definition = SETTING_DEFINITIONS[props.id];
  return (
    <SettingsAnchor
      id={props.id}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3"
    >
      <div className="min-w-48 flex-1">
        <div className="text-content-primary text-sm">{definition.label}</div>
        {"description" in definition ? (
          <div className="text-content-secondary mt-0.5 text-xs">{definition.description}</div>
        ) : null}
        {props.hint}
      </div>
      <div className="flex max-w-full min-w-0 shrink-0 items-center gap-2">{props.children}</div>
    </SettingsAnchor>
  );
}

/** Container with the group card's look, for sections that keep their own inner layout. */
export const SETTINGS_CARD_CLASS =
  "border-border-light bg-surface-secondary min-w-0 rounded-lg border p-4";

/** Shared trigger styling for selects inside SettingRow (was repeated per row). */
export const SETTING_SELECT_TRIGGER_CLASS =
  "border-border-medium bg-surface-primary text-content-primary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors";
