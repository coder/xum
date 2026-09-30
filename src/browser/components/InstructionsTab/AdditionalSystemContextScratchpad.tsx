import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";

import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { useAPI } from "@/browser/contexts/API";
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
  /** True once the save has been in flight longer than the indicator delay. */
  savingVisible: boolean;
  error: string | null;
  setContent: (content: string) => void;
  setEnabled: (enabled: boolean) => void;
}

export function useChatInstructions(workspaceId: string): ScratchpadState {
  const { api } = useAPI();
  const snapshot = useAdditionalSystemContextSnapshot(workspaceId);
  const [loading, setLoading] = useState(true);
  const [savingVisible, setSavingVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    dirtyRef.current = false;
    setLoading(true);
    setSavingVisible(false);
    clearSavingTimer();
    setError(null);

    if (!api) return;

    const loadVersion = getAdditionalSystemContextVersion(workspaceId);
    let cancelled = false;
    api.workspace
      .getAdditionalSystemContext({ workspaceId })
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        if (!dirtyRef.current && getAdditionalSystemContextVersion(workspaceId) === loadVersion) {
          updateAdditionalSystemContextSnapshot(workspaceId, {
            content: result.content,
            enabled: result.enabled,
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        setError(getErrorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const queue = useCallback(
    (next: AdditionalSystemContextSnapshot) => {
      dirtyRef.current = true;
      updateAdditionalSystemContextSnapshot(workspaceId, next);
      if (!api) return;
      setError(null);
      // Only show the "Saving…" message if the save takes more than a beat —
      // sub-second writes shouldn't flicker the UI on every keystroke.
      clearSavingTimer();
      savingTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSavingVisible(true);
        savingTimerRef.current = null;
      }, SAVING_INDICATOR_DELAY_MS);
      queueAdditionalSystemContextSave(api, workspaceId, next, {
        onError: (err) => {
          if (!mountedRef.current) return;
          setError(getErrorMessage(err));
        },
        onIdle: () => {
          if (!mountedRef.current) return;
          clearSavingTimer();
          setSavingVisible(false);
        },
      });
    },
    [api, workspaceId]
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
        disabled={state.loading}
      />
      <div className="text-muted flex min-h-4 items-center justify-between gap-2 text-[10px]">
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)]"
            checked={state.enabled}
            disabled={state.loading}
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
          <p className="text-muted mt-0.5 text-[10px]">
            Workspace-scoped instructions appended to the system prompt for every chat turn. Toggle
            off to keep the text around without sending it.
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
