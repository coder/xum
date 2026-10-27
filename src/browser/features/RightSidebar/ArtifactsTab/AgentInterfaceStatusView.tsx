import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleDot, ListStart, Loader2 } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useStartHere } from "@/browser/hooks/useStartHere";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { AGENT_INTERFACE_TRANSCRIPT_PEEK_KEY } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import type { ChatInputAPI } from "@/browser/features/ChatInput/types";
import { useUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  deriveLastMessageReceipt,
  deriveStatusActivity,
  findStartHereSource,
  isTurnActive,
  recentTranscriptRows,
  type LastMessageReceipt,
  type LastMessageReceiptState,
  type StatusActivity,
} from "./agentInterfaceStatusBar";
import {
  readStatusPage,
  recordStatusPageRead,
  subscribeStatusListings,
  useStatusArtifactEntry,
} from "./agentInterfaceView";
import type { AgentInterfaceView } from "./agentInterfaceViewState";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";
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
      subscribeStatusListings(workspaceId, (afterToolWrite) => {
        if (!afterToolWrite && !staleRef.current) return;
        staleRef.current = false;
        setRetryTick((tick) => tick + 1);
      }),
    [workspaceId]
  );

  useEffect(() => {
    if (!api || readKey == null) return;
    const controller = new AbortController();
    readStatusPage(api, workspaceId, controller.signal, {
      onRead: (result) => {
        setRead(result);
        recordStatusPageRead(workspaceId, result);
      },
      // A failed read keeps the last good page on screen until the retry.
      onFailure: () => {
        staleRef.current = true;
      },
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

/**
 * SECURITY AUDIT: the status page shows without the user opening it, so none of its sends skips
 * the confirm strip. In the Artifacts tab a send during a live gesture in the frame goes out at
 * once (SandboxedArtifactFrame's hasLiveUserGesture), but the page's script can take focus with
 * window.focus() right after the user's click or key elsewhere in Xum, while that activation is
 * still live, and the gate then takes it for a click in the page.
 */
function askBeforeEverySend(
  handlers: ArtifactInteractionHandlers | undefined
): ArtifactInteractionHandlers | undefined {
  if (handlers == null) return undefined;
  return { ...handlers, requestSend: (text, data) => handlers.requestSend(text, data, "ask") };
}

/** How many transcript rows the peek lists. */
const TRANSCRIPT_PEEK_ROWS = 8;

const RECEIPT_CHIPS: Record<LastMessageReceiptState, { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-pending" },
  held: { label: "Held, not sent", className: "text-error" },
  sending: { label: "Sending…", className: "text-muted" },
  "in-transcript": { label: "In transcript", className: "text-success" },
};

/**
 * The workspace's state, or null while the store has not registered it (tests, teardown):
 * the bar then shows nothing instead of throwing.
 */
function useRegisteredWorkspaceState(workspaceId: string): WorkspaceState | null {
  const store = useWorkspaceStoreRaw();
  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => (store.hasRegisteredWorkspace(workspaceId) ? store.getWorkspaceState(workspaceId) : null)
  );
}

function ActivityIcon(props: { activity: StatusActivity }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (props.activity.kind) {
    case "idle":
      return <CircleDot aria-hidden="true" className={cn(className, "text-muted")} />;
    case "error":
      return <CircleAlert aria-hidden="true" className={cn(className, "text-error")} />;
    default:
      return <Loader2 aria-hidden="true" className={cn(className, "text-muted animate-spin")} />;
  }
}

/**
 * The host's bar above the Agent interface status page: what the agent does right now, where the
 * user's last message is, a peek at the transcript the page covers, and Start Here from the
 * agent's last reply. A leaf that subscribes to the workspace itself, so stream deltas re-render
 * only the bar, not the page's frame.
 */
function AgentInterfaceStatusBar(props: { workspaceId: string }) {
  const state = useRegisteredWorkspaceState(props.workspaceId);
  if (state == null) return null;
  return <StatusBar workspaceId={props.workspaceId} state={state} />;
}

function StatusBar(props: { workspaceId: string; state: WorkspaceState }) {
  const { state } = props;
  const panelId = useId();
  const [peekOpen, setPeekOpen] = usePersistedState(AGENT_INTERFACE_TRANSCRIPT_PEEK_KEY, false);
  const activity = deriveStatusActivity(state.messages, {
    canInterrupt: state.canInterrupt,
    isStreamStarting: state.isStreamStarting,
    isCompacting: state.isCompacting,
    awaitingUserQuestion: state.awaitingUserQuestion,
    runtimeDetail: state.runtimeStatus?.detail,
  });
  const receipt = deriveLastMessageReceipt(state.messages, state.queuedMessage, state.heldInputs);

  return (
    <>
      <div
        data-testid="agent-interface-status-bar"
        className="border-border-light bg-surface-secondary shrink-0 border-b text-[11px]"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
          <ActivityLine activity={activity} />
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-expanded={peekOpen}
              aria-controls={panelId}
              onClick={() => setPeekOpen(!peekOpen)}
              className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent h-6 rounded px-1.5 focus-visible:ring-1"
            >
              {peekOpen ? "Hide transcript" : "Show transcript"}
            </button>
            <StartHereButton
              workspaceId={props.workspaceId}
              messages={state.messages}
              turnActive={isTurnActive(activity)}
            />
          </div>
        </div>
        {receipt != null && <ReceiptRow receipt={receipt} />}
      </div>
      {peekOpen && <TranscriptPeek id={panelId} messages={state.messages} />}
    </>
  );
}

function ActivityLine(props: { activity: StatusActivity }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="agent-interface-status-activity"
      className="flex min-w-0 flex-[1_1_12rem] items-center gap-1.5"
    >
      <ActivityIcon activity={props.activity} />
      <span className="min-w-0 truncate">
        <span className="text-foreground font-medium">{props.activity.label}</span>
        {props.activity.detail != null && (
          <span className="text-muted">
            {" · "}
            {props.activity.detail}
          </span>
        )}
      </span>
    </div>
  );
}

/** Start Here from the agent's last reply, as on the reply in the chat; off while a turn runs. */
function StartHereButton(props: {
  workspaceId: string;
  messages: WorkspaceState["messages"];
  turnActive: boolean;
}) {
  const source = findStartHereSource(props.messages);
  // No eligible reply counts as compacted, which keeps the hook's modal from opening.
  const startHere = useStartHere(props.workspaceId, source?.content ?? "", source == null, {
    // Preserve legacy plan/exec markers so Start Here keeps plan→exec handoff for old history.
    sourceAgentId: source?.agentId ?? source?.mode,
  });
  return (
    <>
      <TooltipIfPresent
        tooltip="Start a new context from the agent's last reply and keep earlier history"
        side="bottom"
        align="end"
      >
        <button
          type="button"
          disabled={startHere.disabled || props.turnActive}
          onClick={startHere.openModal}
          className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex h-6 items-center gap-1 rounded px-1.5 focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50"
        >
          <ListStart aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          Start here
        </button>
      </TooltipIfPresent>
      {startHere.modal}
    </>
  );
}

function ReceiptRow(props: { receipt: LastMessageReceipt }) {
  const { receipt } = props;
  const chip = RECEIPT_CHIPS[receipt.state];
  return (
    <div
      data-testid="agent-interface-status-receipt"
      className="flex min-w-0 items-center gap-2 px-3 pb-1"
    >
      <span className="text-muted shrink-0">Last message</span>
      <span className="min-w-0 flex-1 truncate">{receipt.preview}</span>
      <span className={cn("shrink-0 font-medium", chip.className)}>
        {chip.label}
        {receipt.state === "in-transcript" && receipt.timestamp != null && (
          <span className="text-muted counter-nums font-normal">
            {" · "}
            {formatRelativeTime(receipt.timestamp)}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The transcript's newest rows, one line each. A sibling of the bar in the status section, so
 * its 40% cap resolves against the section and the page keeps the rest. column-reverse anchors
 * the scroll at the bottom: it follows new rows while the user is at the bottom, with no effect.
 */
function TranscriptPeek(props: { id: string; messages: WorkspaceState["messages"] }) {
  const rows = recentTranscriptRows(props.messages, TRANSCRIPT_PEEK_ROWS);
  return (
    <div
      id={props.id}
      role="region"
      aria-label="Recent transcript"
      data-testid="agent-interface-transcript-peek"
      className="border-border-light flex max-h-[40%] shrink-0 flex-col-reverse overflow-y-auto border-b text-[11px]"
    >
      {rows.length === 0 ? (
        <div className="text-muted px-3 py-1.5">No messages yet</div>
      ) : (
        <ol className="flex flex-col py-1">
          {rows.map((row) =>
            row.kind === "boundary" ? (
              <li
                key={row.id}
                className="text-muted before:bg-border-light after:bg-border-light flex items-center gap-2 px-3 py-0.5 before:h-px before:flex-1 after:h-px after:flex-1"
              >
                {row.label}
              </li>
            ) : (
              <li key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-0.5">
                <span
                  className={cn(
                    "max-w-[12rem] truncate font-medium",
                    row.kind === "error" ? "text-error" : "text-muted"
                  )}
                >
                  {row.label}
                </span>
                <span className="truncate">{row.preview}</span>
              </li>
            )
          )}
        </ol>
      )}
    </div>
  );
}

function StatusPage(props: StatusViewProps) {
  const { workspaceId } = props;
  const read = useStatusArtifactRead(workspaceId);
  const dockHeight = useElementHeight(props.dockRef);
  // window.xum.send / setState, as in the Artifacts tab, except that every send asks first.
  const interactions = useArtifactInteractions(workspaceId, STATUS_TARGET);
  const sectionRef = useComposerFocusOnUnmount(props.composerApiRef);
  const vimEnabled = useUserPreferences(
    (preferences) => preferences.appearance?.vimEnabled === true
  );

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
      {/* Host-rendered, outside the sandboxed page: live activity, the last send's state, a
          transcript peek and Start Here, which the page covering the transcript would hide. */}
      <AgentInterfaceStatusBar workspaceId={workspaceId} />
      {interactions.strip}
      <div className="min-h-0 flex-1 overflow-auto">
        {read == null ? (
          <div className="text-muted p-4 text-xs">Loading…</div>
        ) : (
          <ArtifactViewer
            result={read}
            workspaceId={workspaceId}
            interactions={askBeforeEverySend(interactions.handlers)}
            // The page takes the chat's place, so the chat's interrupt key and the view switch
            // work with focus in the page.
            mainPaneInterruptKey={vimEnabled ? "vim" : "normal"}
          />
        )}
      </div>
    </section>
  );
}
