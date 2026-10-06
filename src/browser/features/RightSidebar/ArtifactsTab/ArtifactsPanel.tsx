import React, { useEffect, useRef, useState } from "react";
import {
  Download,
  Maximize2,
  MessageSquareOff,
  MessageSquarePlus,
  Minimize2,
  PinOff,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from "@/browser/components/Dialog/Dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { useReviews } from "@/browser/hooks/useReviews";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  formatKeybind,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
  ArtifactVersionList,
  PinnedArtifactFile,
  PinnedArtifactFiles,
  ArtifactShelfEntry,
  ArtifactShelfListing,
  ArtifactShelfScope,
} from "@/common/orpc/schemas/artifacts";
import { ARTIFACTS_SELECTION_MAX_WORKSPACES } from "@/common/constants/storage";
import { getErrorMessage } from "@/common/utils/errors";
import {
  getArtifactAnnotationSupport,
  textAnchorFromSelection,
  type ArtifactAnnotationPick,
} from "./artifactAnnotation";
import { ArtifactAnnotationPopover } from "./ArtifactAnnotationPopover";
import { downloadArtifact } from "./artifactDownload";
import { ArtifactVersionMenu } from "./ArtifactVersionMenu";
import { useArtifactInteractions } from "./useArtifactInteractions";
import { ArtifactViewer } from "./ArtifactViewer";
import { createCappedMemory, useCappedMemory } from "./cappedMemory";
import { McpAppFrame } from "./McpAppFrame";
import { mcpAppSelectionKey, summarizeToolArguments, useMcpAppViews } from "./mcpAppViewsStore";
import {
  type ArtifactSelection,
  type ArtifactSelectionScope,
  readArtifactSelection,
  useArtifactSelection,
  writeArtifactSelection,
} from "./artifactSelection";
import type { ArtifactFrameKey } from "./SandboxedArtifactFrame";

/** While the tab is visible, re-list this often to catch writes no tool event reports. */
const ARTIFACTS_POLL_MS = 3000;

interface ReadState {
  /** Identifies what was read (see Selection/readKey), so stale reads are never shown. */
  key: string;
  result: ArtifactReadResult | null;
  error: string | null;
}

/**
 * What the toolbar points at. An artifact with a stored version selected stays selectable after
 * its working file is gone (`entry` null), so old versions remain viewable.
 */
type Selection =
  | { scope: "pinned"; path: string; file: PinnedArtifactFile }
  | { scope: "shelf"; path: string; entry: ArtifactShelfEntry }
  | { scope: "artifact"; path: string; entry: ArtifactEntry | null; version: number | null };

/** Picker values carry the scope, since a pinned file and an artifact may share a path. */
function pickerValue(scope: ArtifactSelectionScope, path: string): string {
  return `${scope}:${path}`;
}

function parsePickerValue(value: string): { scope: ArtifactSelectionScope; path: string } | null {
  const colon = value.indexOf(":");
  const scope = value.slice(0, colon);
  if (scope !== "artifact" && scope !== "pinned" && scope !== "shelf") return null;
  return { scope, path: value.slice(colon + 1) };
}

/**
 * Picker value of the "Show N other files" row. It has no colon, so `parsePickerValue` rejects
 * it and it can never become a selection.
 */
const OTHER_FILES_TOGGLE_VALUE = "toggle-other-files";

/**
 * Splits the live files for the picker: files with stored versions (published, snapshotted at
 * turn end, or attached) lead, and the rest go under a collapsed "Other files" group. Agents
 * keep supporting files (for example screenshots that a published HTML artifact references) in
 * the same folder, and a flat newest-first list buried the file they published. Returns null
 * when only one kind exists: the picker then stays a flat list, so a folder with no stored
 * versions yet still shows every file. Both groups keep the listing order (newest first).
 * `versionOnlyPaths` (deleted files whose versions are kept) count as versioned too: they are
 * listed under "Artifacts", so deleting the published file must not bury it under the rest.
 */
function groupArtifactEntries(
  entries: readonly ArtifactEntry[],
  versionedPaths: readonly string[],
  versionOnlyPaths: readonly string[]
): { versioned: ArtifactEntry[]; other: ArtifactEntry[] } | null {
  const versionedSet = new Set(versionedPaths);
  const versioned = entries.filter((entry) => versionedSet.has(entry.path));
  const other = entries.filter((entry) => !versionedSet.has(entry.path));
  return versioned.length + versionOnlyPaths.length > 0 && other.length > 0
    ? { versioned, other }
    : null;
}

/** Shelf selection path: the shelf scope and entry name, so project and global never collide. */
export function shelfSelectionPath(entry: Pick<ArtifactShelfEntry, "scope" | "name">): string {
  return `${entry.scope}:${entry.name}`;
}

/**
 * The persisted selection when it still points at something, else the first artifact, else
 * the first pinned file, else the first deleted artifact that still has stored versions, else
 * the first other file, else the first shelf entry. `versionOnlyPaths` are artifacts whose
 * working file is gone but whose versions are kept; with no version selected they show their
 * latest stored version. `otherEntries` are the live files of the collapsed "Other files"
 * group (groupArtifactEntries): they come after every artifact, so a published file stays the
 * default even when it was deleted and only its versions remain.
 */
export function resolveSelection(input: {
  scope: ArtifactSelectionScope;
  path: string | null;
  version: number | null;
  entries: readonly ArtifactEntry[];
  otherEntries: readonly ArtifactEntry[];
  pinnedFiles: readonly PinnedArtifactFile[];
  versionOnlyPaths: readonly string[];
  shelfEntries: readonly ArtifactShelfEntry[];
}): Selection | null {
  if (input.scope === "shelf") {
    const entry = input.shelfEntries.find((e) => shelfSelectionPath(e) === input.path);
    if (entry) return { scope: "shelf", path: shelfSelectionPath(entry), entry };
  } else if (input.scope === "pinned") {
    const file = input.pinnedFiles.find((f) => f.path === input.path);
    if (file) return { scope: "pinned", path: file.path, file };
  } else {
    const entry =
      input.entries.find((e) => e.path === input.path) ??
      input.otherEntries.find((e) => e.path === input.path);
    if (entry) return { scope: "artifact", path: entry.path, entry, version: input.version };
    if (
      input.path != null &&
      (input.version != null || input.versionOnlyPaths.includes(input.path))
    ) {
      return { scope: "artifact", path: input.path, entry: null, version: input.version };
    }
  }
  const firstEntry = input.entries[0];
  if (firstEntry)
    return { scope: "artifact", path: firstEntry.path, entry: firstEntry, version: null };
  const firstPinned = input.pinnedFiles[0];
  if (firstPinned) return { scope: "pinned", path: firstPinned.path, file: firstPinned };
  const firstVersionOnly = input.versionOnlyPaths[0];
  if (firstVersionOnly != null) {
    return { scope: "artifact", path: firstVersionOnly, entry: null, version: null };
  }
  const firstOther = input.otherEntries[0];
  if (firstOther)
    return { scope: "artifact", path: firstOther.path, entry: firstOther, version: null };
  const firstShelf = input.shelfEntries[0];
  if (firstShelf)
    return { scope: "shelf", path: shelfSelectionPath(firstShelf), entry: firstShelf };
  return null;
}

