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
  // Inset or not, the same two elements: only the classes change. A different tree would remount
  // the content whenever the "Waiting on you" card forms or breaks up, losing a half-typed answer's
  // textarea (and its focus) mid-word.
  const inset = useContext(ChatDockInsetContext);
  return (
    <div className={inset ? undefined : CHAT_DOCK_GUTTER_CLASS}>
      <div className={inset ? undefined : columnWidthClass} data-component="ChatDockSurface">
        {props.children}
      </div>
    </div>
  );
}
