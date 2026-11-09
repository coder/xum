import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Input } from "@/browser/components/Input/Input";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useChatPaneScope } from "@/browser/contexts/ChatPaneScopeContext";
import {
  pinTimelineRevealTarget,
  useWorkspaceState,
  useWorkspaceStoreRaw,
} from "@/browser/stores/WorkspaceStore";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { revealTimelineTarget } from "@/browser/utils/timelineReveal";
import {
  formatKeybind,
  isDialogOpen,
  KEYBINDS,
  matchesKeybind,
  paneHandlesKeyEvent,
  type ChatPaneScope,
} from "@/browser/utils/ui/keybinds";
import { findChatSearchMatches } from "./chatSearchMatches";

interface ChatSearchProps {
  workspaceId: string;
  transcriptRef: RefObject<HTMLDivElement>;
  enabled: boolean;
}

function isChatSearchTarget(
  transcriptRef: RefObject<HTMLDivElement>,
  paneScope: ChatPaneScope,
  target: EventTarget | null
): boolean {
  const root = transcriptRef.current;
  if (!root || root.closest('[aria-hidden="true"], [inert]')) return false;
  // Include the main chat footer. The review panel and terminals keep their own Find shortcuts.
  const chatRoot = paneScope === "main" ? root.closest("main")?.parentElement : root.parentElement;
  return !(target instanceof Node && target !== document.body && !chatRoot?.contains(target));
}

function useChatSearchShortcut(props: ChatSearchProps, onOpen: () => void) {
  const paneScope = useChatPaneScope();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !props.enabled ||
        event.defaultPrevented ||
        !matchesKeybind(event, KEYBINDS.SEARCH_CHAT) ||
        !paneHandlesKeyEvent(paneScope, event.target) ||
        isDialogOpen() ||
        !isChatSearchTarget(props.transcriptRef, paneScope, event.target)
      ) {
        return;
      }
      event.preventDefault();
      // Capture prevents the review panel's bubble listener from claiming this shortcut.
      stopKeyboardPropagation(event);
      onOpen();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onOpen, paneScope, props.enabled, props.transcriptRef]);
}

function useChatSearchFocus() {
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return {
    inputRef,
    remember: () => {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    select: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    restore: () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    },
  };
}

export function ChatSearch(props: ChatSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const focus = useChatSearchFocus();
  useChatSearchShortcut(props, () => {
    if (!isOpen) {
      focus.remember();
      setIsOpen(true);
    }
    focus.select();
  });

  if (!isOpen || !props.enabled) return null;

  const close = () => {
    setIsOpen(false);
    focus.restore();
  };
  return (
    <div
      role="search"
      aria-label="Chat search"
      className="bg-surface-primary border-border-light shrink-0 border-b px-3 py-2"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (matchesKeybind(event, KEYBINDS.CANCEL)) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          close();
        }
      }}
    >
      <ChatSearchResults
        workspaceId={props.workspaceId}
        inputRef={focus.inputRef}
        onClose={close}
      />
    </div>
  );
}

