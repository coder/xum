import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";

import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import {
  type AdditionalSystemContextSnapshot,
  getAdditionalSystemContextFocusGeneration,
  getAdditionalSystemContextVersion,
  queueAdditionalSystemContextSave,
  requestAdditionalSystemContextFocus,
  subscribeAdditionalSystemContextFocus,
  updateAdditionalSystemContextSnapshot,
  useAdditionalSystemContextSnapshot,
} from "@/browser/utils/additionalSystemContextStore";
import { focusInstructionsTab } from "@/browser/utils/instructionsTabFocus";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";

/** UI label used everywhere the user sees this feature. */
export const CHAT_INSTRUCTIONS_LABEL = "Chat Instructions";

/**
 * Delay before flashing the "Saving…" indicator. The save itself queues
 * instantly, but most writes complete in tens of milliseconds so flashing a
 * status message every keystroke is jittery. We only surface it once the save
 * takes longer than this — e.g. on slow filesystems or during retries.
 */
const SAVING_INDICATOR_DELAY_MS = 1000;

export function getChatInstructionsFirstLinePreview(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() || "(blank first line)";
}

export function isChatInstructionsActive(snapshot: AdditionalSystemContextSnapshot): boolean {
  return snapshot.enabled && snapshot.content.trim().length > 0;
}

interface ScratchpadState {
  content: string;
  enabled: boolean;
  loading: boolean;
  /**
   * Editing is off while the text loads, and while there is no live connection to save to (the
   * editor keeps showing the text).
   */
  disabled: boolean;
  /** True once the save has been in flight longer than the indicator delay. */
  savingVisible: boolean;
  error: string | null;
  setContent: (content: string) => void;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Loads the workspace's instructions into the store; returns whether the first load is pending.
 *
 * A re-run for the shown workspace (a new API client after a reconnect) keeps the editor as it
 * is: it does not flash "Loading…" or take focus from the textarea. A local edit the backend has
 * not settled (`dirtyRef`) is not replaced by the load.
 */
function useChatInstructionsLoad(
  workspaceId: string,
  dirtyRef: { current: boolean },
  setError: (error: string | null) => void
): boolean {
  const { api } = useAPI();
  const [loading, setLoading] = useState(true);
  // The workspace whose instructions the editor shows (loaded, or failed to load).
  const loadedWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadedWorkspaceIdRef.current !== workspaceId) {
      loadedWorkspaceIdRef.current = null;
      dirtyRef.current = false;
      setLoading(true);
    }
    setError(null);

    if (!api) return;

    const loadVersion = getAdditionalSystemContextVersion(workspaceId);
    // Set by the cleanup, which also runs on unmount.
    let cancelled = false;
    api.workspace
      .getAdditionalSystemContext({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        if (!dirtyRef.current && getAdditionalSystemContextVersion(workspaceId) === loadVersion) {
          updateAdditionalSystemContextSnapshot(workspaceId, {
            content: result.content,
            enabled: result.enabled,
          });
        }
        setLoading(false);
        loadedWorkspaceIdRef.current = workspaceId;
      })
      .catch((err) => {
        // A lost connection is not a load error: keep the editor as it is for the next client.
        if (cancelled || isConnectionLostError(err)) return;
        setError(getErrorMessage(err));
        setLoading(false);
        loadedWorkspaceIdRef.current = workspaceId;
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, dirtyRef, setError]);

  return loading;
}

export function useChatInstructions(workspaceId: string): ScratchpadState {
  // Saves need a live connection. While Xum reconnects the editor keeps showing the text but is
  // read-only, so no edit waits for a later client.
  const liveApi = useLiveAPI();
  const snapshot = useAdditionalSystemContextSnapshot(workspaceId);
  const [savingVisible, setSavingVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An edit the backend has not settled yet: a load must not replace it. A failed save settles
  // it too, so a later reload shows what the backend stored.
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loading = useChatInstructionsLoad(workspaceId, dirtyRef, setError);

  const clearSavingTimer = () => {
    if (savingTimerRef.current != null) {
      clearTimeout(savingTimerRef.current);
      savingTimerRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSavingTimer();
    };
  }, []);

  // Another workspace starts without the previous one's "Saving…".
  useEffect(() => {
    setSavingVisible(false);
    clearSavingTimer();
  }, [workspaceId]);

  const queue = useCallback(
    (next: AdditionalSystemContextSnapshot) => {
      if (!liveApi) return;
      dirtyRef.current = true;
      updateAdditionalSystemContextSnapshot(workspaceId, next);
      setError(null);
      // Only show the "Saving…" message if the save takes more than a beat —
      // sub-second writes shouldn't flicker the UI on every keystroke.
      clearSavingTimer();
      savingTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSavingVisible(true);
        savingTimerRef.current = null;
      }, SAVING_INDICATOR_DELAY_MS);
      queueAdditionalSystemContextSave(liveApi, workspaceId, next, {
        onError: (err) => {
          if (!mountedRef.current) return;
          setError(getErrorMessage(err));
        },
        onIdle: () => {
          dirtyRef.current = false;
          if (!mountedRef.current) return;
          clearSavingTimer();
          setSavingVisible(false);
        },
      });
    },
    [liveApi, workspaceId]
  );

  const setContent = useCallback(
    (content: string) => {
      queue({ content, enabled: snapshot.enabled });
    },
    [queue, snapshot.enabled]
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      queue({ content: snapshot.content, enabled });
    },
    [queue, snapshot.content]
  );

  return {
    content: snapshot.content,
    enabled: snapshot.enabled,
    loading,
    disabled: loading || liveApi == null,
    savingVisible,
    error,
    setContent,
    setEnabled,
  };
}

