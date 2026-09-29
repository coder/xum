import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Pencil } from "lucide-react";

import type { HeldInput as HeldInputData, WorkspaceChatMessage } from "xum/common/orpc/types";
import type { DisplayedMessage } from "xum/common/types/message";
import { createClient } from "xum/common/orpc/client";

import { ProviderOptionsProvider } from "xum/browser/contexts/ProviderOptionsContext";
import { SettingsProvider } from "xum/browser/contexts/SettingsContext";
import { APIProvider, type APIClient } from "xum/browser/contexts/API";
import { ThemeProvider } from "xum/browser/contexts/ThemeContext";
import { ChatHostContextProvider } from "xum/browser/contexts/ChatHostContext";
import { RouterProvider } from "xum/browser/contexts/RouterContext";
import { PolicyProvider } from "xum/browser/contexts/PolicyContext";
import { AgentProvider } from "xum/browser/contexts/AgentContext";
import { BashCollapsedSummaryModeProvider } from "xum/browser/features/Tools/BashCollapsedSummaryModeContext";
import {
  BackgroundBashProvider,
  useBackgroundBashError,
} from "xum/browser/contexts/BackgroundBashContext";
import { BackgroundProcessesBanner } from "xum/browser/components/BackgroundProcessesBanner/BackgroundProcessesBanner";
import { PopoverError } from "xum/browser/components/PopoverError/PopoverError";
import { useBackgroundBashStoreRaw } from "xum/browser/stores/BackgroundBashStore";
import { mergeConsecutiveStreamErrors } from "xum/browser/utils/messages/messageUtils";
import { seedWorkspaceLocalStorageFromBackend } from "xum/browser/contexts/WorkspaceContext";
import { WorkspaceModeAISync } from "xum/browser/components/WorkspaceModeAISync/WorkspaceModeAISync";
import { resolvePersistedAgentId } from "xum/common/utils/agentIds";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "xum/browser/components/Tooltip/Tooltip";
import { Button } from "xum/browser/components/Button/Button";
import {
  allowsEscapeToInterruptStream,
  formatKeybind,
  isDialogOpen,
  isEditableElement,
  matchesKeybind,
  KEYBINDS,
} from "xum/browser/utils/ui/keybinds";
import { readPersistedState } from "xum/browser/hooks/usePersistedState";
import { getAppConfigStore } from "xum/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "xum/browser/stores/ProvidersConfigStore";
import { VIM_ENABLED_KEY } from "xum/common/constants/storage";
import { useAutoScroll } from "xum/browser/hooks/useAutoScroll";
import { useTranscriptDensity } from "xum/browser/hooks/useTranscriptDensity";
import {
  TranscriptBundleRows,
  useTranscriptBundles,
} from "xum/browser/components/ChatPane/TranscriptBundles";
import {
  findTranscriptMessageElement,
  getTranscriptRowProps,
  useTranscriptRowDerivations,
  useUserMessageNavigation,
} from "xum/browser/components/ChatPane/transcriptRowDerivations";
import { BashOutputCollapsedIndicator } from "xum/browser/features/Tools/BashOutputCollapsedIndicator";
import { applyWorkspaceChatEventToAggregator } from "xum/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";
import { LiveBashOutputSourceContext } from "xum/browser/stores/liveBashOutputSource";
import { HeldInput } from "xum/browser/features/Messages/HeldInput";
import { RetryBarrierContent } from "xum/browser/features/Messages/ChatBarrier/RetryBarrier";
import { InterruptedBarrier } from "xum/browser/features/Messages/ChatBarrier/InterruptedBarrier";
import {
  getRetryBarrierDerivation,
  type RetryBarrierDerivation,
} from "xum/browser/components/ChatPane/retryBarrierDerivation";
import { useResumeStream } from "xum/browser/hooks/useResumeStream";
import {
  isAutoRetryStatusEvent,
  type AutoRetryStatus,
} from "xum/browser/utils/messages/autoRetryStatus";

import type {
  ExtensionToWebviewMessage,
  UiConnectionStatus,
  UiWorkspace,
  UiWorkspaceAiState,
} from "./protocol";
import { WorkspacePicker } from "./WorkspacePicker";
import { ChatComposer } from "./ChatComposer";
import { VSCODE_CHAT_UI_SUPPORT } from "./chatUiCapabilities";
import { getAggregatorStreamState, VscodeStreamingBarrier } from "./StreamingBarrier";
import { DisplayedMessageRenderer } from "./DisplayedMessageRenderer";
import { CHAT_BUFFER_LIMITS } from "./config";
import { createVscodeOrpcLink } from "./createVscodeOrpcLink";
import { WebviewLiveBashOutput } from "./liveBashOutput";
import { WebviewTranscriptBarrier } from "./transcriptBarrier";
import { seedWebviewPreferences } from "./seedPreferences";
import type { VscodeBridge } from "./vscodeBridge";

// Shared chat components need these providers; the webview has no desktop shell to supply them
// (#4711). PolicyProvider falls back to "no policy" because the bridge rejects policy.* calls (the
// backend still enforces policy on send). A single AgentProvider covers both the transcript
// (ProposePlanToolCall) and the composer.
/** Identifies the server connection: switching servers keeps mode "api" but changes the URL. */
function getApiConnectionKey(status: UiConnectionStatus | null): string | null {
  return status?.mode === "api" ? (status.baseUrl ?? "api") : null;
}

