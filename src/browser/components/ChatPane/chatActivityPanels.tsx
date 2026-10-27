import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isDialogOpen } from "@/browser/utils/ui/keybinds";

/**
 * The activity summaries that share the composer's live line as chips: the streaming status row
 * carries them, so the dock spends one row on activity instead of one row per kind.
 */
export type ChatActivityId =
  | "todo"
  | "sub-agents"
  | "background-bashes"
  | "reviews"
  | "chat-instructions";

type OpenIdUpdate = (current: ChatActivityId | null) => ChatActivityId | null;

interface ChatActivityPanelsValue {
  openId: ChatActivityId | null;
  setOpenId: (update: OpenIdUpdate) => void;
}

const ChatActivityPanelsContext = createContext<ChatActivityPanelsValue | null>(null);

/** True inside the live line, where ChatInputDecoration renders a chip instead of a full row. */
export function useInChatActivityLine(): boolean {
  return useContext(ChatActivityPanelsContext) !== null;
}

type SetExpanded = (next: boolean | ((current: boolean) => boolean)) => void;

/**
 * Expanded state of one activity summary. Inside the live line every chip shares one panel slot,
 * so opening one closes the others; outside it (tests, hosts without the line) each summary keeps
 * its own state. The setter reads the current slot, so stale closures cannot reopen a closed panel.
 */
export function useChatActivityPanel(id: ChatActivityId): [boolean, SetExpanded] {
  const panels = useContext(ChatActivityPanelsContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  if (panels === null) {
    return [localExpanded, setLocalExpanded];
  }
  // Capture the state setter, not the context value (a new object whenever a panel opens or
  // closes), so the compiler keeps this setter stable and effects can list it as a dependency.
  const { openId, setOpenId } = panels;
  const setExpanded: SetExpanded = (next) =>
    setOpenId((current) => {
      const wasOpen = current === id;
      const open = typeof next === "function" ? next(wasOpen) : next;
      if (open) return id;
      return wasOpen ? null : current;
    });
  return [openId === id, setExpanded];
}

/**
 * Releases the shared slot when a chip unmounts while its panel is open (its last bash exits, the
 * TODO list clears), so the panel does not pop open again when the chip comes back later.
 */
export function useReleaseChatActivityPanelOnUnmount(id: ChatActivityId | undefined): void {
  const panels = useContext(ChatActivityPanelsContext);
  const setOpenId = panels?.setOpenId;
  useEffect(() => {
    if (setOpenId === undefined || id === undefined) return;
    return () => setOpenId((current) => (current === id ? null : current));
  }, [setOpenId, id]);
}

/**
 * Owns the live line's single open panel. A press outside the line closes it, except inside a
 * modal opened from a panel (the background bash output dialog portals outside the line).
 */
export function ChatActivityPanelsProvider(props: {
  children: ReactNode;
  className?: string;
  dataComponent?: string;
}) {
  const [openId, setOpenIdState] = useState<ChatActivityId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isDialogOpen()) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenIdState(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openId]);

  return (
    <ChatActivityPanelsContext.Provider value={{ openId, setOpenId: setOpenIdState }}>
      <div ref={rootRef} className={props.className} data-component={props.dataComponent}>
        {props.children}
      </div>
    </ChatActivityPanelsContext.Provider>
  );
}
