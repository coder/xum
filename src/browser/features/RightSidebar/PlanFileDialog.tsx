import React, { useEffect, useRef, useState } from "react";
import assert from "@/common/utils/assert";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { MarkdownCore } from "@/browser/features/Messages/MarkdownCore";
import { PlanMarkdownContainer } from "@/browser/features/Messages/MarkdownRenderer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { isAbortError } from "@/browser/utils/isAbortError";
import { getErrorMessage } from "@/common/utils/errors";

interface PlanFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

export const PlanFileDialog: React.FC<PlanFileDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="flex max-h-[80vh] min-h-0 max-w-5xl flex-col overflow-hidden">
      {/* PostCompactionSection renders this dialog while closed: the body, and so its plan
          read, mounts only while the dialog is open. Keyed by workspace, so another workspace
          (or reopening the dialog) starts from an empty body, while a new API client (a
          reconnect) re-reads the plan in the background and keeps it shown. */}
      <PlanFileBody key={props.workspaceId} workspaceId={props.workspaceId} />
    </DialogContent>
  </Dialog>
);

type PlanRead =
  | { status: "ok"; content: string; path: string }
  | { status: "error"; error: string }
  /** Cut off by a lost connection (an abort): not a plan error. */
  | { status: "lost" };

async function readPlan(api: APIClient, workspaceId: string): Promise<PlanRead> {
  try {
    const result = await api.workspace.getPlanContent({ workspaceId });
    if (!result.success) {
      return { status: "error", error: result.error };
    }
    assert(result.data.path.length > 0, "Plan path should be non-empty");
    return { status: "ok", content: result.data.content, path: result.data.path };
  } catch (error: unknown) {
    return isAbortError(error)
      ? { status: "lost" }
      : { status: "error", error: getErrorMessage(error) };
  }
}

function usePlanFile(workspaceId: string) {
  const { api } = useAPI();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  // True once a plan is on screen: offline (no client during a reconnect) then keeps it.
  const hasPlanRef = useRef(false);

  useEffect(() => {
    assert(workspaceId.trim().length > 0, "workspaceId is required to load plan preview");

    if (!api) {
      if (!hasPlanRef.current) {
        setIsLoading(false);
        setError("API unavailable");
      }
      return;
    }

    // A read with a client replaces the offline error. Without a plan on screen, it shows
    // "Loading plan…" (the dialog may have opened while there was no client).
    setError(null);
    if (!hasPlanRef.current) {
      setIsLoading(true);
    }

    let cancelled = false;

    void readPlan(api, workspaceId).then((read) => {
      // A lost connection (or this effect's own cleanup) keeps what is shown for the next client.
      if (cancelled || read.status === "lost") {
        return;
      }
      setIsLoading(false);
      if (read.status === "error") {
        setError(read.error);
        return;
      }
      setError(null);
      setContent(read.content);
      setPath(read.path);
      hasPlanRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  return { isLoading, error, content, path };
}

function PlanFileBody(props: { workspaceId: string }) {
  const { isLoading, error, content, path } = usePlanFile(props.workspaceId);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-col gap-1">
          <span>Plan file</span>
          {path && (
            <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
              {path}
            </code>
          )}
        </DialogTitle>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-[var(--color-bg-secondary)] p-3">
        {error ? (
          <div className="text-error text-[11px]" data-testid="plan-file-dialog-error">
            {error}
          </div>
        ) : isLoading ? (
          <div className="text-muted text-[11px] italic">Loading plan…</div>
        ) : content !== null ? (
          content.length > 0 ? (
            <PlanMarkdownContainer>
              {/* Keyed by the text: a reload replaces the plan in place, and Streamdown's
                  elements re-render only when their source position changes, so an edit that
                  keeps the positions would otherwise stay stale on screen. */}
              <MarkdownCore key={content} content={content} />
            </PlanMarkdownContainer>
          ) : (
            <div className="text-muted text-[11px] italic">Plan file is empty</div>
          )
        ) : (
          <div className="text-muted text-[11px] italic">No plan loaded</div>
        )}
      </div>
    </>
  );
}
