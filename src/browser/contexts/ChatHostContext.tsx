import React, { createContext, useContext } from "react";

import type { FilePart } from "@/common/orpc/types";
import {
  CHAT_UI_FEATURE_IDS,
  type ChatUiFeatureId,
  type ChatUiSupport,
} from "@/common/constants/chatUiFeatures";
import type { ReviewNoteData } from "@/common/types/review";

export interface ChatHostActions {
  editUserMessage?: (messageId: string, content: string, fileParts?: FilePart[]) => void;
  addReviewNote?: (data: ReviewNoteData) => void;
  sendBashToBackground?: (toolCallId: string) => void;
  openCommandPalette?: () => void;
}

/**
 * Transcript mutation barrier supplied by a host that does not feed WorkspaceStore (the VS Code
 * webview, #4942). `isAllowed` must read live state: dispatch sites call it after awaits.
 */
export interface HostTranscriptBarrier {
  subscribe(workspaceId: string, listener: () => void): () => void;
  isAllowed(workspaceId: string): boolean;
}

export interface ChatHostContextValue {
  uiSupport: Record<ChatUiFeatureId, ChatUiSupport>;
  actions: ChatHostActions;
  /** Absent on desktop, where the barrier reads WorkspaceStore. */
  transcriptBarrier?: HostTranscriptBarrier;
}

const DEFAULT_CHAT_UI_SUPPORT: Record<ChatUiFeatureId, ChatUiSupport> = CHAT_UI_FEATURE_IDS.reduce(
  (acc, featureId) => {
    acc[featureId] = "supported";
    return acc;
  },
  {} as Record<ChatUiFeatureId, ChatUiSupport>
);

const ChatHostContext = createContext<ChatHostContextValue>({
  uiSupport: DEFAULT_CHAT_UI_SUPPORT,
  actions: {},
});

export function ChatHostContextProvider(props: {
  value: ChatHostContextValue;
  children: React.ReactNode;
}): JSX.Element {
  return <ChatHostContext.Provider value={props.value}>{props.children}</ChatHostContext.Provider>;
}

export function useChatHostContext(): ChatHostContextValue {
  return useContext(ChatHostContext);
}
