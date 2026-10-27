import React, { useState, useCallback, useEffect, useRef } from "react";
import { Terminal, X, Loader2, FileText } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import { BackgroundBashOutputDialog } from "../BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import { ActivityChipLiveDot, ChatInputDecoration } from "../ChatPane/ChatInputDecoration";
import { useChatActivityPanel } from "../ChatPane/chatActivityPanels";
import { formatKeyLabel } from "../Keycap/Keycap";
import { formatElapsed } from "@/common/utils/formatDuration";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
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
  isCommandPaletteTarget,
  isDialogOpen,
  isTerminalFocused,
  matchesKeybind,
  paneHandlesKeyEvent,
} from "@/browser/utils/ui/keybinds";
import { useChatPaneScope } from "@/browser/contexts/ChatPaneScopeContext";
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

/**
 * The strip's expand/collapse control: the live line's chip, or else the row button that
 * ChatInputDecoration renders just before the list (the VS Code webview's tray).
 */
function stripToggle(root: HTMLElement | null, list: HTMLElement | null): Element | null {
  return root?.querySelector("[data-activity-chip]") ?? list?.previousElementSibling ?? null;
}

function backgroundBashNoun(count: number): string {
  return count === 1 ? "background bash" : "background bashes";
}

/** "2 running", plus the exited rows still waiting to wake the agent. */
function formatBashesPanelMeta(count: number, runningCount: number): string {
  const waking = count - runningCount;
  return waking > 0 ? `${runningCount} running · ${waking} waking the agent` : `${count} running`;
}

/** The row keys, under the list: the strip is keyboard-driven but its keys are otherwise hidden. */
function BashesKeyHints(props: { canViewOutput: boolean }) {
  const hints = [
    `${formatKeyLabel(KEYBINDS.BACKGROUND_PROCESS_PREV.key)}${formatKeyLabel(KEYBINDS.BACKGROUND_PROCESS_NEXT.key)} move`,
    props.canViewOutput &&
      `${formatKeyLabel(KEYBINDS.BACKGROUND_PROCESS_VIEW_OUTPUT.key)} view output`,
    `${formatKeyLabel(KEYBINDS.BACKGROUND_PROCESS_TERMINATE.key)} terminate`,
    `${formatKeyLabel(KEYBINDS.CANCEL.key)} close`,
  ];
  return <>{hints.filter((hint) => hint !== false).join(" · ")}</>;
}

type ProcessRowFields = Pick<BackgroundProcessInfo, "id" | "script" | "displayName">;

/**
 * What a row leads with: its command, the script's first non-blank line (the row truncates it to
 * fit), else the agent's name for the process.
 */
function processRowTitle(proc: ProcessRowFields): string {
  const command = proc.script.split("\n").find((line) => line.trim() !== "");
  return command?.trim() ?? proc.displayName ?? proc.id;
}

/**
 * A row's muted line, e.g. "CI watch · watching /READY|FAILED/ · 0 matches · pid 48211": the
 * agent's name for the process (the row leads with its command), then its monitor and pid. Rows
 * synthesized from a durable pending wake (process gone after restart) carry no real pid, but
 * always a monitor.
 */
export function formatProcessDetail(
  proc: ProcessRowFields & Pick<BackgroundProcessInfo, "monitor" | "pid">
): string {
  const parts: string[] = [];
  if (proc.displayName && proc.displayName !== processRowTitle(proc)) {
    parts.push(proc.displayName);
  }
  if (proc.monitor) {
    const matches = proc.monitor.totalMatches;
    parts.push(`watching /${proc.monitor.filter}/`, `${matches} match${matches === 1 ? "" : "es"}`);
    if (proc.monitor.stopped) parts.push("stopped");
  }
  if (proc.pid > 0) parts.push(`pid ${proc.pid}`);
  return parts.join(" · ");
}

