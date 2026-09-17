import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupCustomChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import { createUserMessage } from "@/browser/stories/mocks/messages";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";

const meta = {
  ...appMeta,
  title: "Features/Messages/ChatBarrier/InterruptedBarrier",
};

export default meta;

// Integration: story uses full app chat streaming to trigger context-exceeded error in InterruptedBarrier.
export const ContextExceededSuggestion: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-context-exceeded";
        return setupCustomChatStory({
          workspaceId,
          providersConfig: {
            openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
            xai: { apiKeySet: true, isEnabled: true, isConfigured: true },
          },
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Can you help me with this huge codebase?", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up", historyReplayStatus: "complete" });

              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-1",
                model: "openai:gpt-5.2",
                historySequence: 2,
                startTime: STABLE_TIMESTAMP - 90000,
                mode: "exec",
              });

              callback({
                type: "stream-error",
                messageId: "assistant-1",
                error:
                  "Context length exceeded: the conversation is too long to send to this model.",
                errorType: "context_exceeded",
              });
            }, 50);
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          },
        });
      }}
    />
  ),
};