/**
 * The picker's Radix Select. Choosing the "Other files" toggle row runs `onToggleOtherFiles`
 * and keeps the list open, so the user can pick from the files it just showed; every other
 * value goes to `onValueChange`. The open state lives here, not in the panel: the panel renders
 * the toolbar twice while fullscreen, and each picker must open on its own.
 */
function ArtifactPickerSelect(props: {
  value: string;
  onValueChange: (value: string) => void;
  onToggleOtherFiles: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Radix closes the list right after every pick; this swallows that one close for the toggle.
  const keepOpenRef = useRef(false);
  return (
    <Select
      value={props.value}
      open={open}
      onOpenChange={(next) => {
        const keepOpen = keepOpenRef.current;
        keepOpenRef.current = false;
        if (!next && keepOpen) return;
        setOpen(next);
      }}
      onValueChange={(value) => {
        if (value !== OTHER_FILES_TOGGLE_VALUE) {
          props.onValueChange(value);
          return;
        }
        // Only a pick from the open list toggles: type-ahead on the closed trigger can land
        // here too, and Radix sends no close after it.
        if (open) {
          keepOpenRef.current = true;
          props.onToggleOtherFiles();
        }
      }}
    >
      {props.children}
    </Select>
  );
}

// Workspaces with annotate mode on. A sidebar tab switch unmounts the panel, and component state
// alone turned annotate off while fullscreen kept it. Shared by every mounted panel of the
// workspace (cappedMemory.ts). Bounded like the persisted selection map; only "on" is stored,
// so a workspace dropped from the map is simply off.
const annotatingWorkspaces = createCappedMemory<true>(ARTIFACTS_SELECTION_MAX_WORKSPACES);

/**
 * Artifacts tab (experiment: "artifacts"): files the agent writes to
 * $XUM_SCRATCH_DIR/artifacts, listed newest first with a preview of the selected one.
 * `inDialog` is set by the small-viewport dialog, which is already near full screen and whose
 * focus trap would fight a second full-screen overlay, so fullscreen is not offered there.
 */
export function ArtifactsPanel(props: {
  workspaceId: string;
  inDialog?: boolean;
  /** Take focus once rendered (the tab was opened by shortcut), then report it consumed. */
  autoFocus?: boolean;
  onAutoFocusConsumed?: () => void;
}) {
  const allowFullscreen = props.inDialog !== true;
  const { api } = useAPI();
  const [listing, setListing] = useState<ArtifactListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [readState, setReadState] = useState<ReadState | null>(null);
  // Whether the latest preview read failed: the next successful re-list (poll or file event)
  // retries it, so a transient error does not stick until the selection changes.
  const readFailedRef = useRef(false);
  // path -> modifiedMs the user has seen. Seeded with the first listing so only changes made
  // while the tab is open get a dot.
  const [seen, setSeen] = useState<ReadonlyMap<string, number> | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Annotate mode (M5b): comments on the selected artifact become review notes in the composer.
  const annotateMode = useCappedMemory(
    annotatingWorkspaces,
    props.workspaceId,
    (on) => on === true
  );
  const setAnnotateMode = (on: boolean) =>
    annotatingWorkspaces.set(props.workspaceId, on ? true : undefined);
  const [annotationPick, setAnnotationPick] = useState<{
    key: string;
    pick: ArtifactAnnotationPick;
  } | null>(null);
  const reviews = useReviews(props.workspaceId);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The tab shortcuts (handleKeyDown) only see keys while focus is inside the panel. A shortcut
  // that opens the tab leaves focus where it was, usually the chat input, so take it here.
  // An effect, because the panel may only just have mounted: focus is a DOM side effect.
  // Chrome counts script focus as :focus-visible only after a key press that types something, so
  // "click the chat, press Ctrl+Shift+K" focused the panel with no ring. The shortcut is keyboard
  // use, so the panel shows its ring until it loses focus.
  const [shortcutFocused, setShortcutFocused] = useState(false);
  // The same for the fullscreen dialog, which shortcuts focus by script too (onOpenAutoFocus,
  // keepFocusForShortcuts).
  const [dialogShortcutFocused, setDialogShortcutFocused] = useState(false);
  const { autoFocus, onAutoFocusConsumed } = props;
  useEffect(() => {
    if (autoFocus !== true) return;
    panelRef.current?.focus();
    setShortcutFocused(document.activeElement === panelRef.current);
    onAutoFocusConsumed?.();
  }, [autoFocus, onAutoFocusConsumed]);
  // Set while a list request runs, so a slow walk is not aborted by the next poll tick.
  const listInFlightRef = useRef(false);
  const [pinned, setPinned] = useState<PinnedArtifactFiles | null>(null);
  const [shelf, setShelf] = useState<ArtifactShelfListing | null>(null);
  const [versionsState, setVersionsState] = useState<{
    path: string;
    list: ArtifactVersionList | null;
    /** Why listVersions failed; shown instead of a stored version that cannot be resolved. */
    error: string | null;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The "Other files" picker group (groupArtifactEntries). Not persisted: it starts collapsed.
  const [otherFilesExpanded, setOtherFilesExpanded] = useState(false);
  // openArtifact() (chat cards, file cards, palette) writes the selection before asking for the
  // tab; the listener keeps a mounted panel in sync with those writes.
  // MCP Apps: "Open in Artifacts" on a tool card selects its view through the path.
  const {
    path: selectedPath,
    version: selectedVersion,
    scope: selectedScope,
  } = useArtifactSelection(props.workspaceId);
  const setSelection = (next: Partial<ArtifactSelection>) =>
    writeArtifactSelection(props.workspaceId, next);
  const appViews = useMcpAppViews(props.workspaceId);
  const selectedApp =
    appViews.find((view) => mcpAppSelectionKey(view.toolCallId) === selectedPath) ?? null;

  const select = (next: { scope: ArtifactSelectionScope; path: string | null }) => {
    setActionError(null);
    setSelection({ scope: next.scope, path: next.path, version: null });
  };

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    listInFlightRef.current = true;
    api.artifacts
      .list({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .finally(() => {
        if (!controller.signal.aborted) listInFlightRef.current = false;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.success) {
          setListError(result.error);
          return;
        }
        setListError(null);
        setListing(result.data);
        if (readFailedRef.current) {
          readFailedRef.current = false;
          setReloadTick((tick) => tick + 1);
        }
        const entries = result.data.available ? result.data.entries : [];
        setSeen((prev) => prev ?? new Map(entries.map((e) => [e.path, e.modifiedMs])));
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setListError(getErrorMessage(error));
      });
    return () => {
      controller.abort();
      listInFlightRef.current = false;
    };
  }, [api, props.workspaceId, refreshTick]);

  // Pinned checkout files are live: re-list them on the same refresh signal as the artifacts,
  // and their mtimes drive re-reads like an artifact's.
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.artifacts
      .listPinned({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPinned(result.success ? result.data : { available: false, reason: result.error });
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setPinned({ available: false, reason: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [api, props.workspaceId, refreshTick]);

  // Shelf (M5c): pins shared by every workspace of the project, plus the global shelf. Re-listed
  // on the same refresh signal so a pin made in another workspace shows up here too.
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.artifacts
      .listShelf({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success) setShelf(result.data);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        // A failed shelf listing hides the group; the rest of the tab keeps working.
        setShelf(null);
      });
    return () => controller.abort();
  }, [api, props.workspaceId, refreshTick]);

  // Re-list after the agent's file edits and bash commands, the usual ways it writes files.
  useEffect(() => {
    return workspaceStore.subscribeFileModifyingTool((wsId) => {
      if (wsId === props.workspaceId) setRefreshTick((tick) => tick + 1);
    }, props.workspaceId);
  }, [props.workspaceId]);

  // Writes by scripts or other tools emit no event, so poll while the window is visible.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !listInFlightRef.current) {
        setRefreshTick((tick) => tick + 1);
      }
    }, ARTIFACTS_POLL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const entries: ArtifactEntry[] = listing?.available === true ? listing.entries : [];
  const pinnedFiles: PinnedArtifactFile[] = pinned?.available === true ? pinned.files : [];
  // Deleted working files whose versions are kept stay listed and selectable. Only a complete
  // listing proves a file is gone: past the listing cap it may still exist (as artifact_list
  // does). An explicitly chosen stored version stays viewable either way.
  const versionOnlyPaths: string[] =
    listing?.available === true && !listing.truncated
      ? (listing.versionedPaths ?? []).filter((path) => !entries.some((e) => e.path === path))
      : [];
  const entryGroups =
    listing?.available === true
      ? groupArtifactEntries(entries, listing.versionedPaths ?? [], versionOnlyPaths)
      : null;
  // Project entries first, then global (the picker order).
  const shelfEntries: ArtifactShelfEntry[] = [
    ...(shelf?.project.available === true ? shelf.project.entries : []),
    ...(shelf?.global ?? []),
  ];
  // A pinned or shelf selection waits for its list instead of flashing the first artifact.
  const waitingForPinned =
    selectedPath != null &&
    ((selectedScope === "pinned" && pinned == null) ||
      (selectedScope === "shelf" && shelf == null));

  const selected =
    selectedApp != null || waitingForPinned
      ? null
      : resolveSelection({
          scope: selectedScope,
          path: selectedPath,
          version: selectedVersion,
          entries: entryGroups?.versioned ?? entries,
          otherEntries: entryGroups?.other ?? [],
          pinnedFiles,
          versionOnlyPaths,
          shelfEntries,
        });
  const selectedArtifactPath = selected?.scope === "artifact" ? selected.path : null;
  const selectedVersionForFetch = selected?.scope === "artifact" ? selected.version : null;

  // Versions of the selected artifact, refetched on every refresh: a publish or turn-end
  // snapshot adds a version without changing the working file.
  useEffect(() => {
    if (!api || selectedArtifactPath == null) return;
    const path = selectedArtifactPath;
    const controller = new AbortController();
    api.artifacts
      .listVersions({ workspaceId: props.workspaceId, path }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setVersionsState(
          result.success
            ? { path, list: result.data, error: null }
            : { path, list: null, error: result.error }
        );
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setVersionsState({ path, list: null, error: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [api, props.workspaceId, selectedArtifactPath, selectedVersionForFetch, refreshTick]);

  const versionList =
    selected?.scope === "artifact" && versionsState?.path === selected.path
      ? versionsState.list
      : null;
  const versionListError =
    selected?.scope === "artifact" && versionsState?.path === selected.path
      ? versionsState.error
      : null;
  // A deleted working file with no version chosen shows its latest stored version.
  const versionToRead =
    selected?.scope === "artifact"
      ? (selected.version ??
        (selected.entry == null ? (versionList?.versions[0]?.version ?? null) : null))
      : null;

  // What to read and how. Stored versions need the artifact id, which listVersions reports.
  let readRequest:
    | { key: string; kind: "live"; path: string; modifiedMs: number }
    | { key: string; kind: "pinned"; path: string }
    | { key: string; kind: "version"; artifactId: string; version: number }
    | { key: string; kind: "shelf"; scope: ArtifactShelfScope; name: string }
    | null = null;
  if (selected?.scope === "shelf") {
    // Read-only copies: the key changes only when the entry is pinned again.
    readRequest = {
      key: `shelf\u0000${selected.path}\u0000${selected.entry.pinnedAtMs}`,
      kind: "shelf",
      scope: selected.entry.scope,
      name: selected.entry.name,
    };
  } else if (selected?.scope === "pinned") {
    readRequest = {
      key: `pinned\u0000${selected.path}\u0000${selected.file.modifiedMs ?? "missing"}`,
      kind: "pinned",
      path: selected.path,
    };
  } else if (
    selected?.scope === "artifact" &&
    (selected.version != null || selected.entry == null)
  ) {
    if (versionList != null && versionToRead != null) {
      readRequest = {
        key: `version\u0000${versionList.artifactId}\u0000${versionToRead}`,
        kind: "version",
        artifactId: versionList.artifactId,
        version: versionToRead,
      };
    }
  } else if (selected?.scope === "artifact" && selected.entry != null) {
    readRequest = {
      // Size too: a same-mtime rewrite (`cp -p`, 1 s mtime resolution) still changes the key.
      key: `live\u0000${selected.path}\u0000${selected.entry.modifiedMs}\u0000${selected.entry.size}`,
      kind: "live",
      path: selected.path,
      modifiedMs: selected.entry.modifiedMs,
    };
  }
  const readKey = readRequest?.key ?? null;

  useEffect(() => {
    readFailedRef.current = false;
    if (!api || readRequest == null) return;
    const request = readRequest;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const workspaceId = props.workspaceId;
    const read =
      request.kind === "live"
        ? api.artifacts.read({ workspaceId, path: request.path }, options)
        : request.kind === "pinned"
          ? api.artifacts.readPinned({ workspaceId, path: request.path }, options)
          : request.kind === "shelf"
            ? api.artifacts.readShelf(
                { workspaceId, scope: request.scope, name: request.name },
                options
              )
            : api.artifacts.readVersion(
                { workspaceId, artifactId: request.artifactId, version: request.version },
                options
              );
    read
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success) {
          setReadState({ key: request.key, result: result.data, error: null });
          if (request.kind === "live") {
            setSeen((prev) => new Map(prev ?? []).set(request.path, request.modifiedMs));
          }
        } else {
          readFailedRef.current = true;
          setReadState({ key: request.key, result: null, error: result.error });
        }
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        readFailedRef.current = true;
        setReadState({ key: request.key, result: null, error: getErrorMessage(error) });
      });
    return () => controller.abort();
    // readKey identifies the request (scope, path, mtime or version): re-read when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.workspaceId, readKey, reloadTick]);

  // Nothing left to show: close fullscreen so it cannot pop back when a file reappears.
  if (fullscreen && selected == null && listing != null && !waitingForPinned) {
    setFullscreen(false);
  }
  // Fullscreen only makes sense with something selected.
  const showFullscreen = allowFullscreen && fullscreen && selected != null;

  // Picker order: pinned files first, then artifacts, then deleted artifacts with stored
  // versions. A selected version whose working file is gone keeps its own entry so the picker
  // can still name it.
  const deletedPaths = [...versionOnlyPaths];
  if (
    selected?.scope === "artifact" &&
    selected.entry == null &&
    !deletedPaths.includes(selected.path)
  ) {
    deletedPaths.push(selected.path);
  }
  // With groups, other files come after the deleted artifacts. While the group is collapsed only
  // the selected one stays listed: Radix needs the selected item mounted to name it in the
  // trigger, and the user must see what is selected.
  const artifactGroupEntries = entryGroups?.versioned ?? entries;
  const otherFiles = entryGroups?.other ?? [];
  const visibleOtherFiles = otherFilesExpanded
    ? otherFiles
    : otherFiles.filter((entry) => selected?.scope === "artifact" && entry.path === selected.path);
  const hiddenOtherCount = otherFiles.length - visibleOtherFiles.length;
  // J/K follow what the picker shows, so they skip hidden other files.
  const options: Array<{ scope: ArtifactSelectionScope; path: string }> = [
    ...pinnedFiles.map((file) => ({ scope: "pinned" as const, path: file.path })),
    ...artifactGroupEntries.map((entry) => ({ scope: "artifact" as const, path: entry.path })),
    ...deletedPaths.map((path) => ({ scope: "artifact" as const, path })),
    ...visibleOtherFiles.map((entry) => ({ scope: "artifact" as const, path: entry.path })),
  ];
  options.push(
    ...shelfEntries.map((entry) => ({ scope: "shelf" as const, path: shelfSelectionPath(entry) }))
  );

  const selectRelative = (offset: number) => {
    if (options.length === 0) return;
    const index = selected
      ? options.findIndex((o) => o.scope === selected.scope && o.path === selected.path)
      : -1;
    const next = options[Math.min(Math.max(index + offset, 0), options.length - 1)];
    if (next) select(next);
  };

  const unpinSelected = () => {
    if (!api || selected?.scope !== "pinned") return;
    const path = selected.path;
    api.artifacts
      .unpinFile({ workspaceId: props.workspaceId, path })
      .then((result) => {
        if (!result.success) {
          setActionError(result.error);
          return;
        }
        // Leave the unpinned file only if it is still selected: the user may have moved on
        // while the request ran.
        const current = readArtifactSelection(props.workspaceId);
        if (current.scope === "pinned" && current.path === path) {
          select({ scope: "artifact", path: null });
        }
        setRefreshTick((tick) => tick + 1);
      })
      .catch((error: unknown) => setActionError(getErrorMessage(error)));
  };

  const unpinShelfSelected = () => {
    if (!api || selected?.scope !== "shelf") return;
    const { scope, name, pinnedAtMs } = selected.entry;
    api.artifacts
      .unpinShelf({ workspaceId: props.workspaceId, scope, name, expectedPinnedAtMs: pinnedAtMs })
      .then((result) => {
        if (!result.success) {
          setActionError(result.error);
          return;
        }
        select({ scope: "artifact", path: null });
        setRefreshTick((tick) => tick + 1);
      })
      .catch((error: unknown) => setActionError(getErrorMessage(error)));
  };

  // User pin from the version menu: copies the shown version (or the newest stored one while
  // following the live file) to the shelf.
  const pinToShelf = (scope: ArtifactShelfScope) => {
    if (!api || selected?.scope !== "artifact" || versionList == null) return;
    const version = selected.version ?? versionList.versions[0]?.version;
    if (version == null) return;
    api.artifacts
      .pinToShelf({
        workspaceId: props.workspaceId,
        artifactId: versionList.artifactId,
        version,
        scope,
      })
      .then((result) => {
        setActionError(result.success ? null : result.error);
        if (result.success) setRefreshTick((tick) => tick + 1);
      })
      .catch((error: unknown) => setActionError(getErrorMessage(error)));
  };

  const reload = () => {
    setRefreshTick((tick) => tick + 1);
    setReloadTick((tick) => tick + 1);
  };

  // Which annotate flavour the selected artifact supports: text selection on Xum-rendered kinds,
  // pins inside the sandboxed frame, or none (images, PDFs, pinned files, app views). A live view
  // also waits for its version list: annotations record the version they were made on, and
  // before the list arrives that version is unknown.
  const annotationVersionKnown =
    selected?.scope === "artifact" &&
    (selected.version != null || versionsState?.path === selected.path);
  const annotateResult =
    selectedApp == null &&
    selected?.scope === "artifact" &&
    annotationVersionKnown &&
    readKey != null
      ? readState?.key === readKey && readState.result?.status === "ok"
        ? readState.result
        : null
      : null;
  const annotateSupport =
    annotateResult == null ? null : getArtifactAnnotationSupport(annotateResult.kind);
  const annotating = annotateMode && annotateSupport != null;
  const annotationVersion =
    selected?.scope === "artifact"
      ? (selected.version ?? versionList?.versions[0]?.version ?? 0)
      : 0;
  const pickKey = readKey ?? "";
  const pendingPick = annotating && annotationPick?.key === pickKey ? annotationPick.pick : null;
  const openAnnotation = (pick: ArtifactAnnotationPick) =>
    setAnnotationPick({ key: pickKey, pick });
  const addAnnotation = (pick: ArtifactAnnotationPick, comment: string) => {
    if (selected?.scope !== "artifact") return;
    reviews.addReview({
      filePath: selected.path,
      lineRange: "",
      selectedCode: pick.anchor.kind === "text" ? pick.anchor.quote : "",
      userNote: comment,
      artifact: { version: annotationVersion, anchor: pick.anchor },
    });
    window.getSelection()?.removeAllRanges();
    setAnnotationPick(null);
  };
  const toggleAnnotate = () => {
    if (annotateSupport == null) return;
    setAnnotationPick(null);
    setAnnotateMode(!annotating);
  };
  // Escape steps out of annotating one layer at a time: an open comment box first, then annotate
  // mode. Returns whether it consumed the key, so fullscreen closes only on a later Escape.
  const escapeAnnotate = (): boolean => {
    if (pendingPick != null) {
      setAnnotationPick(null);
      return true;
    }
    if (!annotating) return false;
    setAnnotateMode(false);
    return true;
  };

  // Tab-scoped shortcuts: they only fire while focus is inside this panel (or its fullscreen
  // overlay, whose events bubble here through the portal).
  // Shortcuts that change the selection swap the viewer. A focused control inside it (a JSON
  // tree toggle, a zoom button) unmounts with it, focus falls to the body, and every later
  // shortcut is lost. Move focus to the panel first, or to the fullscreen dialog, whose focus
  // trap would pull focus straight back from the panel behind it.
  const keepFocusForShortcuts = (target: EventTarget) => {
    const panel = panelRef.current;
    if (panel == null || !(target instanceof HTMLElement) || target === panel) return;
    const dialog = target.closest<HTMLElement>('[role="dialog"]');
    if (dialog != null && !dialog.contains(panel)) {
      dialog.focus();
      setDialogShortcutFocused(document.activeElement === dialog);
    } else {
      panel.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableElement(e.target)) return;
    const inPopup =
      e.target instanceof Element && e.target.closest('[role="listbox"],[role="menu"]') != null;
    // Escape before the picker guard below: the closed picker trigger does not use Escape, so
    // annotate mode must end from there too. An open list or the version menu keeps Escape to
    // close itself. defaultPrevented: in fullscreen the dialog's onEscapeKeyDown already
    // handled this Escape.
    if (matchesKeybind(e, KEYBINDS.CANCEL)) {
      if (!inPopup && !e.defaultPrevented && escapeAnnotate()) {
        e.preventDefault();
        // The panel is not editable, so without this Escape-to-interrupt would also fire.
        stopKeyboardPropagation(e);
      }
      return;
    }
    // The picker (open list, or its focused closed trigger, where Radix runs type-ahead) and the
    // version menu own their keys; J/K/R must not change the selection behind them.
    if (inPopup || (e.target instanceof Element && e.target.closest('[role="combobox"]') != null)) {
      return;
    }
    // The send strip's Send/Dismiss chords, while it is shown (useArtifactInteractions.tsx).
    if (interactions.handleKeyDown(e)) return;
    if (matchesKeybind(e, KEYBINDS.TOGGLE_ARTIFACT_FULLSCREEN)) {
      e.preventDefault();
      if (selected && allowFullscreen) setFullscreen(!showFullscreen);
    } else if (matchesKeybind(e, KEYBINDS.NEXT_ARTIFACT)) {
      e.preventDefault();
      keepFocusForShortcuts(e.target);
      selectRelative(1);
    } else if (matchesKeybind(e, KEYBINDS.PREV_ARTIFACT)) {
      e.preventDefault();
      keepFocusForShortcuts(e.target);
      selectRelative(-1);
    } else if (matchesKeybind(e, KEYBINDS.RELOAD_ARTIFACT)) {
      e.preventDefault();
      reload();
    } else if (matchesKeybind(e, KEYBINDS.UNPIN_ARTIFACT_FILE) && selected?.scope === "pinned") {
      e.preventDefault();
      keepFocusForShortcuts(e.target);
      unpinSelected();
    } else if (matchesKeybind(e, KEYBINDS.PIN_ARTIFACT_TO_PROJECT_SHELF)) {
      e.preventDefault();
      if (shelf?.project.available === true) pinToShelf("project");
    } else if (matchesKeybind(e, KEYBINDS.PIN_ARTIFACT_TO_GLOBAL_SHELF)) {
      e.preventDefault();
      pinToShelf("global");
    } else if (matchesKeybind(e, KEYBINDS.UNPIN_SHELF_ENTRY)) {
      e.preventDefault();
      keepFocusForShortcuts(e.target);
      unpinShelfSelected();
    } else if (matchesKeybind(e, KEYBINDS.TOGGLE_ARTIFACT_ANNOTATE)) {
      e.preventDefault();
      toggleAnnotate();
    }
  };

  // Escape and Shift+F pressed inside a sandboxed HTML/SVG frame arrive over the bridge,
  // because key events inside the frame never reach this panel's onKeyDown. They can only
  // EXIT fullscreen: the artifact's own script can post either message without a key press,
  // and entering fullscreen remounts the frame, so a frame able to enter could loop the
  // viewer between panel and dialog forever. Enter with Shift+F outside the frame or the
  // toolbar button.
  // Escape peels the same layers as outside the frame (comment box, annotate mode, then
  // fullscreen); leaving annotate mode is an exit too, so the frame may trigger it.
  const handleFrameKey = (key: ArtifactFrameKey) => {
    if (key === "Escape" && escapeAnnotate()) return;
    if (showFullscreen) setFullscreen(false);
  };

  // window.xum.send / setState for the selected artifact (M5b); pinned files and app views
  // are not interactive.
  const interactions = useArtifactInteractions(
    props.workspaceId,
    selectedApp == null && selected?.scope === "artifact"
      ? {
          path: selected.path,
          version: selected.version,
          latestVersion: versionList?.versions[0]?.version ?? null,
        }
      : null
  );

  const currentRead = readKey != null && readState?.key === readKey ? readState : null;
  const currentResult = currentRead?.result ?? null;
  // Text arrives decoded as UTF-8 with U+FFFD for invalid bytes (e.g. Windows-1252 files).
  // Downloading would re-encode that string and save different bytes than the file on disk,
  // so such files are not downloadable here; the original stays in the artifacts folder.
  const lossyText =
    currentResult?.status === "ok" &&
    currentResult.encoding === "utf8" &&
    currentResult.content.includes("\uFFFD");
  const downloadableResult = currentResult?.status === "ok" && !lossyText ? currentResult : null;

  const viewerBody =
    selectedApp != null ? (
      <McpAppFrame
        // Reload remounts the view, so it re-fetches its resource and result.
        key={`${selectedApp.toolCallId}\u0000${reloadTick}`}
        workspaceId={props.workspaceId}
        view={selectedApp}
      />
    ) : selected == null && !waitingForPinned ? null : currentRead?.result ? (
      <ArtifactViewer
        // Remount per file version so renderer state (zoom, JSON mode, frames) starts fresh.
        key={currentRead.key}
        // Same version, so the JSON mode survives fullscreen and tab-switch remounts (N7).
        viewKey={`${props.workspaceId}\u0000${currentRead.key}`}
        result={currentRead.result}
        workspaceId={props.workspaceId}
        artifactsDir={
          selected?.scope === "artifact" && listing?.available === true ? listing.dir : null
        }
        // Pinned files and shelf copies have no artifacts folder around them.
        readRelativeAssets={selected?.scope === "artifact"}
        onFrameKey={handleFrameKey}
        interactions={interactions.handlers}
        onFrameAnnotate={annotating && annotateSupport === "frame" ? openAnnotation : undefined}
        reloadToken={refreshTick}
      />
    ) : currentRead?.error ? (
      <div className="text-danger p-4 text-xs">{currentRead.error}</div>
    ) : readRequest == null && versionListError != null ? (
      // A stored version is resolved through listVersions: without it there is nothing to read.
      <div className="text-danger p-4 text-xs">{versionListError}</div>
    ) : (
      <div className="text-muted p-4 text-xs">Loading…</div>
    );

  // Xum-rendered kinds: a text selection inside the viewer opens the comment popover.
  const viewerScroll = (
    <div
      className={`min-h-0 flex-1 overflow-auto ${annotating ? "cursor-text" : ""}`}
      onMouseUp={
        annotating && annotateSupport === "host"
          ? (e) => {
              const pick = textAnchorFromSelection(e.currentTarget, window.getSelection());
              if (pick != null) openAnnotation(pick);
            }
          : undefined
      }
    >
      {viewerBody}
    </div>
  );

  const changedPaths = new Set(
    entries
      .filter(
        (entry) =>
          !(selected?.scope === "artifact" && entry.path === selected.path) &&
          seen != null &&
          (seen.get(entry.path) ?? -1) < entry.modifiedMs
      )
      .map((entry) => entry.path)
  );

  // globals.css removes outlines everywhere, so keyboard focus needs its own ring (B3).
  const toolbarButtonClassName =
    "border-border-light text-muted hover:text-foreground bg-background focus-visible:ring-accent flex h-6 w-6 items-center justify-center rounded border focus-visible:ring-1 disabled:opacity-40";

  const versions = versionList?.versions ?? [];
  const changedDot = (
    <span aria-label="Changed" className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" />
  );
  const entryItem = (entry: ArtifactEntry) => (
    <SelectItem key={entry.path} value={pickerValue("artifact", entry.path)} className="text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{entry.path}</span>
        {changedPaths.has(entry.path) && changedDot}
      </span>
    </SelectItem>
  );
  const artifactItems = (
    <>
      {artifactGroupEntries.map(entryItem)}
      {deletedPaths.map((path) => (
        <SelectItem key={path} value={pickerValue("artifact", path)} className="text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{path}</span>
            <span className="text-muted shrink-0">deleted</span>
          </span>
        </SelectItem>
      ))}
    </>
  );

  // Toolbar layout follows the brainstorm demo: picker | version | fullscreen | reload. Pinned
  // files have no versions; their slot holds the unpin action instead.
  const artbar = (
    <div className="border-border-light bg-sidebar flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
      <ArtifactPickerSelect
        value={
          selectedApp
            ? mcpAppSelectionKey(selectedApp.toolCallId)
            : selected
              ? pickerValue(selected.scope, selected.path)
              : ""
        }
        onToggleOtherFiles={() => setOtherFilesExpanded(!otherFilesExpanded)}
        onValueChange={(value) => {
          if (appViews.some((view) => mcpAppSelectionKey(view.toolCallId) === value)) {
            select({ scope: "artifact", path: value });
            return;
          }
          const next = parsePickerValue(value);
          if (next) select(next);
        }}
      >
        <SelectTrigger
          aria-label="Artifact"
          className="h-6 min-w-0 flex-1 justify-between px-2 text-xs [&>span]:min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        {/* Never wider than the space Radix measured, so long paths cannot overflow the screen. */}
        <SelectContent className="max-w-(--radix-select-content-available-width)">
          {pinnedFiles.length > 0 || shelfEntries.length > 0 || entryGroups != null ? (
            <>
              {pinnedFiles.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Pinned files</SelectLabel>
                  {pinnedFiles.map((file) => (
                    <SelectItem
                      key={file.path}
                      value={pickerValue("pinned", file.path)}
                      className="text-xs"
                    >
                      <span className="min-w-0 truncate">{file.path}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {(artifactGroupEntries.length > 0 || deletedPaths.length > 0) && (
                <SelectGroup>
                  <SelectLabel>Artifacts</SelectLabel>
                  {artifactItems}
                </SelectGroup>
              )}
            </>
          ) : (
            artifactItems
          )}
          {entryGroups != null && (
            <SelectGroup>
              <SelectLabel>Other files</SelectLabel>
              {/* An item, not a button, so arrow keys reach it and Enter or Space toggles it. */}
              {(otherFilesExpanded || hiddenOtherCount > 0) && (
                <SelectItem
                  value={OTHER_FILES_TOGGLE_VALUE}
                  className="text-content-secondary text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">
                      {otherFilesExpanded
                        ? "Hide other files"
                        : `Show ${hiddenOtherCount} other ${hiddenOtherCount === 1 ? "file" : "files"}`}
                    </span>
                    {!otherFilesExpanded &&
                      otherFiles.some((entry) => changedPaths.has(entry.path)) &&
                      changedDot}
                  </span>
                </SelectItem>
              )}
              {visibleOtherFiles.map(entryItem)}
            </SelectGroup>
          )}
          {shelfEntries.length > 0 && (
            <SelectGroup>
              <SelectLabel>Shelf</SelectLabel>
              {shelfEntries.map((entry) => (
                <SelectItem
                  key={shelfSelectionPath(entry)}
                  value={pickerValue("shelf", shelfSelectionPath(entry))}
                  className="text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{entry.file}</span>
                    <span className="text-muted shrink-0 text-[10px]">
                      {entry.scope} · pinned by {entry.pinnedBy === "agent" ? "agent" : "you"}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {appViews.length > 0 && (
            <SelectGroup>
              <SelectLabel>App views</SelectLabel>
              {appViews.map((view) => (
                <SelectItem
                  key={view.toolCallId}
                  value={mcpAppSelectionKey(view.toolCallId)}
                  className="text-xs"
                >
                  {/* Several calls of one tool share a label: the arguments and the outcome
                      tell them apart. */}
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0">
                      {view.label} · {view.serverName}
                    </span>
                    <span className="text-muted min-w-0 truncate text-[10px]">
                      {view.failed ? "failed · " : view.cancelled ? "interrupted · " : ""}
                      {summarizeToolArguments(view.arguments)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </ArtifactPickerSelect>
      {changedPaths.size > 0 && (
        <TooltipIfPresent tooltip="Artifacts changed since you looked">
          <span
            aria-label={`${changedPaths.size} changed`}
            className="text-accent counter-nums flex shrink-0 items-center gap-1 text-[11px]"
          >
            <span className="bg-accent h-1.5 w-1.5 rounded-full" />
            {changedPaths.size}
          </span>
        </TooltipIfPresent>
      )}
      {selected?.scope === "artifact" && versions.length > 0 && (
        <ArtifactVersionMenu
          versions={versions}
          selectedVersion={selected.version}
          onSelect={(version) => {
            setActionError(null);
            setSelection({ scope: "artifact", path: selected.path, version });
          }}
          projectShelfAvailable={shelf?.project.available === true}
          onPin={pinToShelf}
        />
      )}
      {selected?.scope === "shelf" && (
        <TooltipIfPresent
          tooltip={
            <>
              Unpin from shelf
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.UNPIN_SHELF_ENTRY)})
              </span>
            </>
          }
        >
          <button
            type="button"
            aria-label="Unpin from shelf"
            onClick={unpinShelfSelected}
            className={toolbarButtonClassName}
          >
            <PinOff className="h-3.5 w-3.5" />
          </button>
        </TooltipIfPresent>
      )}
      {selected?.scope === "pinned" && (
        <TooltipIfPresent
          tooltip={
            <>
              Unpin file
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.UNPIN_ARTIFACT_FILE)})
              </span>
            </>
          }
        >
          <button
            type="button"
            aria-label="Unpin file"
            onClick={unpinSelected}
            className={toolbarButtonClassName}
          >
            <PinOff className="h-3.5 w-3.5" />
          </button>
        </TooltipIfPresent>
      )}
      {annotateSupport != null && (
        <TooltipIfPresent
          tooltip={
            <>
              {annotating ? "Stop annotating" : "Annotate"}
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.TOGGLE_ARTIFACT_ANNOTATE)})
              </span>
            </>
          }
        >
          <button
            type="button"
            aria-label={annotating ? "Stop annotating" : "Annotate"}
            aria-pressed={annotating}
            onClick={toggleAnnotate}
            className={`${toolbarButtonClassName} ${annotating ? "text-accent border-accent" : ""}`}
          >
            {annotating ? (
              <MessageSquareOff className="h-3.5 w-3.5" />
            ) : (
              <MessageSquarePlus className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipIfPresent>
      )}
      <TooltipIfPresent tooltip="Download">
        <button
          type="button"
          aria-label="Download artifact"
          disabled={downloadableResult == null}
          onClick={() => {
            if (downloadableResult != null) downloadArtifact(downloadableResult);
          }}
          className={toolbarButtonClassName}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </TooltipIfPresent>
      {allowFullscreen && (
        <TooltipIfPresent tooltip={showFullscreen ? "Exit fullscreen" : "Fullscreen"}>
          <button
            type="button"
            aria-label={showFullscreen ? "Exit fullscreen" : "Fullscreen"}
            disabled={selected == null}
            onClick={() => setFullscreen(!showFullscreen)}
            className={toolbarButtonClassName}
          >
            {showFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipIfPresent>
      )}
      <TooltipIfPresent tooltip="Reload">
        <button
          type="button"
          aria-label="Reload artifact"
          onClick={reload}
          className={toolbarButtonClassName}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </TooltipIfPresent>
    </div>
  );

  // Stored versions live in the host session dir: they stay viewable when listing the live
  // folder fails (runtime unreachable, container gone).
  const storedVersionSelected = selected?.scope === "artifact" && selected.version != null;

  // App views do not depend on the artifacts folder: while any is open, the picker stays above
  // a listing error, loading or unavailable message so the remaining views stay reachable (for
  // example after closing the selected one).
  const withAppPicker = (message: React.ReactNode): React.ReactNode =>
    appViews.length > 0 ? (
      <>
        {artbar}
        {message}
      </>
    ) : (
      message
    );

  const annotateHint = annotating ? (
    <div className="text-muted border-border-light border-b px-3 py-1 text-[11px]">
      {annotateSupport === "frame"
        ? "Annotating: click the artifact to pin a comment (select text first to quote it)."
        : "Annotating: select text to comment on it."}
    </div>
  ) : null;

  const annotationPopover =
    pendingPick == null ? null : (
      <ArtifactAnnotationPopover
        // Fresh comment box per target.
        key={`${pendingPick.clientX}:${pendingPick.clientY}`}
        pick={pendingPick}
        onSubmit={(comment) => addAnnotation(pendingPick, comment)}
        onCancel={() => setAnnotationPick(null)}
      />
    );

  let body: React.ReactNode;
  if (selectedApp != null) {
    body = (
      <>
        {artbar}
        <div className="min-h-0 flex-1 overflow-auto">{viewerBody}</div>
      </>
    );
  } else if (listError != null && !storedVersionSelected) {
    body = withAppPicker(<div className="text-danger p-4 text-xs">{listError}</div>);
  } else if (listing == null && !storedVersionSelected) {
    body = withAppPicker(<div className="text-muted p-4 text-xs">Loading…</div>);
  } else if (listing != null && selected == null && !waitingForPinned && !listing.available) {
    body = withAppPicker(
      <div className="text-muted p-4 text-xs leading-relaxed">{listing.reason}</div>
    );
  } else if (selected == null && !waitingForPinned && appViews.length === 0) {
    body = (
      <div className="text-muted p-4 text-xs leading-relaxed">
        No artifacts yet. Files the agent writes to{" "}
        <code className="text-foreground">$XUM_SCRATCH_DIR/artifacts/</code> appear here.
      </div>
    );
  } else {
    body = (
      <>
        {artbar}
        {!showFullscreen && annotateHint}
        {!showFullscreen && interactions.strip}
        {actionError != null && (
          <div className="text-danger border-border-light border-b px-3 py-1 text-[11px]">
            {actionError}
          </div>
        )}
        {listError != null && (
          <div className="text-danger border-border-light border-b px-3 py-1 text-[11px]">
            {listError}
          </div>
        )}
        {listing?.available === true && listing.truncated && (
          <div className="text-muted border-border-light border-b px-3 py-1 text-[11px]">
            Some files are not shown.
          </div>
        )}
        {/* While fullscreen, the overlay owns the only viewer, so frames never run twice. */}
        {showFullscreen ? <div className="min-h-0 flex-1" /> : viewerScroll}
      </>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // The ring is an overlay: the sidebar clips anything drawn outside the panel, and an inset
      // ring on the panel itself is hidden under the toolbar's and viewer's backgrounds.
      className="after:ring-accent relative flex h-full min-h-0 flex-col outline-none after:pointer-events-none after:absolute after:inset-0 after:z-10 after:hidden after:ring-1 after:ring-inset focus-visible:after:block data-[shortcut-focus=true]:after:block"
      data-shortcut-focus={shortcutFocused || undefined}
      onBlur={(e) => {
        // Only the panel's own blur: focus moving into a toolbar button shows that button's ring.
        if (e.target === e.currentTarget) setShortcutFocused(false);
      }}
      data-testid="artifacts-panel"
    >
      {body}
      {!showFullscreen && annotationPopover}
      {/* Radix Dialog: focus trap, inert background and Escape handling (which stops the key
          from reaching global handlers such as Escape-to-interrupt). Key events still bubble
          to the panel through the portal, so the tab shortcuts keep working in fullscreen. */}
      <Dialog open={showFullscreen} onOpenChange={(open) => !open && setFullscreen(false)}>
        {showFullscreen && selected != null && (
          <DialogContent
            showCloseButton={false}
            maxWidth="none"
            aria-describedby={undefined}
            // Radix sees Escape (document, capture phase) before the panel's onKeyDown, so the
            // annotate layers are peeled here; preventDefault keeps the dialog open.
            onEscapeKeyDown={(e) => {
              if (escapeAnnotate()) e.preventDefault();
            }}
            // Radix would focus the first control, the picker, which owns letter keys, so J/K,
            // Shift+F and C did nothing until a click. Focus the dialog itself instead, the
            // target keepFocusForShortcuts uses inside fullscreen.
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              if (!(e.currentTarget instanceof HTMLElement)) return;
              e.currentTarget.focus();
              setDialogShortcutFocused(document.activeElement === e.currentTarget);
            }}
            // Back to the panel, so J/K keep working without another click.
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              panelRef.current?.focus();
            }}
            // The panel's overlay ring (see the panel below); `fixed` already positions it.
            className="bg-background ios-standalone:top-px ios-standalone:h-[calc(100%-1px)] after:ring-accent inset-0 top-0 left-0 flex h-full w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 outline-none after:pointer-events-none after:absolute after:inset-0 after:z-10 after:hidden after:ring-1 after:ring-inset focus-visible:after:block data-[shortcut-focus=true]:after:block"
            data-shortcut-focus={dialogShortcutFocused || undefined}
            onBlur={(e) => {
              // Only the dialog's own blur: a focused control inside shows its own ring.
              if (e.target === e.currentTarget) setDialogShortcutFocused(false);
            }}
          >
            <VisuallyHidden>
              <DialogTitle>{`Artifact ${selected.path}`}</DialogTitle>
            </VisuallyHidden>
            {artbar}
            {annotateHint}
            {interactions.strip}
            {viewerScroll}
            {annotationPopover}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
