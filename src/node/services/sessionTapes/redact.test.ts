import { describe, expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { redactTapeEvent } from "./redact";

const hash = () => "H";

describe("redactTapeEvent (shape-v1)", () => {
  test("masks letters and digits while keeping UTF-16 length and Markdown structure", () => {
    // é is one letter, 𝐀 is a supplementary-plane letter (two UTF-16 units), 😀 is a symbol.
    const delta = "Héllo, 𝐀b! 😀 42\n# Title\n- `code` [link](https://ex.am/p?q=1)";
    const redacted = redactTapeEvent(
      { type: "stream-delta", messageId: "m-1", delta, tokens: 9, timestamp: 5 },
      hash
    );

    expect(redacted).toEqual({
      type: "stream-delta",
      messageId: "m-1",
      delta: "xxxxx, xxx! 😀 00\n# xxxxx\n- `xxxx` [xxxx](xxxxx://xx.xx/x?x=0)",
      tokens: 9,
      timestamp: 5,
    });
    expect((redacted as { delta: string }).delta.length).toBe(delta.length);
  });

  test("keeps protocol fields on the message structure and masks opaque payloads", () => {
    const event = {
      type: "message",
      id: "msg-1",
      role: "assistant",
      workspaceId: "ws-secret",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      metadata: {
        historySequence: 7,
        model: "anthropic:claude-x",
        timestamp: 1700,
        usage: { inputTokens: 12 },
        providerMetadata: { anthropic: { id: "resp-1", cacheTokens: 5 } },
      },
      parts: [
        { type: "text", text: "Hi 2", state: "done" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "output-available",
          input: { id: "abc", type: "shell", script: "ls 1", timeout: 30 },
          output: { model: "gpt", exitCode: 3, ok: true, lines: ["a", "b"], childWorkspaceId: "c" },
          nestedCalls: [
            {
              toolCallId: "n-1",
              toolName: "file_read",
              state: "input-available",
              input: { path: "/home" },
            },
          ],
        },
      ],
      dropped: undefined,
    };

    expect(redactTapeEvent(event, hash)).toEqual({
      type: "message",
      id: "msg-1",
      role: "assistant",
      workspaceId: "H",
      createdAt: "2026-01-02T03:04:05.000Z",
      metadata: {
        historySequence: 7,
        model: "anthropic:claude-x",
        timestamp: 1700,
        usage: { inputTokens: 12 },
        providerMetadata: { anthropic: { id: "xxxx-0", cacheTokens: 0 } },
      },
      parts: [
        { type: "text", text: "xx 0", state: "done" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "output-available",
          input: { id: "xxx", type: "xxxxx", script: "xx 0", timeout: 0 },
          output: { model: "xxx", exitCode: 0, ok: true, lines: ["x", "x"], childWorkspaceId: "H" },
          nestedCalls: [
            {
              toolCallId: "n-1",
              toolName: "file_read",
              state: "input-available",
              input: { path: "/xxxx" },
            },
          ],
        },
      ],
    });
  });

  test("keeps enum-like tokens but masks free text and non-message metadata", () => {
    expect(
      redactTapeEvent(
        [
          { type: "custom-event", messageId: "m-1", reason: "user-abort", metadata: { id: "x1" } },
          { type: "restore-to-input", reason: "the user stopped 2" },
        ],
        hash
      )
    ).toEqual([
      { type: "custom-event", messageId: "m-1", reason: "user-abort", metadata: { id: "x0" } },
      { type: "restore-to-input", reason: "xxx xxxx xxxxxxx 0" },
    ]);
  });

  test("redacted stream events still satisfy the onChat schema with protocol metadata intact", () => {
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    const events: WorkspaceChatMessage[] = [
      {
        type: "stream-end",
        workspaceId: "ws-secret",
        messageId: "m-1",
        metadata: {
          model: "anthropic:claude-x",
          agentId: "exec",
          thinkingLevel: "high",
          usage,
          finishReason: "stop",
          duration: 1234,
          historySequence: 42,
          providerMetadata: { anthropic: { cacheCreationInputTokens: 7 } },
          autoModelRouting: {
            requestedFallbackModel: "anthropic:claude-y",
            model: "anthropic:claude-x",
            thinkingLevel: "medium",
            escalations: [{ step: 2, from: "medium", to: "high", reason: "looked stuck 3" }],
            status: "routed",
          },
        },
        parts: [{ type: "text", text: "Done 1" }],
      },
      {
        type: "stream-abort",
        workspaceId: "ws-secret",
        messageId: "m-2",
        abortReason: "user",
        metadata: { model: "anthropic:claude-x", usage, duration: 50 },
      },
      {
        type: "stream-lifecycle",
        workspaceId: "ws-secret",
        phase: "interrupted",
        hadAnyOutput: true,
        abortReason: "startup",
      },
      {
        type: "caught-up",
        replay: "full",
        historyReplayStatus: "complete",
        downgradeReason: "cursor-row-missing",
      },
    ];

    const parsed = events.map((event) =>
      WorkspaceChatMessageSchema.parse(redactTapeEvent(event, hash))
    );

    expect(parsed).toMatchObject([
      {
        workspaceId: "H",
        metadata: {
          model: "anthropic:claude-x",
          agentId: "exec",
          thinkingLevel: "high",
          usage,
          finishReason: "stop",
          duration: 1234,
          historySequence: 42,
          // Provider metadata stays an opaque payload.
          providerMetadata: { anthropic: { cacheCreationInputTokens: 0 } },
          autoModelRouting: {
            requestedFallbackModel: "anthropic:claude-y",
            escalations: [{ step: 2, from: "medium", to: "high", reason: "xxxxxx xxxxx 0" }],
          },
        },
        parts: [{ type: "text", text: "xxxx 0" }],
      },
      { abortReason: "user", metadata: { model: "anthropic:claude-x", usage, duration: 50 } },
      { phase: "interrupted", abortReason: "startup" },
      { downgradeReason: "cursor-row-missing" },
    ]);
  });
});
