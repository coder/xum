import React, { useEffect, useState } from "react";
import { CopyButton } from "../CopyButton/CopyButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../Dialog/Dialog";
import { DetailContent } from "@/browser/features/Tools/Shared/ToolPrimitives";
import { useAPI } from "@/browser/contexts/API";
import { useBackgroundProcesses } from "@/browser/stores/BackgroundBashStore";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  appendLiveBashOutputChunk,
  type LiveBashOutputInternal,
} from "@/browser/utils/messages/liveBashOutputBuffer";
import { BASH_TRUNCATE_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import { getErrorMessage } from "@/common/utils/errors";

const BACKGROUND_BASH_INITIAL_TAIL_BYTES = 64_000;
const BACKGROUND_BASH_POLL_INTERVAL_MS = 500;

interface BackgroundBashOutputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  processId: string;
  displayName?: string;
  /** The bash script being run, shown so the user can tell what the process is doing. */
  script?: string;
}

export const BackgroundBashOutputDialog: React.FC<BackgroundBashOutputDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    {/* flex-col (not the default grid) so the output viewer shrinks when the
        header + script push total content past max-h; otherwise overflow-hidden
        would clip the bottom of the output pane at small window heights. */}
    <DialogContent className="flex max-h-[80vh] max-w-4xl flex-col gap-3 overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="font-mono text-sm">{props.displayName ?? props.processId}</span>
          {/* The backend uses the display name as the process ID, so the chip only adds
              information when they differ (a duplicate name gets a suffixed ID). */}
          {props.displayName && props.displayName !== props.processId && (
            <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
              {props.processId}
            </code>
          )}
        </DialogTitle>
        {/* The script sits right under the title (no label) so the user can tell what
            the process is doing without a full labeled section eating vertical space. */}
        {props.script && (
          <DetailContent className="max-h-24 px-2 py-1">{props.script}</DetailContent>
        )}
      </DialogHeader>

      {/* Keyed by the process, so another process starts from an empty viewer, while a new API
          client (a reconnect) only re-runs the viewer's read and keeps the output it shows. */}
      <BackgroundBashOutputViewer
        key={`${props.workspaceId}:${props.processId}`}
        workspaceId={props.workspaceId}
        processId={props.processId}
      />
    </DialogContent>
  </Dialog>
);

const BackgroundBashOutputViewer: React.FC<{ workspaceId: string; processId: string }> = (
  props
) => {
  const { api } = useAPI();

  // Live wake-on-match monitor info, folded into the status row (banner-style
  // phrasing) so it costs no extra vertical space. Looked up from the store so
  // the match count stays current while the dialog is open; the viewer is only
  // mounted while open, so closed tool cards hold no subscription.
  const processes = useBackgroundProcesses(props.workspaceId);
  const monitor = processes.find((p) => p.id === props.processId)?.monitor;

  const [output, setOutput] = useState<LiveBashOutputInternal | undefined>(undefined);
  const [status, setStatus] = useState<"running" | "exited" | "killed" | "failed">("running");
  const [truncatedStart, setTruncatedStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // No reset of the shown output here: the first read below replaces it. Before the first
    // read lands, the viewer still shows "Loading…" (its initial state).
    setError(null);

    if (!api) {
      setError("API unavailable");
      return;
    }

    let cancelled = false;

    const run = async () => {
      let offset: number | undefined = undefined;

      // The process identity is the same on every poll; only the read window
      // differs (initial tail vs. incremental fromOffset), so keep it in one place.
      const target = { workspaceId: props.workspaceId, processId: props.processId };

      while (!cancelled) {
        const result = await api.workspace.backgroundBashes.getOutput(
          offset === undefined
            ? { ...target, tailBytes: BACKGROUND_BASH_INITIAL_TAIL_BYTES }
            : { ...target, fromOffset: offset }
        );

        if (cancelled) return;

        setIsLoading(false);

        if (!result.success) {
          setError(result.error);
          return;
        }

        setStatus(result.data.status);
        // The first read is a fresh tail (the only read that can be truncated at its start), so
        // it replaces any output kept from an earlier run (a reconnect); later reads append.
        if (offset === undefined) {
          setTruncatedStart(result.data.truncatedStart);
          setOutput(undefined);
        }

        offset = result.data.nextOffset;

        if (result.data.output.length > 0) {
          setOutput((prev) =>
            appendLiveBashOutputChunk(
              prev,
              { text: result.data.output, isError: false },
              BASH_TRUNCATE_MAX_TOTAL_BYTES
            )
          );
        }

        if (result.data.status !== "running") {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_BASH_POLL_INTERVAL_MS));
      }
    };

    // A rejected read stops polling with the error shown instead of escaping as an unhandled
    // rejection; reopening the dialog starts a fresh read. A lost connection (an abort) shows no
    // error and keeps the output: the next client polls again.
    run().catch((err: unknown) => {
      if (cancelled || isAbortError(err)) return;
      setIsLoading(false);
      setError(getErrorMessage(err));
    });

    return () => {
      cancelled = true;
    };
  }, [api, props.processId, props.workspaceId]);

  const text = output?.combined ?? "";
  const isTruncatedToMaxBytes = output?.truncated ?? false;

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted min-w-0 flex-1 truncate font-mono text-[11px]">
          status: {status}
          {monitor && (
            <>
              {" · watching "}
              {monitor.filter_exclude && "not "}/{monitor.filter}/ · {monitor.totalMatches} match
              {monitor.totalMatches === 1 ? "" : "es"}
              {monitor.stopped && " · stopped"}
            </>
          )}
        </div>
        <CopyButton text={text} className="h-6" />
      </div>

      {truncatedStart && (
        <div className="text-muted text-[10px] italic">
          Showing last {Math.round(BACKGROUND_BASH_INITIAL_TAIL_BYTES / 1000)}KB
        </div>
      )}

      {isTruncatedToMaxBytes && (
        <div className="text-muted text-[10px] italic">Output truncated (showing last ~1MB)</div>
      )}

      {error && <div className="text-error text-[11px]">{error}</div>}

      {/* flex-1 + max-h-none: fill whatever height remains inside the dialog's
          80vh cap and scroll internally, instead of a fixed 60vh that could
          overflow the dialog once the header/script take their share. The small
          min-h keeps a visible pane for "No output yet" while still letting very
          short windows shrink it instead of clipping it at the dialog edge. */}
      <DetailContent className="max-h-none min-h-24 flex-1 px-2 py-1.5">
        {isLoading ? "Loading…" : text.length > 0 ? text : error ? "" : "No output yet"}
      </DetailContent>
    </div>
  );
};
