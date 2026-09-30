import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { DebugLlmRequestModal } from "@/browser/components/DebugLlmRequestModal/DebugLlmRequestModal";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";

// Rendered OPEN with a mock client seeded with a captured snapshot for this
// workspace (the story triggers the modal via a chat error; here we render it
// directly). The modal fetches the snapshot via api.workspace.getLastLlmRequest
// and JSON.stringifies it — all plain data, no rich renderers.
const WORKSPACE_ID = "ws-debug-request";
const CAPTURED_AT = 1_700_000_000_000;

const SNAPSHOT: DebugLlmRequestSnapshot = {
  capturedAt: CAPTURED_AT - 45000,
  workspaceId: WORKSPACE_ID,
  messageId: "assistant-debug-1",
  model: "anthropic:claude-3-5-sonnet-20241022",
  providerName: "anthropic",
  thinkingLevel: "medium",
  mode: "exec",
  agentId: "exec",
  maxOutputTokens: 2048,
  systemMessage:
    "You are Mux, a focused coding agent. Follow the user's instructions and keep answers short.",
  messages: [
    {
      role: "user",
      content: "We hit a rate limit while refactoring. Summarize the plan and retry.",
    },
    {
      role: "assistant",
      content: "Here's a concise summary and the next steps to resume safely.",
    },
    {
      role: "tool",
      name: "write_summary",
      content: "Summarized 3 tasks, trimmed history, and queued a retry.",
    },
  ],
  response: {
    capturedAt: CAPTURED_AT - 44000,
    metadata: {
      model: "anthropic:claude-3-5-sonnet-20241022",
      usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 },
      duration: 1234,
      systemMessageTokens: 42,
    },
    parts: [
      {
        type: "text",
        text: "Here's a concise summary and the next steps to resume safely.",
        timestamp: CAPTURED_AT - 44000,
      },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "write_summary",
        state: "output-available",
        input: { tasks: 3 },
        output: { ok: true },
        timestamp: CAPTURED_AT - 43950,
      },
    ],
  },
};

export const Open = () => (
  <MuxPreviewShell
    client={createMockORPCClient({
      lastLlmRequestSnapshots: new Map([[WORKSPACE_ID, SNAPSHOT]]),
    })}
  >
    <DebugLlmRequestModal workspaceId={WORKSPACE_ID} open={true} onOpenChange={() => undefined} />
  </MuxPreviewShell>
);