function useChatSearchReveal(
  workspaceId: string,
  messageId: string | undefined,
  query: string,
  setError: (error: string) => void
) {
  const store = useWorkspaceStoreRaw();
  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;
    revealTimelineTarget({
      workspaceId,
      getTarget: () => ({ messageId }),
      workspaceStore: store,
      pinTarget: pinTimelineRevealTarget,
      // Only the explicit button loads older pages. Results already belong to loaded history.
      maxHistoryPages: 0,
      isCancelled: () => cancelled,
      cancelPendingReveal: true,
    })
      .then((result) => {
        if (!cancelled && result !== "revealed") setError("Cannot reveal this message.");
      })
      .catch(() => {
        if (!cancelled) setError("Cannot reveal this message.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, messageId, query, store, setError]);
}

function ChatSearchResults(props: {
  workspaceId: string;
  inputRef: RefObject<HTMLInputElement>;
  onClose: () => void;
}) {
  const workspace = useWorkspaceState(props.workspaceId);
  const [query, setQuery] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Search the source history, not the DOM: older replies can hide behind transcript limits.
  const matches = findChatSearchMatches(workspace.muxMessages, query);
  const selectedIndex = Math.max(
    0,
    matches.findIndex((match) => match.messageId === selectedMessageId)
  );
  const selectedMatch = matches[selectedIndex];
  useChatSearchReveal(props.workspaceId, selectedMatch?.messageId, query, setError);

  const navigate = (direction: number) => {
    if (matches.length === 0) return;
    setError(null);
    const index = (selectedIndex + direction + matches.length) % matches.length;
    setSelectedMessageId(matches[index].messageId);
  };

  return (
    <>
      <ChatSearchControls
        inputRef={props.inputRef}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setSelectedMessageId(null);
          setError(null);
        }}
        selectedIndex={selectedIndex}
        matchCount={matches.length}
        navigate={navigate}
        onClose={props.onClose}
      />
      {selectedMatch && (
        <p
          className="text-muted mt-1 line-clamp-2 text-xs break-words"
          aria-label="Matching message preview"
        >
          <mark className="bg-warning-overlay text-foreground">{selectedMatch.match}</mark>
          {selectedMatch.after}
        </p>
      )}
      {query.trim() && !selectedMatch && (
        <p className="text-muted mt-1 text-xs">No matching messages.</p>
      )}
      <ChatSearchOlderHistory workspaceId={props.workspaceId} />
      {error && (
        <p role="alert" className="text-error mt-1 text-xs">
          {error}
        </p>
      )}
    </>
  );
}

function ChatSearchControls(props: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQueryChange: (query: string) => void;
  selectedIndex: number;
  matchCount: number;
  navigate: (direction: number) => void;
  onClose: () => void;
}) {
  useLayoutEffect(() => {
    props.inputRef.current?.focus();
  }, [props.inputRef]);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Search aria-hidden="true" className="text-muted mr-1 size-4 shrink-0" />
      <Input
        ref={props.inputRef}
        type="search"
        aria-label="Search chat"
        placeholder="Search chat"
        className="h-8 min-w-0 flex-1"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // IME confirmation and cancellation must not navigate or close search.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (matchesKeybind(event, KEYBINDS.NEXT_CHAT_SEARCH_RESULT)) {
            event.preventDefault();
            stopKeyboardPropagation(event);
            props.navigate(1);
          } else if (matchesKeybind(event, KEYBINDS.PREVIOUS_CHAT_SEARCH_RESULT)) {
            event.preventDefault();
            stopKeyboardPropagation(event);
            props.navigate(-1);
          }
        }}
      />
      <span
        role="status"
        aria-label="Matching messages"
        className="text-muted counter-nums shrink-0 px-1 text-xs whitespace-nowrap"
      >
        {props.query.trim()
          ? `${props.matchCount ? props.selectedIndex + 1 : 0} / ${props.matchCount}`
          : ""}
      </span>
      <SearchButton
        label="Previous matching message"
        shortcut={KEYBINDS.PREVIOUS_CHAT_SEARCH_RESULT}
        disabled={props.matchCount === 0}
        onClick={() => props.navigate(-1)}
      >
        <ArrowUp aria-hidden="true" className="size-4" />
      </SearchButton>
      <SearchButton
        label="Next matching message"
        shortcut={KEYBINDS.NEXT_CHAT_SEARCH_RESULT}
        disabled={props.matchCount === 0}
        onClick={() => props.navigate(1)}
      >
        <ArrowDown aria-hidden="true" className="size-4" />
      </SearchButton>
      <SearchButton label="Close chat search" shortcut={KEYBINDS.CANCEL} onClick={props.onClose}>
        <X aria-hidden="true" className="size-4" />
      </SearchButton>
    </div>
  );
}

function ChatSearchOlderHistory(props: { workspaceId: string }) {
  const workspace = useWorkspaceState(props.workspaceId);
  const store = useWorkspaceStoreRaw();
  const [error, setError] = useState<string | null>(null);
  const loadOlder = () => {
    setError(null);
    store
      .loadOlderHistory(props.workspaceId)
      .then((result) => {
        if (result === "failed" || result === "unavailable")
          setError("Cannot load older messages.");
      })
      .catch(() => setError("Cannot load older messages."));
  };
  if (!workspace.hasOlderHistory) return null;
  return (
    <>
      <div className="text-muted mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        <span>Search includes loaded messages.</span>
        <button
          type="button"
          disabled={workspace.loadingOlderHistory}
          onClick={loadOlder}
          className="text-foreground underline underline-offset-2 disabled:opacity-50"
        >
          {workspace.loadingOlderHistory ? "Loading..." : "Load older messages to search"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-error mt-1 text-xs">
          {error}
        </p>
      )}
    </>
  );
}

function SearchButton(props: {
  label: string;
  shortcut: Parameters<typeof formatKeybind>[0];
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <TooltipIfPresent tooltip={`${props.label} (${formatKeybind(props.shortcut)})`}>
      <button
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onClick}
        className="text-muted hover:text-foreground hover:bg-hover flex size-7 shrink-0 items-center justify-center rounded disabled:opacity-40"
      >
        {props.children}
      </button>
    </TooltipIfPresent>
  );
}
