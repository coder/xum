import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import React, { createContext, useContext } from "react";
import { TranscriptBackfillContext } from "./TranscriptBackfillContext";

interface MessageListContextValue {
  workspaceId: string;
  latestMessageId: string | null;
  /** Open an integrated terminal tab for this workspace (optionally running a command) */
  openTerminal?: (options?: TerminalSessionCreateOptions) => void;
}

const MessageListContext = createContext<MessageListContextValue | null>(null);

interface MessageListProviderProps {
  value: MessageListContextValue;
  /** See TranscriptBackfillContext. */
  isTranscriptBackfilling?: boolean;
  children: React.ReactNode;
}

export const MessageListProvider: React.FC<MessageListProviderProps> = (props) => {
  return (
    <MessageListContext.Provider value={props.value}>
      <TranscriptBackfillContext.Provider value={props.isTranscriptBackfilling ?? false}>
        {props.children}
      </TranscriptBackfillContext.Provider>
    </MessageListContext.Provider>
  );
};

export function useOptionalMessageListContext(): MessageListContextValue | null {
  return useContext(MessageListContext);
}
