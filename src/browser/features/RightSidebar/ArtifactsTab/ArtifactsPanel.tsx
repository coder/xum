import React, { useEffect, useRef, useState } from "react";
import { Download, Maximize2, Minimize2, RefreshCw } from "lucide-react";
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
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
} from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { useArtifactSelection, writeArtifactSelection } from "./artifactSelection";
import { downloadArtifact } from "./artifactDownload";
import { ArtifactViewer } from "./ArtifactViewer";
import { McpAppFrame } from "./McpAppFrame";
import { mcpAppSelectionKey, useMcpAppViews } from "./mcpAppViewsStore";
import type { ArtifactFrameKey } from "./SandboxedArtifactFrame";

/** While the tab is visible, re-list this often to catch writes no tool event reports. */
const ARTIFACTS_POLL_MS = 3000;

interface ReadState {
  path: string;
  modifiedMs: number;
  result: ArtifactReadResult | null;
  error: string | null;
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
  // MCP Apps: "Open in Artifacts" on a tool card selects its view through the selection map.
  const { path: selectedPath } = useArtifactSelection(props.workspaceId);
  const setSelectedPath = (path: string) => writeArtifactSelection(props.workspaceId, { path });
  const appViews = useMcpAppViews(props.workspaceId);
  const selectedApp =
    appViews.find((view) => mcpAppSelectionKey(view.toolCallId) === selectedPath) ?? null;

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
        // One retry per failure: cleared here so later polls do not abort a slow retry.
        if (readFailedRef.current) {
          readFailedRef.current = false;
          setReloadTick((tick) => tick + 1);
        }
        const entries = result.data.available ? result.data.entries : [];
        setSeen((prev) => prev ?? new Map(entries.map((e) => [e.path, e.modifiedMs])));
        // Nothing left to show: close fullscreen so it cannot pop back when a file reappears.
        if (entries.length === 0) setFullscreen(false);
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
  const selected =
    selectedApp != null
      ? null
      : (entries.find((entry) => entry.path === selectedPath) ?? entries[0] ?? null);
  // Size too: a same-mtime rewrite (cp -p, 1 s filesystems) must still re-read.
  const selectedKey = selected
    ? `${selected.path}\u0000${selected.modifiedMs}\u0000${selected.size}`
    : null;

  useEffect(() => {
    if (!api || selected == null) return;
    const { path, modifiedMs } = selected;
    readFailedRef.current = false;
    const controller = new AbortController();
    api.artifacts
      .read({ workspaceId: props.workspaceId, path }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        readFailedRef.current = !result.success;
        if (result.success) {
          setReadState({ path, modifiedMs, result: result.data, error: null });
          setSeen((prev) => new Map(prev ?? []).set(path, modifiedMs));
        } else {
          setReadState({ path, modifiedMs, result: null, error: result.error });
        }
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        readFailedRef.current = true;
        setReadState({ path, modifiedMs, result: null, error: getErrorMessage(error) });
      });
    return () => controller.abort();
    // selectedKey covers path + modifiedMs + size: re-read when the selected file changes on disk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.workspaceId, selectedKey, reloadTick]);

  // Fullscreen only makes sense with something selected (the list callback also clears it).
  const showFullscreen = allowFullscreen && fullscreen && selected != null;

  const selectRelative = (offset: number) => {
    if (entries.length === 0) return;
    const index = selected ? entries.indexOf(selected) : -1;
    const next = entries[Math.min(Math.max(index + offset, 0), entries.length - 1)];
    if (next) setSelectedPath(next.path);
  };

  const reload = () => {
    setRefreshTick((tick) => tick + 1);
    setReloadTick((tick) => tick + 1);
  };

  // Tab-scoped shortcuts: they only fire while focus is inside this panel (or its fullscreen
  // overlay, whose events bubble here through the portal).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableElement(e.target)) return;
    // The open picker owns its keys (type-ahead, arrows); J/K/R must not change the selection
    // behind it.
    // The closed trigger too: Radix Select type-ahead acts on printable keys there.
    if (
      e.target instanceof Element &&
      e.target.closest('[role="listbox"], [role="combobox"]') != null
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

  const selectedResult =
    selected != null && readState?.path === selected.path ? readState.result : null;
  // Text arrives decoded as UTF-8 with U+FFFD for invalid bytes (e.g. Windows-1252 files).
  // Downloading would re-encode that string and save different bytes than the file on disk,
  // so such files are not downloadable here; the original stays in the artifacts folder.
  const lossyText =
    selectedResult?.status === "ok" &&
    selectedResult.encoding === "utf8" &&
    selectedResult.content.includes("\uFFFD");
  const downloadableResult = selectedResult?.status === "ok" && !lossyText ? selectedResult : null;

  const viewerBody =
    selectedApp != null ? (
      <McpAppFrame
        // Reload remounts the view, so it re-fetches its resource and result.
        key={`${selectedApp.toolCallId}\u0000${reloadTick}`}
        workspaceId={props.workspaceId}
        view={selectedApp}
      />
    ) : selected == null ? null : readState?.path === selected.path && readState.result ? (
      <ArtifactViewer
        // Remount per file version so renderer state (zoom, JSON mode, frames) starts fresh.
        key={`${readState.path}\u0000${readState.modifiedMs}`}
        result={readState.result}
        workspaceId={props.workspaceId}
        artifactsDir={listing?.available === true ? listing.dir : null}
        onFrameKey={handleFrameKey}
      />
    ) : readState?.path === selected.path && readState.error ? (
      <div className="text-danger p-4 text-xs">{readState.error}</div>
    ) : (
      <div className="text-muted p-4 text-xs">Loading…</div>
    );

  const changedPaths = new Set(
    entries
      .filter(
        (entry) =>
          entry.path !== selected?.path &&
          seen != null &&
          (seen.get(entry.path) ?? -1) < entry.modifiedMs
      )
      .map((entry) => entry.path)
  );

  const toolbarButtonClassName =
    "border-border-light text-muted hover:text-foreground bg-background flex h-6 w-6 items-center justify-center rounded border disabled:opacity-40";

  // Toolbar layout follows the brainstorm demo: picker on the left, actions on the right.
  // The version menu joins the actions once artifact versions exist.
  const artbar = (
    <div className="border-border-light bg-sidebar flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
      <Select
        value={selectedApp ? mcpAppSelectionKey(selectedApp.toolCallId) : (selected?.path ?? "")}
        onValueChange={setSelectedPath}
      >
        <SelectTrigger
          aria-label="Artifact"
          className="h-6 min-w-0 flex-1 justify-between px-2 text-xs [&>span]:min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        {/* Never wider than the space Radix measured, so long paths cannot overflow the screen. */}
        <SelectContent className="max-w-(--radix-select-content-available-width)">
          {entries.map((entry) => (
            <SelectItem key={entry.path} value={entry.path} className="text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{entry.path}</span>
                {changedPaths.has(entry.path) && (
                  <span
                    aria-label="Changed"
                    className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full"
                  />
                )}
              </span>
            </SelectItem>
          ))}
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
  } else if (listError != null) {
    body = withAppPicker(<div className="text-danger p-4 text-xs">{listError}</div>);
  } else if (listing == null) {
    body = withAppPicker(<div className="text-muted p-4 text-xs">Loading…</div>);
  } else if (!listing.available) {
    body = withAppPicker(
      <div className="text-muted p-4 text-xs leading-relaxed">{listing.reason}</div>
    );
  } else if (entries.length === 0 && appViews.length === 0) {
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
        {listing.truncated && (
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
