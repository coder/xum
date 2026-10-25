import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getErrorMessage } from "@/common/utils/errors";
import type { ChatInputAPI } from "@/browser/features/ChatInput/types";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  type AgentInterfaceView,
  recordStatusPageRead,
  subscribeStatusListings,
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

/**
 * The status page's content; null until the first read. Re-read when the listing shows a new
 * version of the file, and on the next successful listing after a failed read or a tool call
 * that may have written files: remote runtimes list whole-second mtimes, so a same-size rewrite
 * can keep the listed version.
 */
function useStatusArtifactRead(workspaceId: string): ArtifactReadResult | null {
  const { api } = useAPI();
  const entry = useStatusArtifactEntry(workspaceId);
  const [read, setRead] = useState<ArtifactReadResult | null>(null);
  const staleRef = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  // Size too, since a same-mtime rewrite usually changes it.
  const readKey = entry == null ? null : `${entry.modifiedMs}\u0000${entry.size}`;

  useEffect(
    () =>
      workspaceStore.subscribeFileModifyingTool(() => {
        staleRef.current = true;
      }, workspaceId),
    [workspaceId]
  );
  useEffect(
    () =>
      subscribeStatusListings(workspaceId, () => {
        if (!staleRef.current) return;
        staleRef.current = false;
        setRetryTick((tick) => tick + 1);
      }),
    [workspaceId]
  );

  useEffect(() => {
    if (!api || readKey == null) return;
    const controller = new AbortController();
    // A failed read keeps the last good page on screen until the retry.
    const failed = (error: string) => {
      staleRef.current = true;
      console.debug("[Agent interface] status page read failed:", error);
    };
    api.artifacts
      .read({ workspaceId, path: AGENT_INTERFACE_STATUS_ARTIFACT }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.success) {
          failed(result.error);
          return;
        }
        setRead(result.data);
        recordStatusPageRead(workspaceId, result.data);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        failed(getErrorMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, readKey, retryTick]);

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
 * the transcript region down to the composer dock, which stays usable below it. Renders nothing
 * unless the status view shows: the page is unmounted while the transcript shows, so its script
 * cannot take focus (and the user's typing) or queue sends the user cannot see.
 */
export function AgentInterfaceStatusView(
  props: StatusViewProps & { view?: AgentInterfaceView | null }
) {
  if (props.view !== "status") return null;
  return (
    <StatusPage
      workspaceId={props.workspaceId}
      dockRef={props.dockRef}
      composerApiRef={props.composerApiRef}
    />
  );
}

/**
 * A switch to the chat from inside the page removes the focused frame, which would leave focus
 * nowhere. Hands it to the composer instead. A layout cleanup runs before React removes the
 * section, so it still sees where focus is. Returns the ref for the status page's section.
 */
function useComposerFocusOnUnmount(
  composerApiRef: StatusViewProps["composerApiRef"]
): React.RefObject<HTMLElement> {
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    // The composer's API, not a node this component renders: the cleanup wants the live one.
    const composer = composerApiRef;
    return () => {
      if (section?.contains(document.activeElement)) composer.current?.focus();
    };
  }, [composerApiRef]);
  return sectionRef;
}

function StatusPage(props: StatusViewProps) {
  const { workspaceId } = props;
  const read = useStatusArtifactRead(workspaceId);
  const dockHeight = useElementHeight(props.dockRef);
  // window.xum.send / setState, as in the Artifacts tab.
  const interactions = useArtifactInteractions(workspaceId, STATUS_TARGET);
  const sectionRef = useComposerFocusOnUnmount(props.composerApiRef);

  return (
    <section
      ref={sectionRef}
      aria-label="Agent status page"
      data-testid="agent-interface-status-view"
      // Over the transcript (which stays mounted, keeping its scroll position) and under the
      // composer dock (z-10). The header spacer matches the transcript region's on touch phones.
      className="bg-surface-primary mobile-header-spacer absolute inset-y-0 left-0 z-[5] flex flex-col"
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