function WebviewChatProviders(props: {
  workspaceId: string | undefined;
  workspaceAi: UiWorkspaceAiState | undefined;
  selectedWorkspaceId: string | null;
  /** The server connection; background bash state and errors never outlive it. */
  apiConnectionKey: string | null;
  children: ReactNode;
}) {
  return (
    <PolicyProvider>
      <AgentProvider
        workspaceId={props.workspaceId}
        workspaceMetaFallback={
          props.workspaceAi
            ? {
                parentWorkspaceId: props.workspaceAi.parentWorkspaceId,
                // Same identity resolution as the seeding: a child task's creation-time agentType
                // wins over an agentId restamped by a recovery send.
                agentId: resolvePersistedAgentId(props.workspaceAi, "") || undefined,
              }
            : undefined
        }
      >
        {/* Desktop's per-agent settings sync: switching agents restores that agent's cached
            model/thinking/reasoning (seeded from the workspace), exactly as in AIView. */}
        {props.workspaceId ? <WorkspaceModeAISync workspaceId={props.workspaceId} /> : null}
        {/* Re-renders bash tool headers when the seeded collapsed-summary mode arrives (#4972). */}
        <BashCollapsedSummaryModeProvider>
          <TooltipProvider>
            {/* Covers the transcript's bash cards and the dock's background processes strip
                (#5092). Without a selection nothing reads it: both render only for a selected
                workspace. */}
            {/* Keyed by the server connection: a server switch remounts the provider (and the
                strip) before paint, so a late action failure from the previous server can never
                show over the new one, even for a workspace ID both servers share. */}
            <BackgroundBashProvider
              key={props.apiConnectionKey ?? "no-connection"}
              workspaceId={props.selectedWorkspaceId ?? ""}
            >
              {props.children}
              <BackgroundBashErrorPopover workspaceId={props.selectedWorkspaceId} />
            </BackgroundBashProvider>
          </TooltipProvider>
        </BashCollapsedSummaryModeProvider>
      </AgentProvider>
    </PolicyProvider>
  );
}

interface Notice {
  id: string;
  level: "info" | "error";
  message: string;
}

const VSCODE_CHAT_HOST_CONTEXT_VALUE = {
  uiSupport: VSCODE_CHAT_UI_SUPPORT,
  actions: {},
} as const;

// Bottom-stick uses native CSS scroll anchoring, as in the main app's ChatPane (see
// useAutoScroll): while locked, the transcript content opts out of anchoring so the 0-height
// bottom sentinel is the only anchor candidate, and the browser keeps it pinned as rows append.
// When released, rows are candidates again, so the reading position survives appends.
const TRANSCRIPT_CONTENT_NO_ANCHOR_STYLE = { overflowAnchor: "none" } as const;
const TRANSCRIPT_BOTTOM_SENTINEL_STYLE = { overflowAnchor: "auto" } as const;

const EMPTY_DISPLAYED_ROWS: { messages: DisplayedMessage[]; rendered: DisplayedMessage[] } = {
  messages: [],
  rendered: [],
};

// Terminate failures of the background processes strip, shown like desktop WorkspaceShell does.
// Cleared on a workspace switch, as desktop ChatPane does, so it never shows under another chat.
function BackgroundBashErrorPopover(props: { workspaceId: string | null }): JSX.Element {
  const { error, clearError } = useBackgroundBashError();
  // The error belongs to the workspace it was raised in. Hide it during the render that switches
  // workspaces (a post-render clear alone would paint it over the new chat for a frame), then
  // clear it and follow the new workspace.
  const [errorWorkspaceId, setErrorWorkspaceId] = useState(props.workspaceId);
  const switched = errorWorkspaceId !== props.workspaceId;
  useEffect(() => {
    if (!switched) {
      return;
    }
    clearError();
    setErrorWorkspaceId(props.workspaceId);
  }, [clearError, props.workspaceId, switched]);
  return (
    <PopoverError
      error={switched ? null : error}
      prefix="Failed to terminate:"
      onDismiss={clearError}
    />
  );
}

const MAX_BUFFERED_HISTORICAL_MESSAGES = CHAT_BUFFER_LIMITS.MAX_HISTORICAL_MESSAGES;
const MAX_BUFFERED_STREAM_EVENTS = CHAT_BUFFER_LIMITS.MAX_STREAM_EVENTS;

interface ChatReplayState {
  workspaceId: string;
  caughtUp: boolean;
  historicalMessages: Extract<WorkspaceChatMessage, { type: "message" }>[];
  pendingStreamEvents: WorkspaceChatMessage[];
  didWarnBufferOverflow: boolean;
}

function createChatReplayState(workspaceId: string): ChatReplayState {
  return {
    workspaceId,
    caughtUp: false,
    historicalMessages: [],
    pendingStreamEvents: [],
    didWarnBufferOverflow: false,
  };
}

function shouldBufferUntilCaughtUp(event: WorkspaceChatMessage): boolean {
  switch (event.type) {
    case "stream-start":
    case "stream-delta":
    case "stream-end":
    case "stream-abort":
    // The backend replays a turn's terminal error before caught-up; applied early, it would be
    // dropped when history loads (as WorkspaceStore buffers it too).
    case "stream-error":
    case "tool-call-start":
    case "tool-call-delta":
    case "tool-call-end":
    case "reasoning-delta":
    case "reasoning-end":
    case "usage-delta":
    case "session-usage-delta":
    case "init-start":
    case "init-output":
    case "init-end":
      return true;
    default:
      return false;
  }
}
function pickWorkspaceCreatedAt(workspace: UiWorkspace | undefined): string {
  // StreamingMessageAggregator expects a timestamp string (backend contract: always present).
  // Default to epoch to preserve stable ordering if we ever get legacy workspace metadata.
  return workspace?.createdAt ?? new Date(0).toISOString();
}

export function App(props: { bridge: VscodeBridge }): JSX.Element {
  const bridge = props.bridge;

  const apiClient = useMemo(() => {
    const link = createVscodeOrpcLink(bridge);
    return createClient(link);
  }, [bridge]);

  // The API context wraps the whole webview app: its body calls shared hooks that read it
  // (useResumeStream for the interrupted divider and its keybind).
  return (
    <APIProvider client={apiClient}>
      <WebviewApp bridge={bridge} apiClient={apiClient} />
    </APIProvider>
  );
}

