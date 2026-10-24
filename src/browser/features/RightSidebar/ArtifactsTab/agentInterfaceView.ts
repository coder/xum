import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  isDesktopViewportFocused,
  isDialogOpen,
  isTerminalFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  AGENT_INTERFACE_VIEW_KEY,
  AGENT_INTERFACE_VIEW_MAX_CHARS,
  AGENT_INTERFACE_VIEW_MAX_WORKSPACES,
} from "@/common/constants/storage";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
} from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { useArtifactsRefreshTick } from "./useArtifactsRefreshTick";

/**
 * Agent interface view (artifacts-agent-interface, a sub-experiment of Artifacts): the main pane
 * shows the agent's status page instead of the chat transcript, and the user switches between
 * the two. This module owns the view choice and the status page's listing entry.
 */
export type AgentInterfaceView = "status" | "chat";

/**
 * The view a workspace shows. An explicit choice wins, the default is the status page, and a
 * missing status page always falls back to the transcript, so the pane is never blank.
 */
export function resolveAgentInterfaceView(input: {
  enabled: boolean;
  statusExists: boolean;
  stored: AgentInterfaceView | null;
}): AgentInterfaceView {
  if (!input.enabled || !input.statusExists) return "chat";
  return input.stored ?? "status";
}

/** Both flags: the sub-experiment does nothing while Artifacts is off. */
export function useAgentInterfaceEnabled(): boolean {
  const artifacts = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  const agentInterface = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE);
  return artifacts && agentInterface;
}

// Explicit choices only, in one bounded most-recently-used map (like artifactSelection.ts), so a
// workspace without a choice keeps following the default.
type ChoiceMap = Record<string, AgentInterfaceView>;
const EMPTY_CHOICES: ChoiceMap = {};

function isView(value: unknown): value is AgentInterfaceView {
  return value === "status" || value === "chat";
}

function choiceFrom(map: unknown, workspaceId: string): AgentInterfaceView | null {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return null;
  const value = (map as Record<string, unknown>)[workspaceId];
  return isView(value) ? value : null;
}

function withChoice(map: unknown, workspaceId: string, view: AgentInterfaceView): ChoiceMap {
  const kept =
    typeof map === "object" && map !== null && !Array.isArray(map)
      ? Object.entries(map as Record<string, unknown>).filter(
          (entry): entry is [string, AgentInterfaceView] =>
            entry[0] !== workspaceId && isView(entry[1])
        )
      : [];
  const entries = [...kept, [workspaceId, view] as [string, AgentInterfaceView]];
  const bounded = entries.slice(-AGENT_INTERFACE_VIEW_MAX_WORKSPACES);
  while (
    bounded.length > 1 &&
    JSON.stringify(Object.fromEntries(bounded)).length > AGENT_INTERFACE_VIEW_MAX_CHARS
  ) {
    bounded.shift();
  }
  return Object.fromEntries(bounded);
}

export function writeAgentInterfaceViewChoice(workspaceId: string, view: AgentInterfaceView) {
  updatePersistedState<unknown>(
    AGENT_INTERFACE_VIEW_KEY,
    (map: unknown) => withChoice(map, workspaceId, view),
    EMPTY_CHOICES
  );
}

function useAgentInterfaceViewChoice(workspaceId: string): AgentInterfaceView | null {
  const [map] = usePersistedState<unknown>(AGENT_INTERFACE_VIEW_KEY, EMPTY_CHOICES, {
    listener: true,
  });
  return choiceFrom(map, workspaceId);
}

// The status page's listing entry per workspace: absent until listed, null when there is none.
// A module store, so the main pane's single poll feeds the menu-bar toggle, the status view and
// the command palette without each listing the folder.
const statusEntries = new Map<string, ArtifactEntry | null>();
const statusListeners = new Set<() => void>();

