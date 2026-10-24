import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { cn } from "@/common/lib/utils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { useStatusArtifactEntry } from "./agentInterfaceView";
import { ArtifactViewer } from "./ArtifactViewer";
import { useArtifactInteractions } from "./useArtifactInteractions";

const STATUS_TARGET = {
  path: AGENT_INTERFACE_STATUS_ARTIFACT,
  version: null,
  latestVersion: null,
} as const;

/** Tracks an element's height (the composer dock), so the view ends where the dock begins. */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element == null || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/**
 * The Agent interface view's status page in the main pane: the live status artifact, laid over
 * the transcript region down to the composer dock, which stays usable below it. It is kept
 * mounted (hidden) while the transcript shows, so switching back does not reload the page.
 */
export function AgentInterfaceStatusView(props: {
  workspaceId: string;
  hidden: boolean;
  dockRef: React.RefObject<HTMLElement | null>;
}) {
  const { api } = useAPI();
  const { workspaceId } = props;
  const entry = useStatusArtifactEntry(workspaceId);
  const [read, setRead] = useState<ArtifactReadResult | null>(null);
  const dockHeight = useElementHeight(props.dockRef);
  // Re-read when the file changes; size too, since a same-mtime rewrite still changes it.
  const readKey = entry == null ? null : `${entry.modifiedMs}\u0000${entry.size}`;

  useEffect(() => {
    if (!api || readKey == null) return;
    const controller = new AbortController();
    api.artifacts
      .read({ workspaceId, path: AGENT_INTERFACE_STATUS_ARTIFACT }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        // A failed re-read keeps the last good page on screen; the next change retries.
        if (result.success) setRead(result.data);
        else console.debug("[Agent interface] status page read failed:", result.error);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.debug("[Agent interface] status page read failed:", getErrorMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, readKey]);

  // window.xum.send / setState, as in the Artifacts tab.
  const interactions = useArtifactInteractions(workspaceId, STATUS_TARGET);

  return (
    <section
      aria-label="Agent status page"
      data-testid="agent-interface-status-view"
      // Over the transcript (which stays mounted, keeping its scroll position) and under the
      // composer dock (z-10). The header spacer matches the transcript region's on touch phones.
      className={cn(
        "bg-surface-primary mobile-header-spacer absolute inset-y-0 left-0 z-[5] flex flex-col",
        props.hidden && "hidden"
      )}
      style={{
        right: "var(--chat-reserved-inline-end, 0px)",
        paddingBottom: dockHeight,
      }}
      // The send strip's Send/Dismiss chords, while it is shown.
      onKeyDown={(e) => {
        interactions.handleKeyDown(e);
      }}
    >
      {interactions.strip}
      <div className="min-h-0 flex-1 overflow-auto">
        {read == null ? (
          <div className="text-muted p-4 text-xs">Loading…</div>
        ) : (
          <ArtifactViewer
            result={read}
            workspaceId={workspaceId}
            interactions={interactions.handlers}
          />
        )}
      </div>
    </section>
  );
}
