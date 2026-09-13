import { useEffect, useRef, useState } from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import { useWorkspaceMetadataOptional } from "@/browser/contexts/WorkspaceContext";
import { Loader2, GitBranch, ChevronRight, CheckCircle2, AlertCircle } from "lucide-react";
import { Shimmer } from "../AIElements/Shimmer";
import { formatDuration } from "@/common/utils/formatDuration";
import { ProgressBar } from "@/browser/components/ProgressBar/ProgressBar";

type WorkspaceInitDisplayedMessage = Extract<DisplayedMessage, { type: "workspace-init" }>;

/**
 * Name generation that outlives creation: Send no longer waits for the LLM title, so the card
 * lists it as its own step ("pending" while the backend still marks the title pending, "done"
 * once the title landed). Omitted for workspaces whose name was ready before creation.
 */
export type InitNameGenerationState = "pending" | "done";

interface InitMessageProps {
  message: WorkspaceInitDisplayedMessage;
  className?: string;
  nameGeneration?: InitNameGenerationState;
}

interface WorkspaceInitMessageProps {
  message: WorkspaceInitDisplayedMessage;
  className?: string;
  workspaceId?: string;
}

/**
 * Transcript-connected card: derives the name-generation step from the workspace metadata so
 * only this row re-renders on metadata changes. The "done" state is remembered locally because
 * the metadata flag simply disappears once the title lands.
 */
export function WorkspaceInitMessage(props: WorkspaceInitMessageProps) {
  const workspaceMetadata = useWorkspaceMetadataOptional()?.workspaceMetadata;
  const metadata =
    props.workspaceId === undefined ? undefined : workspaceMetadata?.get(props.workspaceId);
  const namePending = metadata?.pendingAutoTitle === true;
  const [sawNamePending, setSawNamePending] = useState(namePending);
  if (namePending && !sawNamePending) {
    setSawNamePending(true);
  }
  const nameGeneration: InitNameGenerationState | undefined = namePending
    ? "pending"
    : sawNamePending
      ? "done"
      : undefined;
  return (
    <InitMessage
      message={props.message}
      className={props.className}
      nameGeneration={nameGeneration}
    />
  );
}

export function InitMessage(props: InitMessageProps) {
  const message = props.message;
  const isError = message.status === "error";
  const isRunning = message.status === "running";
  const namePending = props.nameGeneration === "pending";
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const [detailsOverride, setDetailsOverride] = useState<boolean | null>(null);
  // Stay open while the name is still generating so the step's completion is visible even
  // when init itself finished in a few hundred milliseconds.
  const expanded = expandedOverride ?? (message.status !== "success" || namePending);
  const steps = message.lines.filter((line) => line.step === true);
  const rawLines = message.lines.filter((line) => line.step !== true);
  const detailsExpanded = steps.length === 0 || (detailsOverride ?? !isRunning);
  const preRef = useRef<HTMLPreElement>(null);

  // Keep the newest output in view: while lines stream in, and when a finished (often
  // failed) card first reveals its log, whose last lines explain the outcome.
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [isRunning, message.lines.length, expanded, detailsExpanded]);

  const durationText =
    message.durationMs !== null ? ` in ${formatDuration(message.durationMs, "precise")}` : "";

  return (
    <div className={cn("my-2 min-w-0 text-xs", props.className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpandedOverride(!expanded)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 py-2 text-left",
          isError ? "text-error" : "text-muted"
        )}
      >
        <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {isRunning ? (
            <Shimmer colorClass="var(--color-accent)">Creating workspace</Shimmer>
          ) : isError ? (
            <>
              Workspace setup failed (exit code {message.exitCode}){durationText}
            </>
          ) : (
            <>Workspace created{durationText}</>
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", expanded && "rotate-90")}
        />
      </button>
      {expanded && (
        <div
          className={cn(
            "min-w-0 rounded border px-3 py-2",
            isError ? "border-init-error-border bg-init-error-bg" : "border-init-border bg-init-bg"
          )}
        >
          {(steps.length > 0 || props.nameGeneration !== undefined) && (
            <ol className="m-0 mb-2 list-none space-y-2 p-0">
              {props.nameGeneration !== undefined && (
                <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                  {namePending ? (
                    <Loader2
                      aria-label="In progress"
                      className="text-accent size-3.5 animate-spin"
                    />
                  ) : (
                    <CheckCircle2 aria-label="Completed" className="text-accent size-3.5" />
                  )}
                  <span className="text-foreground truncate">Generating name</span>
                </li>
              )}
              {steps.map((step, index) => {
                const isLast = index === steps.length - 1;
                return (
                  <li
                    key={index}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2"
                  >
                    {isLast && isRunning ? (
                      <Loader2
                        aria-label="In progress"
                        className="text-accent size-3.5 animate-spin"
                      />
                    ) : isLast && isError ? (
                      <AlertCircle aria-label="Failed" className="text-error size-3.5" />
                    ) : (
                      <CheckCircle2 aria-label="Completed" className="text-accent size-3.5" />
                    )}
                    <span className="text-foreground truncate">{step.line}</span>
                    {isLast && isRunning && message.progress && (
                      <div className="flex items-center gap-2">
                        <ProgressBar
                          className="w-16"
                          value={message.progress.percent}
                          aria-label={message.progress.label}
                        />
                        <span className="counter-nums text-muted w-[4ch] text-right">
                          {message.progress.percent}%
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {steps.length > 0 && (
            <button
              type="button"
              aria-expanded={detailsExpanded}
              onClick={() => setDetailsOverride(!detailsExpanded)}
              className="text-muted flex items-center gap-1 py-1"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5", detailsExpanded && "rotate-90")}
              />
              More details
            </button>
          )}
          {detailsExpanded && (
            <>
              <div className="text-muted mt-1 truncate font-mono text-[11px]">
                {message.hookPath}
              </div>
              {(rawLines.length > 0 || !!message.truncatedLines) && (
                <pre
                  ref={preRef}
                  className="bg-init-output-bg text-init-output-text m-0 mt-2 max-h-[120px] overflow-auto rounded-sm px-2 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >
                  {message.truncatedLines && (
                    <span className="text-muted">
                      ... {message.truncatedLines.toLocaleString()} earlier lines truncated ...
                      {"\n"}
                    </span>
                  )}
                  {rawLines.map((line, index) => (
                    <span
                      key={index}
                      className={line.isError ? "text-init-output-error-text" : undefined}
                    >
                      {line.line}
                      {index < rawLines.length - 1 ? "\n" : ""}
                    </span>
                  ))}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
