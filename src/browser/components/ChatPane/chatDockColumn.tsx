import { createContext, useContext, type ReactNode } from "react";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";

const ChatDockFullWidthContext = createContext(false);

export const ChatDockColumnProvider = ChatDockFullWidthContext.Provider;

/** Lines a docked surface up with the transcript column in whichever width mode is active. */
export function useChatDockColumnWidthClass(): string {
  return useContext(ChatDockFullWidthContext) ? "w-full" : "mx-auto w-full max-w-chat";
}

const ChatDockInsetContext = createContext(false);

/**
 * Set inside a container that already sits in the dock's column (the "Waiting on you" card and
 * sheet): docked surfaces in it skip their own gutter and column.
 */
export const ChatDockInsetProvider = ChatDockInsetContext.Provider;

/** Gutter plus column for docked surfaces that carry no padding of their own. */
export function ChatDockSurface(props: { children: ReactNode }) {
  const columnWidthClass = useChatDockColumnWidthClass();
  if (useContext(ChatDockInsetContext)) {
    return <div data-component="ChatDockSurface">{props.children}</div>;
  }

  return (
    <div className={CHAT_DOCK_GUTTER_CLASS}>
      <div className={columnWidthClass} data-component="ChatDockSurface">
        {props.children}
      </div>
    </div>
  );
}
