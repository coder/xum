import React, { useEffect, useRef, useState } from "react";
import { Download, Maximize2, Minimize2, PinOff, RefreshCw } from "lucide-react";
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
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
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
} from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { downloadArtifact } from "./artifactDownload";
import { ArtifactVersionMenu } from "./ArtifactVersionMenu";
import { ArtifactViewer } from "./ArtifactViewer";
import { McpAppFrame } from "./McpAppFrame";
import { mcpAppSelectionKey, useMcpAppViews } from "./mcpAppViewsStore";
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
  | { scope: "artifact"; path: string; entry: ArtifactEntry | null; version: number | null };

/** Picker values carry the scope, since a pinned file and an artifact may share a path. */
function pickerValue(scope: ArtifactSelectionScope, path: string): string {
  return `${scope}:${path}`;
}

function parsePickerValue(value: string): { scope: ArtifactSelectionScope; path: string } | null {
  const colon = value.indexOf(":");
  const scope = value.slice(0, colon);
  if (scope !== "artifact" && scope !== "pinned") return null;
  return { scope, path: value.slice(colon + 1) };
}

/**
 * The persisted selection when it still points at something, else the first artifact, else
 * the first pinned file, else the first deleted artifact that still has stored versions.
 * `versionOnlyPaths` are artifacts whose working file is gone but whose versions are kept; with
 * no version selected they show their latest stored version.
 */
