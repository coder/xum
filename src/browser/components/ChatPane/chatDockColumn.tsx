import { createContext, useContext, type ReactNode } from "react";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";

const ChatDockFullWidthContext = createContext(false);

export const ChatDockColumnProvider = ChatDockFullWidthContext.Provider;

/** Lines a docked surface up with the transcript column in whichever width mode is active. */
export function useChatDockColumnWidthClass(): string {
  return useContext(ChatDockFullWidthContext) ? "w-full" : "mx-auto w-full max-w-4xl";
}

/** Gutter plus column for docked surfaces that carry no padding of their own. */
export function ChatDockSurface(props: { children: ReactNode }) {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div className={CHAT_DOCK_GUTTER_CLASS}>
      <div className={columnWidthClass} data-component="ChatDockSurface">
        {props.children}
      </div>
    </div>
  );
}