function subscribeStatusEntries(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** What a change of the page means to readers: unlisted, none, or a version of the file. */
function entryKey(entry: ArtifactEntry | null | undefined): string | undefined {
  if (entry == null) return entry === null ? "none" : undefined;
  return `${entry.kind}\u0000${entry.modifiedMs}\u0000${entry.size}`;
}

function notifyStatusListeners() {
  for (const listener of statusListeners) listener();
}

function publishStatusEntry(workspaceId: string, entry: ArtifactEntry | null) {
  if (entryKey(statusEntries.get(workspaceId)) === entryKey(entry)) return;
  statusEntries.set(workspaceId, entry);
  notifyStatusListeners();
}

/** A version of the page's file, as both a listing entry and a read result describe it. */
interface FileVersion {
  modifiedMs: number;
  size: number;
}

function sameVersion(a: FileVersion | undefined, b: FileVersion | undefined): boolean {
  return a?.modifiedMs === b?.modifiedMs && a?.size === b?.size;
}

// The version of each workspace's status page that read as nothing to show (blank, binary or
// too large). Until the file changes, the workspace counts as having no page, so the main pane
// falls back to the transcript instead of a blank or "cannot be previewed" pane.
const unshowableStatusVersions = new Map<string, FileVersion>();

/** Whether a status page read has anything to show; else the pane falls back to the chat. */
export function isStatusPageReadShowable(read: ArtifactReadResult): boolean {
  return read.status === "ok" && read.content.trim() !== "";
}

/**
 * Whether a listed status page can be shown: an empty file never can, and a version that read
 * as unshowable cannot until the file changes.
 */
export function isStatusPageEntryShowable(
  entry: ArtifactEntry | null | undefined,
  unshowable: FileVersion | undefined
): boolean {
  if (entry == null || entry.size === 0) return false;
  return unshowable == null || !sameVersion(entry, unshowable);
}

/** Records a status page read; an unshowable one hides the page until the file changes. */
export function recordStatusPageRead(workspaceId: string, read: ArtifactReadResult) {
  const unshowable = isStatusPageReadShowable(read)
    ? undefined
    : { modifiedMs: read.modifiedMs, size: read.size };
  if (sameVersion(unshowableStatusVersions.get(workspaceId), unshowable)) return;
  if (unshowable == null) unshowableStatusVersions.delete(workspaceId);
  else unshowableStatusVersions.set(workspaceId, unshowable);
  notifyStatusListeners();
}

/** The status page's entry, or null when the workspace has none (or it is not listed yet). */
export function useStatusArtifactEntry(workspaceId: string): ArtifactEntry | null {
  return useSyncExternalStore(subscribeStatusEntries, () => statusEntries.get(workspaceId) ?? null);
}

function useStatusArtifactExists(workspaceId: string): boolean {
  return useSyncExternalStore(subscribeStatusEntries, () =>
    hasAgentInterfaceStatusPage(workspaceId)
  );
}

/** The status page's entry in a listing; null when the folder has none or is unavailable. */
function findStatusEntry(listing: ArtifactListing): ArtifactEntry | null {
  if (!listing.available) return null;
  return listing.entries.find((e) => e.path === AGENT_INTERFACE_STATUS_ARTIFACT) ?? null;
}

/**
 * Lists the artifacts folder for the status page while the view is enabled, on the same signals
 * as the Artifacts panel. Mount once per main pane. A failed listing keeps the last entry, so a
 * reconnect does not flip the pane back to the transcript.
 */
function useStatusArtifactPoll(workspaceId: string, enabled: boolean) {
  const { api } = useAPI();
  const listInFlightRef = useRef(false);
  const [refreshTick] = useArtifactsRefreshTick(workspaceId, {
    online: api != null,
    listInFlightRef,
    enabled,
  });
  useEffect(() => {
    if (!api || !enabled) return;
    const controller = new AbortController();
    listInFlightRef.current = true;
    api.artifacts
      .list({ workspaceId }, { signal: controller.signal })
      .finally(() => {
        if (!controller.signal.aborted) listInFlightRef.current = false;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success) publishStatusEntry(workspaceId, findStatusEntry(result.data));
        else console.debug("[Agent interface] status page listing failed:", result.error);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        // Often transient (a backend still starting): keep the last entry; the next tick retries.
        console.debug("[Agent interface] status page listing failed:", getErrorMessage(error));
      });
    return () => {
      controller.abort();
      listInFlightRef.current = false;
    };
  }, [api, workspaceId, enabled, refreshTick]);
}

/**
 * Whether the workspace can switch views (both flags on and a status page exists) and the view
 * it shows.
 */
export function useAgentInterfaceView(workspaceId: string): {
  available: boolean;
  view: AgentInterfaceView;
} {
  const enabled = useAgentInterfaceEnabled();
  const statusExists = useStatusArtifactExists(workspaceId);
  const stored = useAgentInterfaceViewChoice(workspaceId);
  return {
    available: enabled && statusExists,
    view: resolveAgentInterfaceView({ enabled, statusExists, stored }),
  };
}

/** Whether the main pane's last listing found a status page for the workspace that can show. */
export function hasAgentInterfaceStatusPage(workspaceId: string): boolean {
  return isStatusPageEntryShowable(
    statusEntries.get(workspaceId),
    unshowableStatusVersions.get(workspaceId)
  );
}

/** Flip the workspace between its status page and the transcript; a no-op without a page. */
export function toggleAgentInterfaceView(workspaceId: string) {
  if (!hasAgentInterfaceStatusPage(workspaceId)) return;
  const stored = choiceFrom(
    readPersistedState<unknown>(AGENT_INTERFACE_VIEW_KEY, EMPTY_CHOICES),
    workspaceId
  );
  const current = resolveAgentInterfaceView({ enabled: true, statusExists: true, stored });
  writeAgentInterfaceViewChoice(workspaceId, current === "status" ? "chat" : "status");
}

/**
 * The main pane's Agent interface view: lists the status page (once per main pane, feeding the
 * menu-bar toggle and the command palette too), owns the switch shortcut, and returns the view
 * to show, or null when there is nothing to switch to.
 */
export function useMainPaneAgentInterfaceView(workspaceId: string): AgentInterfaceView | null {
  const enabled = useAgentInterfaceEnabled();
  useStatusArtifactPoll(workspaceId, enabled);
  const { available, view } = useAgentInterfaceView(workspaceId);
  useEffect(() => {
    if (!available) return;
    const handler = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_AGENT_INTERFACE_VIEW) || isShortcutOwnedElsewhere(e)) {
        return;
      }
      e.preventDefault();
      toggleAgentInterfaceView(workspaceId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [available, workspaceId]);
  return available ? view : null;
}

/** Dialogs, terminals and remote desktops keep their keystrokes, as for the Artifacts chord. */
function isShortcutOwnedElsewhere(e: KeyboardEvent): boolean {
  return isDialogOpen() || isTerminalFocused(e.target) || isDesktopViewportFocused(e.target);
}
