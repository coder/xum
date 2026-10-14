import { createContext, useContext, type ReactNode } from "react";
import type { ChatPaneScope } from "@/browser/utils/ui/keybinds";

/**
 * Which chat pane a subtree renders: the routed main chat, or a specific /side workspace in the
 * right sidebar. Window-level shortcuts consult it so only the focused pane reacts, even with
 * several side tabs visible (see paneHandlesKeyEvent). Unscoped global events (model selector,
 * voice input, ...) belong only to the main chat.
 */
const ChatPaneScopeContext = createContext<ChatPaneScope>("main");

export function ChatPaneScopeProvider(props: { scope: ChatPaneScope; children: ReactNode }) {
  return (
    <ChatPaneScopeContext.Provider value={props.scope}>
      {props.children}
    </ChatPaneScopeContext.Provider>
  );
}

export function useChatPaneScope(): ChatPaneScope {
  return useContext(ChatPaneScopeContext);
}