export function resolveSelection(input: {
  scope: ArtifactSelectionScope;
  path: string | null;
  version: number | null;
  entries: readonly ArtifactEntry[];
  pinnedFiles: readonly PinnedArtifactFile[];
  versionOnlyPaths: readonly string[];
}): Selection | null {
  if (input.scope === "pinned") {
    const file = input.pinnedFiles.find((f) => f.path === input.path);
    if (file) return { scope: "pinned", path: file.path, file };
  } else {
    const entry = input.entries.find((e) => e.path === input.path);
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
  return null;
}

/**
 * Artifacts tab (experiment: "artifacts"): files the agent writes to
 * $XUM_SCRATCH_DIR/artifacts, listed newest first with a preview of the selected one.
 * `inDialog` is set by the small-viewport dialog, which is already near full screen and whose
 * focus trap would fight a second full-screen overlay, so fullscreen is not offered there.
 */
export function ArtifactsPanel(props: { workspaceId: string; inDialog?: boolean }) {
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set while a list request runs, so a slow walk is not aborted by the next poll tick.
  const listInFlightRef = useRef(false);
  const [pinned, setPinned] = useState<PinnedArtifactFiles | null>(null);
  const [versionsState, setVersionsState] = useState<{
    path: string;
    list: ArtifactVersionList | null;
    /** Why listVersions failed; shown instead of a stored version that cannot be resolved. */
    error: string | null;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  // A pinned selection waits for the pinned list instead of flashing the first artifact.
  const waitingForPinned = selectedScope === "pinned" && selectedPath != null && pinned == null;

  const selected =
    selectedApp != null || waitingForPinned
      ? null
      : resolveSelection({
          scope: selectedScope,
          path: selectedPath,
          version: selectedVersion,
          entries,
          pinnedFiles,
          versionOnlyPaths,
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
    | null = null;
  if (selected?.scope === "pinned") {
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
  const options: Array<{ scope: ArtifactSelectionScope; path: string }> = [
    ...pinnedFiles.map((file) => ({ scope: "pinned" as const, path: file.path })),
    ...entries.map((entry) => ({ scope: "artifact" as const, path: entry.path })),
    ...deletedPaths.map((path) => ({ scope: "artifact" as const, path })),
  ];

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

  const reload = () => {
    setRefreshTick((tick) => tick + 1);
    setReloadTick((tick) => tick + 1);
  };

  // Tab-scoped shortcuts: they only fire while focus is inside this panel (or its fullscreen
  // overlay, whose events bubble here through the portal).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableElement(e.target)) return;
    // The picker (open list, or its focused closed trigger, where Radix runs type-ahead) and the
    // version menu own their keys; J/K/R must not change the selection behind them.
    if (
      e.target instanceof Element &&
      e.target.closest('[role="listbox"],[role="menu"],[role="combobox"]') != null
    ) {
      return;
    }
    if (matchesKeybind(e, KEYBINDS.TOGGLE_ARTIFACT_FULLSCREEN)) {
      e.preventDefault();
      if (selected && allowFullscreen) setFullscreen(!showFullscreen);
    } else if (matchesKeybind(e, KEYBINDS.NEXT_ARTIFACT)) {
      e.preventDefault();
      selectRelative(1);
    } else if (matchesKeybind(e, KEYBINDS.PREV_ARTIFACT)) {
      e.preventDefault();
      selectRelative(-1);
    } else if (matchesKeybind(e, KEYBINDS.RELOAD_ARTIFACT)) {
      e.preventDefault();
      reload();
    } else if (matchesKeybind(e, KEYBINDS.UNPIN_ARTIFACT_FILE) && selected?.scope === "pinned") {
      e.preventDefault();
      unpinSelected();
    }
  };

  // Escape and Shift+F pressed inside a sandboxed HTML/SVG frame arrive over the bridge,
  // because key events inside the frame never reach this panel's onKeyDown. They can only
  // EXIT fullscreen: the artifact's own script can post either message without a key press,
  // and entering fullscreen remounts the frame, so a frame able to enter could loop the
  // viewer between panel and dialog forever. Enter with Shift+F outside the frame or the
  // toolbar button.
  const handleFrameKey = (_key: ArtifactFrameKey) => {
    if (showFullscreen) setFullscreen(false);
  };

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
        result={currentRead.result}
        workspaceId={props.workspaceId}
        artifactsDir={
          selected?.scope === "artifact" && listing?.available === true ? listing.dir : null
        }
        readRelativeAssets={selected?.scope !== "pinned"}
        onFrameKey={handleFrameKey}
      />
    ) : currentRead?.error ? (
      <div className="text-danger p-4 text-xs">{currentRead.error}</div>
    ) : readRequest == null && versionListError != null ? (
      // A stored version is resolved through listVersions: without it there is nothing to read.
      <div className="text-danger p-4 text-xs">{versionListError}</div>
    ) : (
      <div className="text-muted p-4 text-xs">Loading…</div>
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

  const toolbarButtonClassName =
    "border-border-light text-muted hover:text-foreground bg-background flex h-6 w-6 items-center justify-center rounded border disabled:opacity-40";

  const versions = versionList?.versions ?? [];
  const artifactItems = (
    <>
      {entries.map((entry) => (
        <SelectItem
          key={entry.path}
          value={pickerValue("artifact", entry.path)}
          className="text-xs"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{entry.path}</span>
            {changedPaths.has(entry.path) && (
              <span aria-label="Changed" className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" />
            )}
          </span>
        </SelectItem>
      ))}
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
      <Select
        value={
          selectedApp
            ? mcpAppSelectionKey(selectedApp.toolCallId)
            : selected
              ? pickerValue(selected.scope, selected.path)
              : ""
        }
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
          {pinnedFiles.length > 0 ? (
            <>
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
              {(entries.length > 0 || deletedPaths.length > 0) && (
                <SelectGroup>
                  <SelectLabel>Artifacts</SelectLabel>
                  {artifactItems}
                </SelectGroup>
              )}
            </>
          ) : (
            artifactItems
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
                  <span className="min-w-0 truncate">
                    {view.label} · {view.serverName}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
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
        />
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
        <div className="min-h-0 flex-1 overflow-auto">{showFullscreen ? null : viewerBody}</div>
      </>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-col outline-none"
      data-testid="artifacts-panel"
    >
      {body}
      {/* Radix Dialog: focus trap, inert background and Escape handling (which stops the key
          from reaching global handlers such as Escape-to-interrupt). Key events still bubble
          to the panel through the portal, so the tab shortcuts keep working in fullscreen. */}
      <Dialog open={showFullscreen} onOpenChange={(open) => !open && setFullscreen(false)}>
        {showFullscreen && selected != null && (
          <DialogContent
            showCloseButton={false}
            maxWidth="none"
            aria-describedby={undefined}
            // Back to the panel, so J/K keep working without another click.
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              panelRef.current?.focus();
            }}
            className="bg-background inset-0 top-0 left-0 flex h-full w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 outline-none"
          >
            <VisuallyHidden>
              <DialogTitle>{`Artifact ${selected.path}`}</DialogTitle>
            </VisuallyHidden>
            {artbar}
            <div className="min-h-0 flex-1 overflow-auto">{viewerBody}</div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