/** The chip's live dot, per running row; a blank slot keeps exited rows aligned. */
function ProcessRowDot(props: { running: boolean }) {
  return props.running ? (
    <ActivityChipLiveDot />
  ) : (
    <span aria-hidden className="size-1.5 shrink-0" />
  );
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
  const [isExpanded, setIsExpanded] = useChatActivityPanel("background-bashes");
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
  // The output dialog has no trigger to return focus to, so opening it records what opened it:
  // the row (keyboard) or its View output button (mouse). Radix would otherwise leave focus on
  // the body, where the next Escape closed the panel instead of reaching the row.
  const refocusAfterOutputRef = useRef<{ target: HTMLElement; index: number } | null>(null);
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
  const runningCount = visibleProcesses.filter((p) => p.status === "running").length;
  const hasRunning = runningCount > 0;

  // Update duration display every second when expanded (exited processes show no duration)
  useEffect(() => {
    if (!isExpanded || !hasRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExpanded, hasRunning]);

  // The main chat and the /side chat tab each mount a banner; the chord goes to the pane owning
  // the focused element so focus never jumps into the other chat's list.
  const paneScope = useChatPaneScope();
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
      if (!paneHandlesKeyEvent(paneScope, event.target)) return;
      if (isCommandPaletteTarget(event.target)) return;
      if (isTerminalFocused(event.target)) return; // the terminal owns its keystrokes
      if (rootRef.current?.closest("[inert]")) return;
      event.preventDefault();
      if (event.repeat) return;
      if (listRef.current?.contains(document.activeElement)) {
        const toggle = stripToggle(rootRef.current, listRef.current);
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
  }, [count, props.workspaceId, paneScope, setIsExpanded]);

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
    if (target.target.isConnected) {
      target.target.focus();
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
      const toggle = stripToggle(rootRef.current, listRef.current);
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
      refocusAfterOutputRef.current = { target: row, index };
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

  const handleViewOutput = (
    processId: string,
    index: number,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    event.stopPropagation();
    refocusAfterOutputRef.current = { target: event.currentTarget, index };
    setViewingProcessId(processId);
  };

  const handleTerminate = useCallback(
    (processId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      terminate(processId);
    },
    [terminate]
  );

  const handleToggle = () => setIsExpanded((prev) => !prev);

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
          dataComponent="BackgroundProcessesBanner"
          activityId="background-bashes"
          chipLabel={`${count} ${backgroundBashNoun(count)}`}
          chipTooltip={
            <>
              Background bashes
              <kbd className={SHORTCUT_HINT_CLASS}>
                {formatKeybind(KEYBINDS.FOCUS_BACKGROUND_PROCESSES)}
              </kbd>
            </>
          }
          chip={
            <>
              <Terminal className="size-3.5 shrink-0" />
              <span className="counter-nums">{count}</span>
              {hasRunning && <ActivityChipLiveDot />}
            </>
          }
          panelTitle="Background bashes"
          panelMeta={formatBashesPanelMeta(count, runningCount)}
          panelShortcut={formatKeybind(KEYBINDS.FOCUS_BACKGROUND_PROCESSES)}
          panelFooter={<BashesKeyHints canViewOutput={canViewOutput} />}
          tab={
            <>
              <Terminal className="size-4 shrink-0" />
              <span>Bashes</span>
              <span className="counter-nums text-muted">{count}</span>
            </>
          }
          summary={
            <>
              <Terminal className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
              <span className="text-muted group-hover:text-secondary transition-colors">
                <span className="font-medium">{count}</span> {backgroundBashNoun(count)}
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
                    "focus-visible:ring-accent focus-visible:bg-hover outline-none focus-visible:ring-1",
                    "transition-colors",
                    isTerminating && "pointer-events-none opacity-50"
                  )}
                >
                  <ProcessRowDot running={proc.status === "running"} />
                  <div className="min-w-0 flex-1">
                    {/* The command, as in the approved design; the detail line names the
                        process. The tooltip carries the whole script, which the row cuts at
                        its first line and the row's width. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-foreground truncate font-mono text-xs">
                          {processRowTitle(proc)}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-md font-mono break-all whitespace-pre-wrap">
                        {proc.script}
                      </TooltipContent>
                    </Tooltip>
                    <div className="text-muted truncate text-[10px]">
                      {formatProcessDetail(proc)}
                    </div>
                    {/* Own non-truncating line: appended to the detail line above, a long
                        filter would right-ellipsize this away on narrow widths, hiding the
                        only explanation for an exited row. */}
                    {proc.monitor?.pendingWakeKind != null && (
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
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Exited-but-wake-pending rows have no live duration to increment */}
                    {proc.status === "running" && (
                      <span className="text-muted counter-nums-mono text-[10px]">
                        {formatElapsed(Date.now() - proc.startTime)}
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
                            onClick={(e) => handleViewOutput(proc.id, index, e)}
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
                            aria-label="Terminate process"
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
