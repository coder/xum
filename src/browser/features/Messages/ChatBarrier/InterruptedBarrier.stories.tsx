import { expect, waitFor, within } from "@storybook/test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DISABLED, PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
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

const RETRY_REPLY_TEXT = "The SSH host is back; the build passes now.";

// #4832: two pre-start attempts fail (live-only error rows, never persisted), then the
// auto-retry succeeds. The reply supersedes both error rows: no stale error below it and no
// "Stream interrupted" barrier, matching what a reload of the same history shows.
export const RetrySucceededAfterPreStartFailures: AppStory = {
  parameters: {
    // Behavior is guarded by the play test; a snapshot would only add to the Pixel budget.
    pixel: PIXEL_DISABLED,
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-prestart-retry";
        return setupCustomChatStory({
          workspaceId,
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Run the build on the remote workspace", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up", historyReplayStatus: "complete" });

              for (const attempt of [1, 2]) {
                callback({
                  type: "stream-error",
                  messageId: `assistant-failed-${attempt}`,
                  error: "Remote workspace unreachable: ssh exited with code 255",
                  errorType: "runtime_start_failed",
                });
              }

              // The failed attempts persisted nothing, so the reply takes sequence 2.
              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-reply",
                model: "openai:gpt-5.2",
                historySequence: 2,
                startTime: STABLE_TIMESTAMP - 90000,
                mode: "exec",
              });
              callback({
                type: "stream-delta",
                workspaceId,
                messageId: "assistant-reply",
                delta: RETRY_REPLY_TEXT,
                tokens: 10,
                timestamp: STABLE_TIMESTAMP - 89000,
              });
              callback({
                type: "stream-end",
                workspaceId,
                messageId: "assistant-reply",
                metadata: {
                  historySequence: 2,
                  timestamp: STABLE_TIMESTAMP - 88000,
                  model: "openai:gpt-5.2",
                },
                parts: [{ type: "text", text: RETRY_REPLY_TEXT }],
              });
            }, 50);
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(RETRY_REPLY_TEXT)).toBeVisible(), {
      timeout: 5000,
    });
    await expect(canvas.queryByText("Stream interrupted")).not.toBeInTheDocument();
    await expect(canvas.queryByText(/ssh exited with code 255/)).not.toBeInTheDocument();
  },
};
