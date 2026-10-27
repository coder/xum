import { useEffect, useRef, useSyncExternalStore } from "react";
import { type APIClient, useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  isDesktopViewportFocused,
  isDialogOpen,
  isTerminalFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { AGENT_INTERFACE_VIEW_KEY } from "@/common/constants/storage";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
} from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { isBlankHtmlDocument, parseArtifactHtml } from "./artifactDocument";
import {
  type AgentInterfaceView,
  choiceFrom,
  EMPTY_CHOICES,
  hasAgentInterfaceStatusPage,
  resolveAgentInterfaceView,
  sameVersion,
  statusEntries,
  toggleAgentInterfaceView,
  unshowableStatusVersions,
  useAgentInterfaceEnabled,
} from "./agentInterfaceViewState";
import { useArtifactsRefreshTick } from "./useArtifactsRefreshTick";

/**
 * Agent interface view (artifacts-agent-interface, a sub-experiment of Artifacts): the main pane
 * shows the agent's status page instead of the chat transcript, and the user switches between
 * the two. This module lists and reads the status page. agentInterfaceViewState.ts holds the view
 * choice and the page's listing entry.
 */

function useAgentInterfaceViewChoice(workspaceId: string): AgentInterfaceView | null {
  const [map] = usePersistedState<unknown>(AGENT_INTERFACE_VIEW_KEY, EMPTY_CHOICES, {
    listener: true,
  });
  return choiceFrom(map, workspaceId);
}

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

