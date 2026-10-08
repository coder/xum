import { createContext, useContext, type ReactNode } from "react";
import type { ChatPaneScope } from "@/browser/utils/ui/keybinds";

/**
 * Which chat pane a subtree renders: the routed main chat, or the /side chat tab in the right
 * sidebar. Window-level shortcuts and unscoped global events (model selector, voice input, ...)
 * consult it so the two mounted panes never both react (see paneHandlesKeyEvent).
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
