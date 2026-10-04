import React, { useState, useCallback, useEffect, useRef } from "react";
import { Terminal, X, Loader2, FileText } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import { BackgroundBashOutputDialog } from "../BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import { ChatInputDecoration } from "../ChatPane/ChatInputDecoration";
import { formatDuration } from "@/common/utils/formatDuration";
import {
  useBackgroundBashTerminatingIds,
  useBackgroundProcesses,
} from "@/browser/stores/BackgroundBashStore";
import { useBackgroundBashActions } from "@/browser/contexts/BackgroundBashContext";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  KEYBINDS,
  formatKeybind,
  isDialogOpen,
  isTerminalFocused,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";

const SHORTCUT_HINT_CLASS =
  "ml-1.5 font-mono text-[10px] opacity-70 [@media(max-width:768px)]:hidden";

/** Focuses the expanded strip's row at `index`, clamped to the rows that exist. */
function focusProcessRow(list: HTMLElement | null, index: number): void {
  const rows = list?.querySelectorAll<HTMLElement>("[data-process-row]");
  if (!rows || rows.length === 0) return;
  rows[Math.max(0, Math.min(index, rows.length - 1))].focus();
}

/** Refocuses the origin (usually the composer), else `fallback` (palette runs leave none). */
function restoreFocus(
  ref: React.MutableRefObject<HTMLElement | null>,
  fallback?: Element | null
): void {
  const target = ref.current;
  ref.current = null;
  if (target?.isConnected) {
    target.focus();
  } else if (fallback instanceof HTMLElement) {
    fallback.focus();
  }
}

/** The strip's expand/collapse button, which ChatInputDecoration renders just before the list. */
function stripToggle(list: HTMLElement | null): Element | null {
  return list?.previousElementSibling ?? null;
}

/**
 * Truncate script to reasonable display length.
 */
function truncateScript(script: string, maxLength = 60): string {
  // First line only, truncated
  const firstLine = script.split("\n")[0] ?? script;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return firstLine.slice(0, maxLength - 3) + "...";
}

interface BackgroundProcessesBannerProps {
  workspaceId: string;
}

/**
 * Banner showing running background processes.
 * Displays "N running bashes" which expands on click to show details.
 */
