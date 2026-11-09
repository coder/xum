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
} from "@/browser/utils/ui/keybinds";
import { findChatSearchMatches } from "./chatSearchMatches";

interface ChatSearchProps {
  workspaceId: string;
  transcriptRef: RefObject<HTMLDivElement>;
  enabled: boolean;
}

export function ChatSearch(props: ChatSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const paneScope = useChatPaneScope();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !props.enabled ||
        event.defaultPrevented ||
        !matchesKeybind(event, KEYBINDS.SEARCH_CHAT) ||
        !paneHandlesKeyEvent(paneScope, event.target) ||
        isDialogOpen()
      ) {
        return;
      }
      const root = props.transcriptRef.current?.parentElement;
      if (!root || root.closest('[aria-hidden="true"], [inert]')) return;
      const target = event.target;
      // The review panel, terminals, and other panes keep their own Find shortcuts.
      const chatRoot = paneScope === "main" ? root.closest("main") : root;
      if (target instanceof Node && target !== document.body && !chatRoot?.contains(target)) {
        return;
      }
      event.preventDefault();
      stopKeyboardPropagation(event);
      if (!isOpen) {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setIsOpen(true);
      }
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, paneScope, props.enabled, props.transcriptRef]);

  if (!isOpen || !props.enabled) return null;

  const close = () => {
    setIsOpen(false);
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
  };
  return (
    <div
      role="search"
      aria-label="Chat search"
      className="bg-surface-primary border-border-light shrink-0 border-b px-3 py-2"
      onKeyDown={(event) => {
        if (matchesKeybind(event, KEYBINDS.CANCEL)) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          close();
        }
      }}
    >
      <ChatSearchResults workspaceId={props.workspaceId} inputRef={inputRef} onClose={close} />
    </div>
  );
}

function ChatSearchResults(props: {
  workspaceId: string;
  inputRef: RefObject<HTMLInputElement>;
  onClose: () => void;
}) {
  const workspace = useWorkspaceState(props.workspaceId);
  const store = useWorkspaceStoreRaw();
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
  const activeMessageId = selectedMatch?.messageId;

  useLayoutEffect(() => {
    props.inputRef.current?.focus();
  }, [props.inputRef]);

  useEffect(() => {
    if (!activeMessageId) return;
    let cancelled = false;
    revealTimelineTarget({
      workspaceId: props.workspaceId,
      getTarget: () => ({ messageId: activeMessageId }),
      workspaceStore: store,
      pinTarget: pinTimelineRevealTarget,
      // Results already belong to loaded history. Only the explicit button loads older pages.
      maxHistoryPages: 0,
      isCancelled: () => cancelled,
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
  }, [props.workspaceId, activeMessageId, query, store]);

  const navigate = (direction: number) => {
    if (matches.length === 0) return;
    setError(null);
    const index = (selectedIndex + direction + matches.length) % matches.length;
    setSelectedMessageId(matches[index].messageId);
  };
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

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <Search aria-hidden="true" className="text-muted mr-1 size-4 shrink-0" />
        <Input
          ref={props.inputRef}
          type="search"
          aria-label="Search chat"
          placeholder="Search chat"
          className="h-8 min-w-0 flex-1"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedMessageId(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (matchesKeybind(event, KEYBINDS.NEXT_CHAT_SEARCH_RESULT)) {
              event.preventDefault();
              stopKeyboardPropagation(event);
              navigate(1);
            } else if (matchesKeybind(event, KEYBINDS.PREVIOUS_CHAT_SEARCH_RESULT)) {
              event.preventDefault();
              stopKeyboardPropagation(event);
              navigate(-1);
            }
          }}
        />
        <span
          role="status"
          aria-label="Matching messages"
          className="text-muted counter-nums shrink-0 px-1 text-xs whitespace-nowrap"
        >
          {query.trim() ? `${matches.length ? selectedIndex + 1 : 0} / ${matches.length}` : ""}
        </span>
        <SearchButton
          label="Previous matching message"
          shortcut={KEYBINDS.PREVIOUS_CHAT_SEARCH_RESULT}
          disabled={!selectedMatch}
          onClick={() => navigate(-1)}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
        </SearchButton>
        <SearchButton
          label="Next matching message"
          shortcut={KEYBINDS.NEXT_CHAT_SEARCH_RESULT}
          disabled={!selectedMatch}
          onClick={() => navigate(1)}
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </SearchButton>
        <SearchButton label="Close chat search" shortcut={KEYBINDS.CANCEL} onClick={props.onClose}>
          <X aria-hidden="true" className="size-4" />
        </SearchButton>
      </div>
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
      {workspace.hasOlderHistory && (
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
      )}
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