/** Whether a status page read has anything to show; else the pane falls back to the chat. */
export function isStatusPageReadShowable(read: ArtifactReadResult): boolean {
  if (read.status !== "ok" || read.content.trim() === "") return false;
  // An empty skeleton or a comment would leave a blank (in dark themes, white) pane.
  return read.kind !== "html" || !isBlankHtmlDocument(parseArtifactHtml(read.content));
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

/**
 * The status page's entry in a listing: null when the folder has none or is unavailable, and
 * undefined when a truncated listing leaves it out. Only a complete listing proves the page is
 * gone: past the listing cap it may still exist.
 */
function findStatusEntry(listing: ArtifactListing): ArtifactEntry | null | undefined {
  if (!listing.available) return null;
  const entry = listing.entries.find((e) => e.path === AGENT_INTERFACE_STATUS_ARTIFACT);
  return entry ?? (listing.truncated ? undefined : null);
}

function entryFromRead(read: ArtifactReadResult): ArtifactEntry {
  return { path: read.path, kind: read.kind, size: read.size, modifiedMs: read.modifiedMs };
}

// Successful listings of each workspace's artifacts folder: the main pane's own, or an open
// Artifacts panel's, which lists the same folder on the same signals. While a panel lists it, the
// main pane takes the panel's listings instead of walking the folder a second time (on a remote
// runtime each listing is a shell walk).
const folderListingListeners = new Set<(workspaceId: string, listing: ArtifactListing) => void>();
// How many Artifacts panels list each workspace's folder now.
const listingPanels = new Map<string, number>();

/** Hands a successful listing of the workspace's artifacts folder to the Agent interface view. */
export function shareArtifactListing(workspaceId: string, listing: ArtifactListing) {
  for (const listener of folderListingListeners) listener(workspaceId, listing);
}

/**
 * For the Artifacts panel, which shares each listing (shareArtifactListing): while it is mounted,
 * the main pane's poll does not list the workspace's folder itself.
 */
export function useArtifactsPanelListing(workspaceId: string) {
  useEffect(() => {
    listingPanels.set(workspaceId, (listingPanels.get(workspaceId) ?? 0) + 1);
    return () => {
      const left = (listingPanels.get(workspaceId) ?? 1) - 1;
      if (left > 0) listingPanels.set(workspaceId, left);
      else listingPanels.delete(workspaceId);
    };
  }, [workspaceId]);
}

// Called after each successful listing with whether a file-modifying tool call ended since the
// last one, so a status page read that failed or may be stale retries then: remote runtimes list
// whole-second mtimes, so a same-size rewrite can keep the listed version.
const listingListeners = new Set<(workspaceId: string, afterToolWrite: boolean) => void>();

export function subscribeStatusListings(
  workspaceId: string,
  listener: (afterToolWrite: boolean) => void
): () => void {
  const onListing = (listedId: string, afterToolWrite: boolean) => {
    if (listedId === workspaceId) listener(afterToolWrite);
  };
  listingListeners.add(onListing);
  return () => listingListeners.delete(onListing);
}

/**
 * Reads the status page; neither callback runs once `signal` aborts. Failures are logged.
 * `missing` tells a folder without the page apart from a read that failed (a reconnect).
 */
export function readStatusPage(
  api: APIClient,
  workspaceId: string,
  signal: AbortSignal,
  callbacks: { onRead: (read: ArtifactReadResult) => void; onFailure: (missing: boolean) => void }
): void {
  const failed = (error: string, missing: boolean) => {
    console.debug("[Agent interface] status page read failed:", error);
    callbacks.onFailure(missing);
  };
  api.artifacts
    .read({ workspaceId, path: AGENT_INTERFACE_STATUS_ARTIFACT }, { signal })
    .then((result) => {
      if (signal.aborted) return;
      if (result.success) callbacks.onRead(result.data);
      else failed(result.error, result.missing === true);
    })
    .catch((error: unknown) => {
      if (isAbortError(error) || signal.aborted) return;
      failed(getErrorMessage(error), false);
    });
}

/**
 * Reads a status page that read as unshowable again after a tool call that may have rewritten
 * it. The status view is unmounted then, and a same-size rewrite within the second keeps the
 * listed version, so nothing else would look at the file again.
 */
function useUnshowableStatusRecheck(workspaceId: string, enabled: boolean) {
  const { api } = useAPI();
  useEffect(() => {
    if (!api || !enabled) return;
    const controller = new AbortController();
    // A tool call, or a failed recheck, that no read has followed yet.
    let due = false;
    let reading = false;
    const unsubscribe = subscribeStatusListings(workspaceId, (afterToolWrite) => {
      const unshowable = unshowableStatusVersions.get(workspaceId);
      // A changed version is no longer hidden: the status view mounts and reads it.
      if (
        unshowable == null ||
        !sameVersion(statusEntries.get(workspaceId) ?? undefined, unshowable)
      ) {
        due = false;
        return;
      }
      due ||= afterToolWrite;
      if (!due || reading) return;
      due = false;
      reading = true;
      readStatusPage(api, workspaceId, controller.signal, {
        onRead: (read) => {
          reading = false;
          recordStatusPageRead(workspaceId, read);
        },
        onFailure: () => {
          reading = false;
          due = true;
        },
      });
    });
    return () => {
      unsubscribe();
      controller.abort();
    };
  }, [api, workspaceId, enabled]);
}

/**
 * Takes each listing of the workspace's folder, the main pane's or an Artifacts panel's: publishes
 * the status page's entry, and tells the listing listeners whether a file-modifying tool call
 * ended since the last listing. A truncated listing that leaves the page out says nothing about
 * it, so the page is read to learn its version; else a crowded folder would hide it for good. A
 * read that finds no page clears the entry (else a deleted page would stay on screen), and a
 * failed read keeps it.
 */
function useStatusListings(workspaceId: string, enabled: boolean) {
  const { api } = useAPI();
  useEffect(() => {
    if (!api || !enabled) return;
    const controller = new AbortController();
    let toolWrote = false;
    let reading = false;
    const unsubscribeTools = workspaceStore.subscribeFileModifyingTool(() => {
      toolWrote = true;
    }, workspaceId);
    const onListing = (listedId: string, listing: ArtifactListing) => {
      if (listedId !== workspaceId) return;
      const afterToolWrite = toolWrote;
      toolWrote = false;
      const entry = findStatusEntry(listing);
      if (entry !== undefined) {
        publishStatusEntry(workspaceId, entry);
      } else if (!reading) {
        reading = true;
        readStatusPage(api, workspaceId, controller.signal, {
          onRead: (read) => {
            reading = false;
            recordStatusPageRead(workspaceId, read);
            publishStatusEntry(workspaceId, entryFromRead(read));
          },
          onFailure: (missing) => {
            reading = false;
            if (missing) publishStatusEntry(workspaceId, null);
          },
        });
      }
      for (const listener of listingListeners) listener(workspaceId, afterToolWrite);
    };
    folderListingListeners.add(onListing);
    return () => {
      folderListingListeners.delete(onListing);
      unsubscribeTools();
      controller.abort();
    };
  }, [api, workspaceId, enabled]);
}

/**
 * Lists the artifacts folder for the status page while the view is enabled, on the same signals
 * as the Artifacts panel, unless a panel lists it (useArtifactsPanelListing). Mount once per main
 * pane. A failed listing keeps the last entry, so a reconnect does not flip the pane back to the
 * transcript.
 */
function useStatusArtifactPoll(workspaceId: string, enabled: boolean) {
  const { api } = useAPI();
  const listInFlightRef = useRef(false);
  const [refreshTick] = useArtifactsRefreshTick(workspaceId, {
    online: api != null,
    listInFlightRef,
    enabled,
  });
  useStatusListings(workspaceId, enabled);
  useEffect(() => {
    // The panel lists on these same ticks and shares each listing.
    if (!api || !enabled || listingPanels.has(workspaceId)) return;
    const controller = new AbortController();
    listInFlightRef.current = true;
    api.artifacts
      .list({ workspaceId }, { signal: controller.signal })
      .finally(() => {
        if (!controller.signal.aborted) listInFlightRef.current = false;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.success) {
          console.debug("[Agent interface] status page listing failed:", result.error);
          return;
        }
        shareArtifactListing(workspaceId, result.data);
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

/**
 * The main pane's Agent interface view: lists the status page (once per main pane, feeding the
 * menu-bar toggle and the command palette too), owns the switch shortcut, and returns the view
 * to show, or null when there is nothing to switch to.
 */
export function useMainPaneAgentInterfaceView(workspaceId: string): AgentInterfaceView | null {
  const enabled = useAgentInterfaceEnabled();
  useStatusArtifactPoll(workspaceId, enabled);
  useUnshowableStatusRecheck(workspaceId, enabled);
  const { available, view } = useAgentInterfaceView(workspaceId);
  useEffect(() => {
    if (!available) return;
    const handler = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_AGENT_INTERFACE_VIEW) || isShortcutOwnedElsewhere(e)) {
        return;
      }
      e.preventDefault();
      // A held chord would flip the view on every key repeat.
      if (e.repeat) return;
      // SECURITY AUDIT: a chord replayed from an artifact frame (dispatched on the iframe) may
      // come from the page's own script, which no gesture check reliably tells apart from the
      // user. It only ever leaves the status page for the transcript, the safe default, and the
      // main pane's status frame unmounts on that switch, so a script cannot flip the view back.
      const fromFrame = (e.target as Partial<Element> | null)?.tagName === "IFRAME";
      toggleAgentInterfaceView(workspaceId, fromFrame);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [available, workspaceId]);
  return available ? view : null;
}

/** Dialogs, terminals and remote desktops keep their keystrokes, as for the Artifacts chord. */
export function isShortcutOwnedElsewhere(e: KeyboardEvent): boolean {
  return isDialogOpen() || isTerminalFocused(e.target) || isDesktopViewportFocused(e.target);
}