function WebviewApp(props: { bridge: VscodeBridge; apiClient: APIClient }): JSX.Element {
  const bridge = props.bridge;
  const apiClient = props.apiClient;

  const [connectionStatus, setConnectionStatus] = useState<UiConnectionStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<UiWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  // Mirrors the replay's caught-up flag for rendering: the composer stays disabled until the
  // history replay completes, so a send never acts on a partial transcript.
  const [transcriptCaughtUp, setTranscriptCaughtUp] = useState(false);

  const activeWorkspaceIdRef = useRef<string | null>(null);
  const connectionKeyRef = useRef<string | null>(null);
  activeWorkspaceIdRef.current = selectedWorkspaceId;

  const chatReplayStateRef = useRef<ChatReplayState | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const aggregatorRef = useRef<StreamingMessageAggregator | null>(null);
  // Running bash cards read their live output here; the webview does not feed WorkspaceStore.
  const [liveBashOutput] = useState(() => new WebviewLiveBashOutput());
  // The shared plan card's transcript barrier (#4942); the webview does not feed WorkspaceStore.
  const [chatHostContextValue] = useState(() => ({
    ...VSCODE_CHAT_HOST_CONTEXT_VALUE,
    transcriptBarrier: new WebviewTranscriptBarrier(),
  }));
  const transcriptBarrier = chatHostContextValue.transcriptBarrier;
  // The backend's held inputs for the selected workspace (#4771): full list, replayed on each
  // subscription while non-empty.
  const [heldInputs, setHeldInputs] = useState<readonly HeldInputData[]>([]);
  // Desktop ChatPane renders consecutive identical stream errors as one row with a count (#5092).
  // The merged rows are derived once per new aggregator snapshot (every flush re-renders, and the
  // snapshot keeps its identity while unchanged) and kept beside the raw rows: the retry
  // derivation's candidates and the resume read the raw rows, as ChatPane passes
  // workspaceState.messages.
  const [displayedRows, setDisplayedRows] = useState(EMPTY_DISPLAYED_ROWS);
  const setDisplayedMessages = (messages: DisplayedMessage[]) =>
    setDisplayedRows((previous) =>
      previous.messages === messages
        ? previous
        : { messages, rendered: mergeConsecutiveStreamErrors(messages) }
    );
  const displayedMessages = displayedRows.messages;
  const renderedMessages = displayedRows.rendered;
  // Armed background bash monitors of the selected workspace, forwarded by the host (#4971).
  const [activeBashMonitorCount, setActiveBashMonitorCount] = useState(0);
  // The backend's auto-retry status, read-only (the webview never toggles or stops auto-retry):
  // tracked from the same auto-retry-* chat events WorkspaceStore uses, and cleared by
  // stream-start/stream-end and by every reset (new selection, chatReset, new replay). While a
  // retry is scheduled, the barrier shows the countdown instead of Retry, so a manual Retry never
  // races the armed backoff. Stored with its workspace so it never reaches another workspace.
  const [autoRetryState, setAutoRetryState] = useState<{
    workspaceId: string;
    status: AutoRetryStatus;
  } | null>(null);
  const workspacesRef = useRef<UiWorkspace[]>([]);
  const backgroundBashStore = useBackgroundBashStoreRaw();

  // Every flush re-renders, even when the displayed messages are unchanged: the turn-status barrier
  // reads aggregator state that has no transcript row (stream lifecycle, startup breadcrumbs) (#4971).
  const [, bumpAggregatorRevision] = useReducer((revision: number) => revision + 1, 0);
  const scheduledRenderRef = useRef<{ kind: "raf" | "timeout"; id: number } | null>(null);
  const isRenderScheduledRef = useRef(false);

  const cancelScheduledRender = () => {
    const handle = scheduledRenderRef.current;
    if (!handle) {
      return;
    }

    if (handle.kind === "raf") {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle.id);
      }
    } else {
      clearTimeout(handle.id);
    }

    scheduledRenderRef.current = null;
    isRenderScheduledRef.current = false;
  };

  const flushDisplayedMessages = () => {
    cancelScheduledRender();

    const aggregator = aggregatorRef.current;
    if (!aggregator) {
      return;
    }

    setDisplayedMessages(aggregator.getDisplayedMessages());
    bumpAggregatorRevision();
  };

  const flushDisplayedMessagesRef = useRef(flushDisplayedMessages);
  flushDisplayedMessagesRef.current = flushDisplayedMessages;
  // Row callbacks for the shared MessageRenderer: they act on this webview's aggregator, since
  // WorkspaceStore has none here. Created once so MessageRenderer's React.memo can skip unchanged
  // rows (vscode/ is not React-Compiler compiled). plan-display rows only come from the desktop
  // /plan command, so the webview cannot produce them yet; Close still works if one arrives (#4971).
  const [messageRowActions] = useState(() => ({
    closeEphemeral: (historyId: string) => {
      aggregatorRef.current?.removeMessage(historyId);
      flushDisplayedMessagesRef.current();
    },
    showAllHistory: () => {
      aggregatorRef.current?.setShowAllMessages(true);
      flushDisplayedMessagesRef.current();
    },
  }));
  const scheduleDisplayedMessages = () => {
    if (isRenderScheduledRef.current) {
      return;
    }

    isRenderScheduledRef.current = true;

    const run = () => {
      isRenderScheduledRef.current = false;
      scheduledRenderRef.current = null;

      const aggregator = aggregatorRef.current;
      if (!aggregator) {
        return;
      }

      setDisplayedMessages(aggregator.getDisplayedMessages());
      bumpAggregatorRevision();
    };

    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(run);
      scheduledRenderRef.current = { kind: "raf", id };
      return;
    }

    const id = window.setTimeout(run, 0);
    scheduledRenderRef.current = { kind: "timeout", id };
  };

  // useAutoScroll releases the bottom lock only for scrolls preceded by user intent (wheel,
  // pointer, keyboard, touch), so those handlers must be on the scroll container.
  const {
    contentRef,
    sentinelRef,
    autoScroll,
    disableAutoScroll,
    handleScroll,
    jumpToBottom,
    markUserScrollIntent,
    handleScrollContainerWheel,
    handleScrollContainerMouseDown,
    handleScrollContainerMouseMove,
    handleScrollContainerMouseUp,
    handleScrollContainerKeyDown,
  } = useAutoScroll();

  const jumpToBottomRef = useRef(jumpToBottom);
  jumpToBottomRef.current = jumpToBottom;

  // Keep a stable monotonic counter for notice IDs.
  const noticeSeqRef = useRef(0);

  const pushNotice = (notice: { level: Notice["level"]; message: string }) => {
    noticeSeqRef.current += 1;
    const id = `notice-${noticeSeqRef.current}`;
    setNotices((prev) => [...prev, { id, level: notice.level, message: notice.message }]);
  };

  const pushNoticeRef = useRef(pushNotice);
  pushNoticeRef.current = pushNotice;

  const canChat = Boolean(connectionStatus?.mode === "api" && selectedWorkspaceId);
  const apiConnectionKey = getApiConnectionKey(connectionStatus);

  // #4766: the model list, model routing and thinking floors read the shared providers and app
  // config stores, which the desktop connects in AppLoader. Connect them while the host has a
  // server connection (it rejects calls in file mode), and reconnect them for each server, so a
  // recovery or a switch to another server fetches them again. The host
  // redacts both results (see redactWebviewOrpcResult).
  // The app config snapshot also seeds the backend preferences shared components read from
  // localStorage (#4972, #4962), on connect and on every config change.
  useEffect(() => {
    if (apiConnectionKey === null) {
      return;
    }
    const providersConfigStore = getProvidersConfigStore();
    const appConfigStore = getAppConfigStore();
    // Until this server's config loads, the seeded keys may hold another server's values: the
    // store keeps the previous server's snapshot, and localStorage can outlive the previous webview
    // session. Clear them first so a send in that window never uses another server's agent defaults.
    seedWebviewPreferences(null);
    const unsubscribeSeed = appConfigStore.subscribe(() => {
      seedWebviewPreferences(appConfigStore.getSnapshot());
    });
    providersConfigStore.setClient(apiClient);
    appConfigStore.setClient(apiClient);
    // The background processes strip and the bash tool cards' live process status (#5092). A
    // server switch already dropped the previous server's cached rows (connectionStatus handler).
    backgroundBashStore.setClient(apiClient);
    return () => {
      unsubscribeSeed();
      providersConfigStore.setClient(null);
      appConfigStore.setClient(null);
      backgroundBashStore.setClient(null);
    };
  }, [apiClient, apiConnectionKey, backgroundBashStore]);

  useEffect(() => {
    const unsubscribe = bridge.onMessage((raw) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) {
        return;
      }

      const type = (raw as { type?: unknown }).type;
      if (typeof type !== "string") {
        return;
      }

      const msg = raw as ExtensionToWebviewMessage;

      switch (msg.type) {
        case "connectionStatus": {
          transcriptBarrier.setConnected(msg.status.mode === "api");
          const nextConnectionKey = getApiConnectionKey(msg.status);
          if (nextConnectionKey !== connectionKeyRef.current) {
            connectionKeyRef.current = nextConnectionKey;
            // Workspace IDs can repeat across servers. Drop the previous server's background bash
            // subscriptions and cached rows now, before the render that shows the new connection,
            // so it never paints them; the connection effect installs the new server's client.
            backgroundBashStore.setClient(null);
            backgroundBashStore.clearCachedState();
          }
          setConnectionStatus(msg.status);
          return;
        }
        case "workspaces":
          // Seed each workspace's persisted agent/AI settings into the composer's storage, with the
          // desktop's own rules (#4738): a main workspace is snapshotted once per webview load, a
          // sub-agent workspace follows its backend settings.
          for (const workspace of msg.workspaces) {
            if (!workspace.ai) continue;
            const previousAi = workspacesRef.current.find((w) => w.id === workspace.id)?.ai;
            seedWorkspaceLocalStorageFromBackend(
              { id: workspace.id, ...workspace.ai },
              previousAi ? { id: workspace.id, ...previousAi } : undefined
            );
          }
          workspacesRef.current = msg.workspaces;
          setWorkspaces(msg.workspaces);
          return;
        case "setSelectedWorkspace": {
          // The host re-sends the current selection (e.g. clicking the selected row). With a
          // live subscription it sends no chatReset or replay, so clearing here would leave the
          // transcript, live output and held inputs blank (#4949). If it has to resubscribe, its
          // chatReset resets everything anyway, so an unchanged selection keeps all state.
          if (msg.workspaceId === activeWorkspaceIdRef.current) {
            return;
          }
          activeWorkspaceIdRef.current = msg.workspaceId;
          setSelectedWorkspaceId(msg.workspaceId);

          // The webview retains React state when hidden, so always clear the transcript when
          // switching workspaces (avoids showing stale messages for a new selection).
          cancelScheduledRender();
          aggregatorRef.current = null;
          liveBashOutput.reset(msg.workspaceId);
          setHeldInputs([]);
          setAutoRetryState(null);
          setActiveBashMonitorCount(0);
          chatReplayStateRef.current = msg.workspaceId
            ? createChatReplayState(msg.workspaceId)
            : null;
          transcriptBarrier.reset(msg.workspaceId);
          setTranscriptCaughtUp(false);
          setDisplayedMessages([]);
          setNotices([]);

          return;
        }
        case "chatReset": {
          const activeWorkspaceId = activeWorkspaceIdRef.current;
          if (activeWorkspaceId && activeWorkspaceId !== msg.workspaceId) {
            return;
          }

          activeWorkspaceIdRef.current = msg.workspaceId;
          cancelScheduledRender();
          const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
          const createdAt = pickWorkspaceCreatedAt(workspace);
          aggregatorRef.current = new StreamingMessageAggregator(
            createdAt,
            msg.workspaceId,
            workspace?.unarchivedAt
          );
          liveBashOutput.reset(msg.workspaceId);
          setHeldInputs([]);
          setAutoRetryState(null);
          // The monitor count is kept: a resubscribe to the same workspace posts a fresh count, but
          // if the host cannot read it, the last one is better than hiding an armed monitor.
          chatReplayStateRef.current = createChatReplayState(msg.workspaceId);
          transcriptBarrier.reset(msg.workspaceId);
          setTranscriptCaughtUp(false);
          setDisplayedMessages([]);
          setNotices([]);
          jumpToBottomRef.current();
          return;
        }
        case "chatEvent": {
          const activeWorkspaceId = activeWorkspaceIdRef.current;
          if (activeWorkspaceId && activeWorkspaceId !== msg.workspaceId) {
            return;
          }

          try {
            if (!aggregatorRef.current) {
              const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
              const createdAt = pickWorkspaceCreatedAt(workspace);
              aggregatorRef.current = new StreamingMessageAggregator(
                createdAt,
                msg.workspaceId,
                workspace?.unarchivedAt
              );
            }

            const aggregator = aggregatorRef.current;
            if (!aggregator) {
              return;
            }

            let replayState = chatReplayStateRef.current;
            if (!replayState || replayState.workspaceId !== msg.workspaceId) {
              replayState = createChatReplayState(msg.workspaceId);
              chatReplayStateRef.current = replayState;
              liveBashOutput.reset(msg.workspaceId);
              setHeldInputs([]);
              setAutoRetryState(null);
              transcriptBarrier.reset(msg.workspaceId);
              setTranscriptCaughtUp(false);
            }

            // Auto-retry status transitions, applied in stream order (replayed events from the
            // flush loop, live ones below), so a buffered stream-start never clears a later status.
            const applyAutoRetryTransition = (chatEvent: WorkspaceChatMessage) => {
              if (isAutoRetryStatusEvent(chatEvent)) {
                setAutoRetryState({ workspaceId: msg.workspaceId, status: chatEvent });
              } else if (chatEvent.type === "stream-start" || chatEvent.type === "stream-end") {
                setAutoRetryState(null);
              }
            };

            const flushReplayBuffer = () => {
              const hasActiveStream = replayState.pendingStreamEvents.some(
                (bufferedEvent) => bufferedEvent.type === "stream-start"
              );

              if (replayState.historicalMessages.length > 0) {
                aggregator.loadHistoricalMessages(replayState.historicalMessages, hasActiveStream);
                replayState.historicalMessages.length = 0;
              }

              for (const bufferedEvent of replayState.pendingStreamEvents) {
                applyAutoRetryTransition(bufferedEvent);
                applyWorkspaceChatEventToAggregator(aggregator, bufferedEvent);
              }
              replayState.pendingStreamEvents.length = 0;

              replayState.caughtUp = true;
              // A forced catch-up (buffer overflow) showed a partial transcript; the barrier stays
              // closed for the rest of this replay, even when the real caught-up follows.
              transcriptBarrier.markCaughtUp(msg.workspaceId, !replayState.didWarnBufferOverflow);
              setTranscriptCaughtUp(true);
              flushDisplayedMessages();
            };

            const forceCatchUp = () => {
              if (
                replayState.caughtUp ||
                (replayState.historicalMessages.length <= MAX_BUFFERED_HISTORICAL_MESSAGES &&
                  replayState.pendingStreamEvents.length <= MAX_BUFFERED_STREAM_EVENTS)
              ) {
                return;
              }

              if (!replayState.didWarnBufferOverflow) {
                replayState.didWarnBufferOverflow = true;

                bridge.debugLog("chat replay buffer overflow; forcing caught-up", {
                  workspaceId: replayState.workspaceId,
                  historicalMessages: replayState.historicalMessages.length,
                  pendingStreamEvents: replayState.pendingStreamEvents.length,
                });

                pushNotice({
                  level: "error",
                  message:
                    "Xum chat did not finish loading (missing caught-up). Showing a partial transcript; try Refresh if messages look incomplete.",
                });
              }

              flushReplayBuffer();
            };
            const event = msg.event;
            // The aggregator ignores bash-output; the live output feed takes it (and drops a
            // tool's buffer once its tool-call-end carries the final output).
            liveBashOutput.apply(msg.workspaceId, event);

            // Held inputs render as banners with Send/Discard (#4771). The webview never applies
            // restore-to-input to its composer, so it never acknowledges a restore's held inputs
            // either: the backend keeps them and this list shows them.
            if (event.type === "held-inputs-changed") {
              setHeldInputs(event.heldInputs);
              return;
            }

            if (event.type === "caught-up") {
              flushReplayBuffer();
              return;
            }

            if (!replayState.caughtUp) {
              if (event.type === "message") {
                replayState.historicalMessages.push(event);
                forceCatchUp();
                return;
              }

              if (shouldBufferUntilCaughtUp(event) || isAutoRetryStatusEvent(event)) {
                replayState.pendingStreamEvents.push(event);
                forceCatchUp();
                return;
              }
            }

            applyAutoRetryTransition(event);
            const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

            if (hint === "ignored") {
              return;
            }

            if (hint === "throttled") {
              scheduleDisplayedMessages();
              return;
            }

            flushDisplayedMessages();
          } catch (error) {
            const message = `Chat event handling error: ${error instanceof Error ? error.message : String(error)}`;
            bridge.debugLog("chatEvent processing failed", {
              error: String(error),
              event: msg.event,
            });
            pushNotice({ level: "error", message });
          }

          return;
        }
        case "workspaceActivity":
          if (msg.workspaceId === activeWorkspaceIdRef.current) {
            setActiveBashMonitorCount(msg.activeBashMonitorCount);
          }
          return;
        case "uiNotice": {
          pushNotice({ level: msg.level, message: msg.message });
          return;
        }
        case "debugProbe":
          bridge.debugLog("debugProbe", msg);
          return;

        case "orpcResponse":
        case "orpcStreamData":
        case "orpcStreamEnd":
        case "orpcStreamError":
          // ORPC messages are handled by the ORPC link.
          return;

        default: {
          const _exhaustive: never = msg;
          bridge.debugLog("unhandled extension message", { raw, message: _exhaustive });
          return;
        }
      }
    });

    bridge.postMessage({ type: "ready" });

    return () => {
      cancelScheduledRender();
      unsubscribe();
    };
    // Only depend on the bridge instance; other state is read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // The one user-Stop path for Esc and the barrier's Stop button (#4971), with desktop stopStream's
  // options: owed monitor output is dismissed instead of waking the agent, auto-retry is turned off,
  // and a stopped compaction drops its partial summary. Stop also shows while a turn is starting,
  // when there is no active stream to mark yet: then it only sends the request.
  const interruptStream = (options: { abandonPartial: boolean }) => {
    if (!selectedWorkspaceId) {
      return;
    }
    const aggregator = aggregatorRef.current;
    if (aggregator?.getActiveStreamMessageId()) {
      aggregator.setInterrupting();
      flushDisplayedMessagesRef.current();
    }

    const reportFailure = (error: string) => {
      bridge.debugLog("interruptStream failed", { error });
      pushNoticeRef.current({ level: "error", message: `Failed to interrupt stream. (${error})` });
    };
    apiClient.workspace
      .interruptStream({
        workspaceId: selectedWorkspaceId,
        options: {
          ...(options.abandonPartial ? { abandonPartial: true } : {}),
          disableAutoRetry: true,
          retireBashMonitorAttention: true,
        },
      })
      .then((result) => {
        if (!result.success) reportFailure(result.error);
      })
      .catch((error) => reportFailure(error instanceof Error ? error.message : String(error)));
  };
  const interruptStreamRef = useRef(interruptStream);
  interruptStreamRef.current = interruptStream;
  // The Shift+R listener reads the latest retry derivation and resumes through these refs, which
  // are updated where both are computed below.
  const retryBarrierRef = useRef<RetryBarrierDerivation | null>(null);
  const resumeInterruptedStreamRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!canChat || !selectedWorkspaceId) {
        return;
      }

      const aggregator = aggregatorRef.current;
      if (!aggregator) {
        return;
      }

      const vimEnabled = readPersistedState(VIM_ENABLED_KEY, false);
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;

      if (!matchesKeybind(e, interruptKeybind)) {
        return;
      }

      // As on desktop, Escape in a text field interrupts only where the field opts in (the chat
      // input); Ctrl+C in Vim mode always does.
      if (
        interruptKeybind === KEYBINDS.INTERRUPT_STREAM_NORMAL &&
        isEditableElement(e.target) &&
        !allowsEscapeToInterruptStream(e.target)
      ) {
        return;
      }

      // ask_user_question is a special waiting state: don't interrupt it with Esc/Ctrl+C.
      // Users can still respond by typing and sending a message.
      if (aggregator.hasAwaitingUserQuestion()) {
        return;
      }

      // A starting turn (before stream-start) shows Stop and its Esc chip too, so Esc must reach it.
      const isStarting =
        aggregator.getPendingStreamStartTime() !== null ||
        aggregator.getStreamLifecycle()?.phase === "preparing";
      if (!aggregator.getActiveStreamMessageId() && !isStarting) {
        return;
      }

      e.preventDefault();
      interruptStreamRef.current({ abandonPartial: aggregator.isCompacting() });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canChat, selectedWorkspaceId]);

  // Transcript-scoped Shift+G and Shift+R, as in desktop useAIViewKeybinds: capture phase, and
  // never while typing (the composer still receives a capital G/R) or while a modal owns the
  // keyboard. Shift+R resumes only when the interrupted divider on the tail offers resume.
  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }
    const handleKeyDownCapture = (e: KeyboardEvent) => {
      if (isDialogOpen() || isEditableElement(e.target)) {
        return;
      }
      if (
        matchesKeybind(e, KEYBINDS.RESUME_STREAM) &&
        retryBarrierRef.current?.interruptedTailResumable
      ) {
        e.preventDefault();
        resumeInterruptedStreamRef.current();
        return;
      }
      if (!matchesKeybind(e, KEYBINDS.JUMP_TO_BOTTOM)) {
        return;
      }
      e.preventDefault();
      jumpToBottomRef.current();
    };
    window.addEventListener("keydown", handleKeyDownCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
  }, [selectedWorkspaceId]);

  const requestRefreshWorkspaces = () => {
    bridge.postMessage({ type: "refreshWorkspaces" });
  };

  const onOpenWorkspace = () => {
    if (!selectedWorkspaceId) {
      return;
    }

    bridge.postMessage({ type: "openWorkspace", workspaceId: selectedWorkspaceId });
  };

  // Only the latest propose_plan card fetches its plan from disk (current results omit the
  // content), matching ChatPane.
  const selectedWorkspace = selectedWorkspaceId
    ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
    : undefined;
  // Agent state is scoped to the selected workspace only once the extension has listed it and a
  // server connection exists (see WebviewChatProviders below). Unscoped, AgentProvider writes the
  // webview's global agent key, so the composer's agent toggle is disabled then (#4820).
  const agentScopeWorkspaceId =
    selectedWorkspace && connectionStatus?.mode === "api" ? selectedWorkspace.id : undefined;

  let latestProposePlanId: string | undefined;
  for (let i = displayedMessages.length - 1; i >= 0; i--) {
    const msg = displayedMessages[i];
    if (msg.type === "tool" && msg.toolName === "propose_plan") {
      latestProposePlanId = msg.id;
      break;
    }
  }

  // Work bundles (hyper density) and operational bundles collapse rows as on desktop (#4979).
  const [transcriptDensity] = useTranscriptDensity();
  const streamState = aggregatorRef.current
    ? getAggregatorStreamState(aggregatorRef.current)
    : undefined;
  const transcriptBundles = useTranscriptBundles({
    workspaceId: selectedWorkspaceId ?? "",
    messages: renderedMessages,
    transcriptDensity,
    isTurnActive: streamState ? streamState.isStreamStarting || streamState.canInterrupt : false,
  });
  // Retry barrier and interrupted dividers, with desktop ChatPane's shared derivation fed from this
  // webview's aggregator. Its rows are never deferred, so renderedMessages are the merged rows on
  // screen and messages the raw ones, as in ChatPane.
  const aggregator = aggregatorRef.current;
  const autoRetryStatus =
    autoRetryState?.workspaceId === selectedWorkspaceId ? autoRetryState.status : null;
  const retryBarrier =
    selectedWorkspaceId && aggregator && streamState
      ? getRetryBarrierDerivation({
          messages: displayedMessages,
          renderedMessages,
          pendingStreamStartTime: aggregator.getPendingStreamStartTime(),
          runtimeStatus: aggregator.getRuntimeStatus(),
          lastAbortReason: aggregator.getLastAbortReason(),
          // Read-only: an active backend retry hides the dividers' resume, as on desktop.
          autoRetryStatus,
          isHydratingTranscript: !transcriptCaughtUp,
          isTurnActive: streamState.isStreamStarting || streamState.canInterrupt,
          // Without a server connection (file mode) every bridged action is refused, so the
          // interrupted divider offers no resume (as a read-only desktop transcript) and the
          // retry barrier is not mounted below.
          transcriptOnly: !canChat,
        })
      : null;
  // Retry and resume send as the composer does: a sub-agent's locked agent, not a stored pick
  // (#4738). Same resolution as WebviewChatProviders' workspaceMetaFallback.
  const lockedAgentId =
    selectedWorkspace?.ai?.parentWorkspaceId != null
      ? resolvePersistedAgentId(selectedWorkspace.ai, "") || undefined
      : undefined;
  // Shared by the divider's resume button, Shift+R and the retry barrier's Retry: the webview
  // retries through the same resume path instead of toggling auto-retry.
  const { resume: resumeInterruptedStreamAsync, error: resumeInterruptedError } = useResumeStream(
    selectedWorkspaceId ?? "",
    retryBarrier?.lastRetryCandidateMessage?.id,
    displayedMessages,
    lockedAgentId
  );
  const resumeInterruptedStream = () => void resumeInterruptedStreamAsync();
  retryBarrierRef.current = retryBarrier;
  resumeInterruptedStreamRef.current = resumeInterruptedStream;

  // bash_output grouping, task report linking and prompt navigation, as in ChatPane (#5002).
  const transcriptRowDerivations = useTranscriptRowDerivations({
    workspaceId: selectedWorkspaceId ?? "",
    messages: renderedMessages,
  });
  // Stable so the per-prompt navigation objects keep their identity across flushes. Every row is
  // mounted (no bounded reveal), so the target can be scrolled to directly; disabling auto-scroll
  // first keeps streaming content from pulling the view back to the tail.
  const handleNavigateToMessage = useCallback(
    (historyId: string) => {
      disableAutoScroll();
      const scrollContainer = contentRef.current;
      const target = scrollContainer
        ? findTranscriptMessageElement(scrollContainer, historyId)
        : undefined;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [contentRef, disableAutoScroll]
  );
  const userMessageNavigationByHistoryId = useUserMessageNavigation({
    messages: renderedMessages,
    onNavigateToMessage: handleNavigateToMessage,
  });

  return (
    // Shared providers (SettingsProvider, settings links in the model selector and tool cards) need
    // a router. The webview renders no routes, so an embedded in-memory router is enough: those
    // navigations become no-ops instead of crashing the mount or rewriting the webview URL.
    <RouterProvider embedded>
      <ChatHostContextProvider value={chatHostContextValue}>
        <SettingsProvider>
          <ProviderOptionsProvider>
            <ThemeProvider forcedTheme="dark">
              <WebviewChatProviders
                // Scope agent state (and its agents.list lookup) to the selected workspace only
                // once the extension has listed it: on a fresh extension host the restored
                // selection arrives before the list, and the host rejects lookups for workspaces
                // it has not sent (#4751). It also requires a server connection: file mode lists
                // workspaces but the host rejects agents.list there, and a recovery that keeps
                // the same selection must change this prop so the lookup runs again (#4797).
                workspaceId={agentScopeWorkspaceId}
                workspaceAi={selectedWorkspace?.ai}
                selectedWorkspaceId={selectedWorkspaceId}
                apiConnectionKey={apiConnectionKey}
              >
                <div className="flex h-screen flex-col">
                  <div className="border-b border-border bg-background-secondary p-3">
                    <div className="flex items-center gap-2">
                      <WorkspacePicker
                        workspaces={workspaces}
                        selectedWorkspaceId={selectedWorkspaceId}
                        onSelectWorkspace={(workspaceId) => {
                          bridge.postMessage({ type: "selectWorkspace", workspaceId });
                        }}
                        onRequestRefresh={requestRefreshWorkspaces}
                      />

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 items-center rounded border border-border-light bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                            aria-label="Preview feature"
                          >
                            Preview
                          </span>
                        </TooltipTrigger>
                        <TooltipContent align="center">
                          Preview feature — under active development; may contain bugs.
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={onOpenWorkspace}
                            disabled={!selectedWorkspaceId}
                            aria-label="Open workspace"
                            className="text-muted hover:text-foreground h-8 w-8 shrink-0"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent align="center">Open workspace</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  <div
                    ref={contentRef}
                    className="flex-1 overflow-y-auto p-3"
                    onScroll={handleScroll}
                    onWheel={handleScrollContainerWheel}
                    onMouseDown={handleScrollContainerMouseDown}
                    onMouseMove={handleScrollContainerMouseMove}
                    onMouseUp={handleScrollContainerMouseUp}
                    onKeyDown={handleScrollContainerKeyDown}
                    onTouchMove={markUserScrollIntent}
                  >
                    <div style={autoScroll ? TRANSCRIPT_CONTENT_NO_ANCHOR_STYLE : undefined}>
                      {selectedWorkspaceId ? (
                        <LiveBashOutputSourceContext.Provider value={liveBashOutput}>
                          <TranscriptBundleRows
                            workspaceId={selectedWorkspaceId}
                            messages={renderedMessages}
                            indexOffset={0}
                            bundles={transcriptBundles}
                            renderMessageAtIndex={(msg, index, options) => {
                              const rowProps = getTranscriptRowProps({
                                derivations: transcriptRowDerivations,
                                userMessageNavigationByHistoryId,
                                messages: renderedMessages,
                                message: msg,
                                index,
                              });
                              if (rowProps.hidden) {
                                return null;
                              }
                              const { bashOutputGroup, bashGroupKey } = rowProps;
                              const row = (
                                <DisplayedMessageRenderer
                                  message={msg}
                                  workspaceId={selectedWorkspaceId}
                                  isLatestProposePlan={msg.id === latestProposePlanId}
                                  isCompacting={aggregatorRef.current?.isCompacting() ?? false}
                                  onCloseEphemeral={messageRowActions.closeEphemeral}
                                  onShowAllHistory={messageRowActions.showAllHistory}
                                  bashOutputGroup={bashOutputGroup}
                                  taskReportLinking={rowProps.taskReportLinking}
                                  userMessageNavigation={rowProps.userMessageNavigation}
                                />
                              );
                              return (
                                <Fragment key={options.key}>
                                  {options.className ? (
                                    <div className={options.className}>{row}</div>
                                  ) : (
                                    row
                                  )}
                                  {bashOutputGroup?.position === "first" && bashGroupKey ? (
                                    <BashOutputCollapsedIndicator
                                      processId={bashOutputGroup.processId}
                                      collapsedCount={bashOutputGroup.collapsedCount}
                                      isExpanded={rowProps.isBashGroupExpanded}
                                      onToggle={() =>
                                        transcriptRowDerivations.toggleBashOutputGroup(bashGroupKey)
                                      }
                                    />
                                  ) : null}
                                  {retryBarrier?.interruptedBarrierMessageIds.has(msg.id) ? (
                                    <InterruptedBarrier
                                      resumable={
                                        retryBarrier.interruptedTailResumable &&
                                        msg.id === retryBarrier.lastRetryCandidateMessage?.id
                                      }
                                      onResume={resumeInterruptedStream}
                                      error={resumeInterruptedError}
                                    />
                                  ) : null}
                                </Fragment>
                              );
                            }}
                          />
                          {/* Transcript tail, after the rows, as in desktop ChatPane. */}
                          {canChat && retryBarrier?.shouldMountRetryBarrier && streamState ? (
                            <RetryBarrierContent
                              workspaceId={selectedWorkspaceId}
                              visible={retryBarrier.showRetryBarrierUI}
                              messages={displayedMessages}
                              autoRetryStatus={autoRetryStatus}
                              // The webview shows the backend's retry countdown but never
                              // stops auto-retry, so no Stop action.
                              showStopAutoRetry={false}
                              isStreamStarting={streamState.isStreamStarting}
                              canInterrupt={streamState.canInterrupt}
                              onRetry={resumeInterruptedStreamAsync}
                              retryError={resumeInterruptedError}
                            />
                          ) : null}
                        </LiveBashOutputSourceContext.Provider>
                      ) : null}

                      {notices.map((notice) => (
                        <div
                          key={notice.id}
                          className={
                            notice.level === "error"
                              ? "mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                              : "mt-3 rounded-md border border-border-medium bg-background-secondary px-3 py-2 text-sm"
                          }
                        >
                          {notice.message}
                        </div>
                      ))}

                      {!selectedWorkspaceId && notices.length === 0 ? (
                        <div className="text-muted text-sm">
                          Select a Xum workspace to view messages.
                        </div>
                      ) : null}
                    </div>
                    {/* Bottom anchor: last child of the scrollport, so content appends above it. */}
                    <div
                      ref={sentinelRef}
                      data-testid="transcript-bottom-sentinel"
                      aria-hidden="true"
                      className="h-0 w-full"
                      style={TRANSCRIPT_BOTTOM_SENTINEL_STYLE}
                    />
                  </div>

                  {/* The dock holds the chat input, which opts into Escape-to-interrupt like the
                      desktop ChatInput textarea; other editors keep Escape to themselves. */}
                  <div
                    className="relative bg-surface-primary px-[15px] pt-2 pb-2"
                    data-escape-interrupts-stream="true"
                  >
                    {selectedWorkspaceId && !autoScroll ? (
                      // Same pill as desktop ChatPane, just above the dock.
                      <button
                        onClick={jumpToBottom}
                        type="button"
                        className="assistant-chip font-primary text-foreground hover:assistant-chip-hover absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 cursor-pointer rounded-[20px] px-2 py-1 text-xs font-medium shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-[1px] transition-transform duration-200 hover:scale-105 active:scale-95"
                      >
                        Jump to bottom{" "}
                        <span className="mobile-hide-shortcut-hints">
                          ({formatKeybind(KEYBINDS.JUMP_TO_BOTTOM)})
                        </span>
                      </button>
                    ) : null}
                    {selectedWorkspaceId && heldInputs.length > 0 ? (
                      // Bounded scroll lane: many or long held inputs must not push the composer
                      // below the fixed-height layout or collapse the transcript.
                      <div className="max-h-[40vh] overflow-y-auto">
                        {heldInputs.map((heldInput, index) => (
                          <HeldInput
                            key={heldInput.id}
                            workspaceId={selectedWorkspaceId}
                            heldInput={heldInput}
                            // The composer's held-input shortcuts act on the oldest one.
                            isShortcutTarget={index === 0}
                          />
                        ))}
                      </div>
                    ) : null}
                    {/* Background bashes sit between held inputs and the turn status, as in the
                        desktop dock. Keyed so the expanded list and an open output dialog never
                        carry over to another workspace. Without a server connection the store has
                        no client, so its last-known processes are not offered. */}
                    {selectedWorkspaceId && canChat ? (
                      // The shared banner brings its own dock gutter (desktop's composer has the
                      // same one); cancel this dock's padding so it lines up with the composer.
                      <div className="-mx-[15px]">
                        <BackgroundProcessesBanner
                          // Sibling of the composer, which is keyed by the bare workspace ID.
                          key={`background-processes-${selectedWorkspaceId}`}
                          workspaceId={selectedWorkspaceId}
                        />
                      </div>
                    ) : null}
                    {/* Live turn status sits beside the input, below held inputs, as in desktop. */}
                    {selectedWorkspaceId ? (
                      <VscodeStreamingBarrier
                        workspaceId={selectedWorkspaceId}
                        aggregator={aggregatorRef.current}
                        activeBashMonitorCount={activeBashMonitorCount}
                        onCancel={(phase) =>
                          interruptStream({ abandonPartial: phase === "compacting" })
                        }
                      />
                    ) : null}
                    {selectedWorkspaceId ? (
                      <ChatComposer
                        key={selectedWorkspaceId}
                        workspaceId={selectedWorkspaceId}
                        disabled={!canChat || !transcriptCaughtUp}
                        disabledReason={
                          !canChat
                            ? "Chat requires Xum server connection."
                            : !transcriptCaughtUp
                              ? "Loading chat history..."
                              : undefined
                        }
                        aggregator={aggregatorRef.current}
                        aiSettingsLoaded={selectedWorkspace?.ai != null}
                        agentScoped={agentScopeWorkspaceId != null}
                        heldInputId={heldInputs[0]?.id}
                        onSendComplete={jumpToBottom}
                        onNotice={pushNotice}
                      />
                    ) : (
                      <div className="text-muted text-sm">Select a Xum workspace to chat.</div>
                    )}
                  </div>
                </div>
              </WebviewChatProviders>
            </ThemeProvider>
          </ProviderOptionsProvider>
        </SettingsProvider>
      </ChatHostContextProvider>
    </RouterProvider>
  );
}