export const BackgroundProcessesBanner: React.FC<BackgroundProcessesBannerProps> = (props) => {
  const [viewingProcessId, setViewingProcessId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setTick] = useState(0);
  const processes = useBackgroundProcesses(props.workspaceId);
  const terminatingIds = useBackgroundBashTerminatingIds(props.workspaceId);
  const { terminate } = useBackgroundBashActions();
  // Hosts without the output dialog hide the View output action.
  const canViewOutput = useChatHostContext().uiSupport.backgroundBashOutput === "supported";
  // Keyboard access (#5197): a roving tabindex over the rows, opened by FOCUS_BACKGROUND_PROCESSES.
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  // The focused row; if its process leaves the list, a neighbor takes focus instead of the body.
  const focusedRowRef = useRef<{ processId: string; index: number } | null>(null);
  // The output dialog has no trigger to return focus to, so a keyboard open records its row.
  const refocusAfterOutputRef = useRef<{ row: HTMLElement; index: number } | null>(null);
  // Under immersive review desktop keeps the chat pane mounted but inert: ignore requests then.
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep running processes visible, plus exited processes whose monitor matched but whose
  // wake has not been delivered yet — otherwise a one-shot watcher that matched and exited
  // vanishes from the banner and looks like a lost wake.
  const visibleProcesses = processes.filter(
    (p) => p.status === "running" || p.monitor?.pendingWakeKind != null
  );
  const viewingProcess = processes.find((p) => p.id === viewingProcessId) ?? null;
  const count = visibleProcesses.length;
  const hasRunning = visibleProcesses.some((p) => p.status === "running");

  // Update duration display every second when expanded (exited processes show no duration)
  useEffect(() => {
    if (!isExpanded || !hasRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExpanded, hasRunning]);

  // Listens only while there is something to focus, so the chord is not consumed otherwise.
  useEffect(() => {
    if (count === 0) return;
    const open = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !listRef.current?.contains(active)
      ) {
        returnFocusRef.current = active;
      }
      setActiveIndex(0);
      setIsExpanded(true);
      setFocusRequest((request) => request + 1);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeybind(event, KEYBINDS.FOCUS_BACKGROUND_PROCESSES) || isDialogOpen()) return;
      // isDialogOpen() misses the command palette (cmdk); focus must not move behind it.
      if (event.target instanceof Element && event.target.closest("[cmdk-root]")) return;
      if (isTerminalFocused(event.target)) return; // the terminal owns its keystrokes
      if (rootRef.current?.closest("[inert]")) return;
      event.preventDefault();
      if (event.repeat) return;
      if (listRef.current?.contains(document.activeElement)) {
        const toggle = stripToggle(listRef.current);
        setIsExpanded(false);
        restoreFocus(returnFocusRef, toggle);
      } else {
        open();
      }
    };
    const onFocusRequest = (event: Event) => {
      const { detail } = event as CustomEvent<
        CustomEventPayloads[typeof CUSTOM_EVENTS.FOCUS_BACKGROUND_PROCESSES]
      >;
      if (detail.workspaceId !== props.workspaceId || rootRef.current?.closest("[inert]")) return;
      detail.handled = true;
      open();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(CUSTOM_EVENTS.FOCUS_BACKGROUND_PROCESSES, onFocusRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(CUSTOM_EVENTS.FOCUS_BACKGROUND_PROCESSES, onFocusRequest);
    };
  }, [count, props.workspaceId]);

  useEffect(() => {
    if (focusRequest > 0) focusProcessRow(listRef.current, 0);
  }, [focusRequest]);

  const rowIdsKey = visibleProcesses.map((proc) => proc.id).join("\u0000");
  useEffect(() => {
    const removed = focusedRowRef.current;
    if (removed == null || rowIdsKey.split("\u0000").includes(removed.processId)) return;
    focusedRowRef.current = null;
    // Only when the removal dropped focus, not when the user moved it elsewhere meanwhile.
    if (document.activeElement != null && document.activeElement !== document.body) return;
    if (listRef.current) {
      focusProcessRow(listRef.current, removed.index);
    } else {
      restoreFocus(returnFocusRef);
    }
  }, [rowIdsKey]);

  useEffect(() => {
    if (viewingProcessId != null) return;
    const target = refocusAfterOutputRef.current;
    refocusAfterOutputRef.current = null;
    if (target == null) return;
    // The row's process may have left the list while the dialog was open.
    if (target.row.isConnected) {
      target.row.focus();
    } else if (listRef.current) {
      focusProcessRow(listRef.current, target.index);
    } else {
      restoreFocus(returnFocusRef);
    }
  }, [viewingProcessId]);

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-process-row]")
        : null;
    const index = Number(row?.dataset.processIndex ?? -1);
    const proc = visibleProcesses[index];
    if (!row || !proc) return;
    if (matchesKeybind(event, KEYBINDS.CANCEL)) {
      const toggle = stripToggle(listRef.current);
      setIsExpanded(false);
      restoreFocus(returnFocusRef, toggle);
    } else if (matchesKeybind(event, KEYBINDS.BACKGROUND_PROCESS_NEXT)) {
      focusProcessRow(listRef.current, index + 1);
    } else if (matchesKeybind(event, KEYBINDS.BACKGROUND_PROCESS_PREV)) {
      focusProcessRow(listRef.current, index - 1);
    } else if (
      // Enter on a row button keeps its own meaning.
      event.target === row &&
      matchesKeybind(event, KEYBINDS.BACKGROUND_PROCESS_VIEW_OUTPUT) &&
      proc.synthesized !== true &&
      canViewOutput &&
      !terminatingIds.has(proc.id)
    ) {
      refocusAfterOutputRef.current = { row, index };
      setViewingProcessId(proc.id);
    } else if (
      matchesKeybind(event, KEYBINDS.BACKGROUND_PROCESS_TERMINATE) &&
      proc.status === "running" &&
      !terminatingIds.has(proc.id)
    ) {
      terminate(proc.id);
    } else {
      return;
    }
    event.preventDefault();
    // Keeps window-level handlers (e.g. Escape interrupting the stream) from also acting.
    stopKeyboardPropagation(event);
  };

  const handleViewOutput = useCallback((processId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setViewingProcessId(processId);
  }, []);

  const handleTerminate = useCallback(
    (processId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      terminate(processId);
    },
    [terminate]
  );

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Don't render if no running processes and no dialog open.
  if (count === 0 && !viewingProcessId) {
    return null;
  }

  return (
    <div ref={rootRef} className="contents">
      {count > 0 && (
        <ChatInputDecoration
          expanded={isExpanded}
          onToggle={handleToggle}
          contentClassName="max-h-48 space-y-1.5 overflow-y-auto py-2"
          contentRef={listRef}
          onContentKeyDown={handleListKeyDown}
          summary={
            <>
              <Terminal className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
              <span className="text-muted group-hover:text-secondary transition-colors">
                <span className="font-medium">{count}</span>
                {" background bash"}
                {count !== 1 && "es"}
              </span>
            </>
          }
          renderExpanded={() =>
            visibleProcesses.map((proc, index) => {
              const isTerminating = terminatingIds.has(proc.id);
              return (
                <div
                  key={proc.id}
                  data-process-row=""
                  data-process-index={index}
                  tabIndex={index === Math.min(activeIndex, count - 1) ? 0 : -1}
                  onFocus={() => {
                    setActiveIndex(index);
                    focusedRowRef.current = { processId: proc.id, index };
                  }}
                  onBlur={(event) => {
                    // Only a removed row keeps the record, for the removal effect above.
                    if (event.relatedTarget != null || event.currentTarget.isConnected) {
                      focusedRowRef.current = null;
                    }
                  }}
                  className={cn(
                    "hover:bg-hover flex items-center justify-between gap-3 rounded px-2 py-1.5",
                    "focus-visible:ring-accent outline-none focus-visible:ring-1",
                    "transition-colors",
                    isTerminating && "pointer-events-none opacity-50"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate font-mono text-xs" title={proc.script}>
                      {proc.displayName ?? truncateScript(proc.script)}
                    </div>
                    {proc.monitor && (
                      <>
                        <div className="text-muted truncate text-[10px]">
                          watching /{proc.monitor.filter}/ · {proc.monitor.totalMatches} match
                          {proc.monitor.totalMatches === 1 ? "" : "es"}
                          {proc.monitor.stopped ? " · stopped" : ""}
                        </div>
                        {/* Own non-truncating line: appended to the watching line above,
                            a long filter would right-ellipsize this away on narrow
                            widths — hiding the only explanation for an exited row. */}
                        {proc.monitor.pendingWakeKind != null && (
                          <div className="text-secondary text-[10px]">
                            {/* settled wakes report a process exit without any filter match;
                                monitor-lost wakes report a terminated watcher, not a match */}
                            {proc.monitor.pendingWakeKind === "match"
                              ? "match found — waking agent…"
                              : proc.monitor.pendingWakeKind === "settled"
                                ? "process settled — waking agent…"
                                : "monitor lost — waking agent…"}
                          </div>
                        )}
                      </>
                    )}
                    {/* Rows synthesized from a durable pending wake (process gone after
                        restart) carry no real pid. */}
                    {proc.pid > 0 && (
                      <div className="text-muted font-mono text-[10px]">pid {proc.pid}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Exited-but-wake-pending rows have no live duration to increment */}
                    {proc.status === "running" && (
                      <span className="text-muted text-[10px] tabular-nums">
                        {formatDuration(Date.now() - proc.startTime)}
                      </span>
                    )}
                    {/* Rows synthesized from a durable pending wake have no manager entry
                        behind them, so fetching output is guaranteed to fail. Keyed on the
                        explicit marker, not the pid: migrated processes also use pid 0 but
                        remain fully queryable. */}
                    {proc.synthesized !== true && canViewOutput && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="View output"
                            disabled={isTerminating}
                            onClick={(e) => handleViewOutput(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-secondary rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            <FileText size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          View output
                          <kbd className={SHORTCUT_HINT_CLASS}>
                            {formatKeybind(KEYBINDS.BACKGROUND_PROCESS_VIEW_OUTPUT)}
                          </kbd>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {/* Nothing to terminate once the process has exited */}
                    {proc.status === "running" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={isTerminating}
                            onClick={(e) => handleTerminate(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-error rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            {isTerminating ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <X size={14} />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Terminate process
                          <kbd className={SHORTCUT_HINT_CLASS}>
                            {formatKeybind(KEYBINDS.BACKGROUND_PROCESS_TERMINATE)}
                          </kbd>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })
          }
        />
      )}

      {viewingProcessId && (
        <BackgroundBashOutputDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setViewingProcessId(null);
            }
          }}
          workspaceId={props.workspaceId}
          processId={viewingProcessId}
          displayName={viewingProcess?.displayName}
          script={viewingProcess?.script}
        />
      )}
    </div>
  );
};