interface ChatInstructionsEditorProps {
  workspaceId: string;
  className?: string;
  textareaClassName?: string;
  minRows?: number;
  placeholder?: string;
}

export function ChatInstructionsEditor(props: ChatInstructionsEditorProps) {
  const state = useChatInstructions(props.workspaceId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea so the editor "expands" as the user types instead
  // of forcing them into a small scroll window.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [state.content]);

  // Listen for focus-requests fired by the ChatInput decoration / badge so
  // that clicking the decoration brings the user straight into the editor.
  const lastFocusGenRef = useRef(getAdditionalSystemContextFocusGeneration(props.workspaceId));
  useEffect(() => {
    const focus = () => {
      const generation = getAdditionalSystemContextFocusGeneration(props.workspaceId);
      if (generation === lastFocusGenRef.current) return;
      lastFocusGenRef.current = generation;
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      // Place caret at end without selecting so the user can keep typing.
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    };
    const unsubscribe = subscribeAdditionalSystemContextFocus(props.workspaceId, focus);
    // Replay any generation bumped while we were unmounted (e.g. the tab was
    // switched on for the first time during the focus request).
    focus();
    return unsubscribe;
  }, [props.workspaceId]);

  // Render a quiet hint when there's no save in progress; only flash the
  // "Saving…" label after the >1s delay.
  const statusText = state.loading
    ? "Loading…"
    : state.savingVisible
      ? "Saving…"
      : state.enabled
        ? "Saved · in effect every turn"
        : "Saved · disabled (not sent to the agent)";

  return (
    <div className={cn("space-y-1.5", props.className)}>
      <textarea
        ref={textareaRef}
        value={state.content}
        rows={props.minRows ?? 3}
        onChange={(event) => state.setContent(event.currentTarget.value)}
        placeholder={
          props.placeholder ??
          "Add chat-scoped instructions that should be appended to the system prompt…"
        }
        className={cn(
          "border-border bg-background text-foreground placeholder:text-muted min-h-[72px] w-full resize-none overflow-hidden rounded border px-3 py-2 text-xs leading-5 outline-none focus:ring-1 focus:ring-[var(--color-accent)]",
          !state.enabled && "opacity-60",
          props.textareaClassName
        )}
        aria-label={`${CHAT_INSTRUCTIONS_LABEL} editor`}
        disabled={state.disabled}
      />
      <div className="text-muted flex min-h-4 items-center justify-between gap-2 text-[10px]">
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)]"
            checked={state.enabled}
            disabled={state.disabled}
            onChange={(event) => state.setEnabled(event.currentTarget.checked)}
            aria-label="Enable Chat Instructions"
          />
          <span>{state.enabled ? "Enabled" : "Disabled"}</span>
        </label>
        <span className="min-w-0 truncate">{statusText}</span>
        {state.error && (
          <span className="text-destructive shrink-0 truncate" title={state.error}>
            {state.error}
          </span>
        )}
      </div>
    </div>
  );
}

export function ChatInstructionsPanel(props: { workspaceId: string }) {
  return (
    <section className="border-border border-b px-3 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium">{CHAT_INSTRUCTIONS_LABEL}</h3>
          {/* Chat-scoped: the text lives in this chat's session folder
              (additionalSystemContext.ts), and forks and side chats start with a copy
              (workspaceService.ts). Both strings in this file name the same scope (#6104). */}
          <p className="text-muted mt-0.5 text-[10px]">
            Chat-scoped instructions appended to the system prompt on every turn of this chat. Forks
            and side chats start with a copy. Toggle off to keep the text around without sending it.
          </p>
        </div>
      </div>
      <ChatInstructionsEditor workspaceId={props.workspaceId} />
    </section>
  );
}

/**
 * Compact decoration rendered in the chat-input decoration stack whenever
 * {@link isChatInstructionsActive} is true. Visually matches the other
 * decorations (TODO, background bashes, queued messages) via the shared
 * {@link ChatInputDecoration} primitive, but acts as a link rather than an
 * expandable panel: clicking opens the Instructions tab in the right sidebar
 * and focuses the editor there. We render the trailing icon as an arrow
 * instead of a chevron to signal "this opens elsewhere".
 */
export function ChatInstructionsChatDecoration(props: { workspaceId: string }) {
  const snapshot = useAdditionalSystemContextSnapshot(props.workspaceId);
  if (!isChatInstructionsActive(snapshot)) return null;

  const handleOpenInPanel = () => {
    focusInstructionsTab(props.workspaceId);
    requestAdditionalSystemContextFocus(props.workspaceId);
  };

  return (
    <ChatInputDecoration
      // Pure link — never expands inline. The dedicated editor in the
      // Instructions tab is the authoritative editing surface.
      expanded={false}
      onToggle={handleOpenInPanel}
      dataComponent="ChatInstructionsChatDecoration"
      trailingIcon={
        <ArrowUpRight
          aria-hidden="true"
          className="text-muted group-hover:text-secondary size-3.5 transition-colors"
        />
      }
      summary={
        <>
          <BookOpen className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          <span className="text-muted group-hover:text-secondary flex min-w-0 items-center gap-1 transition-colors">
            <span className="shrink-0 font-medium">{CHAT_INSTRUCTIONS_LABEL}</span>
            <span className="min-w-0 truncate">
              · {getChatInstructionsFirstLinePreview(snapshot.content)}
            </span>
          </span>
        </>
      }
    />
  );
}
