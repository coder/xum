import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { cn } from "@/common/lib/utils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import type { ChatInputAPI } from "@/browser/features/ChatInput/types";
import {
  type AgentInterfaceView,
  recordStatusPageRead,
  useStatusArtifactEntry,
} from "./agentInterfaceView";
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

/** The status page's content, re-read when the file changes; null until the first read. */
function useStatusArtifactRead(workspaceId: string): ArtifactReadResult | null {
  const { api } = useAPI();
  const entry = useStatusArtifactEntry(workspaceId);
  const [read, setRead] = useState<ArtifactReadResult | null>(null);
  // Size too, since a same-mtime rewrite still changes it.
  const readKey = entry == null ? null : `${entry.modifiedMs}\u0000${entry.size}`;

  useEffect(() => {
    if (!api || readKey == null) return;
    const controller = new AbortController();
    api.artifacts
      .read({ workspaceId, path: AGENT_INTERFACE_STATUS_ARTIFACT }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        // A failed re-read keeps the last good page on screen; the next change retries.
        if (result.success) {
          setRead(result.data);
          recordStatusPageRead(workspaceId, result.data);
        } else console.debug("[Agent interface] status page read failed:", result.error);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.debug("[Agent interface] status page read failed:", getErrorMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, readKey]);

  return read;
}

interface StatusViewProps {
  workspaceId: string;
  dockRef: React.RefObject<HTMLElement | null>;
  /** The composer, which takes focus when a switch to the chat starts inside the page. */
  composerApiRef: React.RefObject<Pick<ChatInputAPI, "focus"> | null>;
}

/**
 * The Agent interface view's status page in the main pane: the live status artifact, laid over
 * the transcript region down to the composer dock, which stays usable below it. It is kept
 * mounted (hidden) while the transcript shows, so switching back does not reload the page.
 * Renders nothing when the workspace has no status page to switch to (view null).
 */
export function AgentInterfaceStatusView(
  props: StatusViewProps & { view?: AgentInterfaceView | null }
) {
  if (props.view == null) return null;
  return (
    <StatusPage
      workspaceId={props.workspaceId}
      dockRef={props.dockRef}
      composerApiRef={props.composerApiRef}
      hidden={props.view !== "status"}
    />
  );
}

/**
 * Browsers leave focus on a frame that stopped rendering, so after a switch to the chat from
 * inside the page, keystrokes would go to the hidden page. Hands them to the composer instead.
 * Returns the ref for the status page's section.
 */
function useComposerFocusWhenHidden(
  hidden: boolean,
  composerApiRef: StatusViewProps["composerApiRef"]
): React.RefObject<HTMLElement> {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!hidden || section == null || !section.contains(document.activeElement)) return;
    composerApiRef.current?.focus();
    // A disabled composer cannot take focus: still take it off the hidden page.
    if (section.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [hidden, composerApiRef]);
  return sectionRef;
}

function StatusPage(props: StatusViewProps & { hidden: boolean }) {
  const { workspaceId } = props;
  const read = useStatusArtifactRead(workspaceId);
  const dockHeight = useElementHeight(props.dockRef);
  // window.xum.send / setState, as in the Artifacts tab.
  const interactions = useArtifactInteractions(workspaceId, STATUS_TARGET);
  const { hidden } = props;
  const sectionRef = useComposerFocusWhenHidden(hidden, props.composerApiRef);

  return (
    <section
      ref={sectionRef}
      aria-label="Agent status page"
      data-testid="agent-interface-status-view"
      // Over the transcript (which stays mounted, keeping its scroll position) and under the
      // composer dock (z-10). The header spacer matches the transcript region's on touch phones.
      className={cn(
        "bg-surface-primary mobile-header-spacer absolute inset-y-0 left-0 z-[5] flex flex-col",
        hidden && "hidden"
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
