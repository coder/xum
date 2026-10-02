import { describe, expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { redactChatEvent, redactTapeEvent, UnsupportedTapeRedactionError } from "./redact";

const hash = () => "H";
const lossless = { detectDroppedFields: true };

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

    // As written to the tape: structural Dates stay Dates and serialize to ISO strings.
    expect(JSON.parse(JSON.stringify(redactTapeEvent(event, hash)))).toEqual({
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
          { type: "auto-retry-abandoned", reason: "/home/alice/repo/secret.txt" },
        ],
        hash
      )
    ).toEqual([
      { type: "custom-event", messageId: "m-1", reason: "user-abort", metadata: { id: "x0" } },
      { type: "restore-to-input", reason: "xxx xxxx xxxxxxx 0" },
      { type: "auto-retry-abandoned", reason: "/xxxx/xxxxx/xxxx/xxxxxx.xxx" },
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

  test("restores wire-schema enums the key rules mask, but never free text", () => {
    const events: WorkspaceChatMessage[] = [
      {
        type: "runtime-status",
        workspaceId: "ws-secret",
        phase: "starting",
        runtimeType: "worktree",
        detail: "Starting workspace 1",
      },
      {
        type: "message",
        id: "m-1",
        role: "assistant",
        parts: [{ type: "text", text: "summary" }],
        metadata: { historySequence: 3, compacted: "user" },
      },
    ];
    const redacted = events.map((event) => redactChatEvent(event, hash, lossless));
    for (const event of redacted) {
      expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
    }
    expect(redacted).toEqual([
      {
        type: "runtime-status",
        workspaceId: "H",
        phase: "starting",
        runtimeType: "worktree",
        detail: "xxxxxxxx xxxxxxxxx 0",
      },
      {
        type: "message",
        id: "m-1",
        role: "assistant",
        parts: [{ type: "text", text: "xxxxxxx" }],
        metadata: { historySequence: 3, compacted: "user" },
      },
    ]);
  });

  test("keeps workflow run timestamps valid and masks free-form run payloads", () => {
    const run = {
      id: "wfr_123",
      workspaceId: "ws-secret",
      workflow: {
        name: "deep-research",
        description: "Research a topic",
        scope: "built-in",
        executable: true,
      },
      source: "export default async function workflow() { return 42; }",
      sourceHash: "sha256:abc123",
      args: { topic: "secret topic" },
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
        {
          sequence: 2,
          type: "agent-step",
          at: "2026-05-29T00:00:01.500Z",
          stepId: "reserve-child",
          inputHash: "sha256:reserve-child",
          status: "reserving",
          title: "Reserve child task",
          details: { id: "SECRET", model: "gpt-secret", n: 42 },
        },
      ],
      steps: [],
    };
    const attached = WorkspaceChatMessageSchema.parse({
      type: "workflow-run-attached",
      workspaceId: "ws-secret",
      toolCallId: "call-1",
      runId: "wfr_123",
      run,
      timestamp: 1,
    });
    const part = WorkspaceChatMessageSchema.parse({
      type: "message",
      id: "m-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "workflow_run",
          state: "output-available",
          input: {},
          output: {},
          workflowRun: { runId: "wfr_123", run, timestamp: 1 },
        },
      ],
    });
    for (const [event, runPath] of [
      [attached, (e: unknown) => (e as { run: typeof run }).run],
      [
        part,
        (e: unknown) =>
          (e as { parts: Array<{ workflowRun: { run: typeof run } }> }).parts[0].workflowRun.run,
      ],
    ] as const) {
      const redactedRun = runPath(redactChatEvent(event, hash, lossless));
      expect(redactedRun).toMatchObject({
        createdAt: run.createdAt,
        source: "xxxxxx xxxxxxx xxxxx xxxxxxxx xxxxxxxx() { xxxxxx 00; }",
        events: [
          { at: run.events[0].at, status: "running" },
          { at: run.events[1].at, details: { id: "xxxxxx", model: "xxx-xxxxxx", n: 0 } },
        ],
      });
    }
  });

  test("keeps MCP display references in a valid shape so the schema does not drop them", () => {
    // Recorded events are wire parse output, so build the input the same way.
    const event = WorkspaceChatMessageSchema.parse({
      type: "message",
      id: "m-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "github_search",
          state: "output-available",
          input: { query: "secret" },
          output: { hits: 1 },
          mcpServer: {
            connection: { key: "github", transport: "http", origin: "https://api.github.com" },
            identity: { name: "GitHub", version: "1.0.0", websiteUrl: "https://github.com/org" },
            source: "connection",
            iconRef: "0123456789abcdef0123456789abcdef",
            app: { resourceUri: "ui://github/view" },
          },
        },
      ],
    });
    const redacted = redactChatEvent(event, hash, lossless);
    const parsed = WorkspaceChatMessageSchema.parse(redacted);
    expect(parsed).toMatchObject({
      parts: [
        {
          mcpServer: {
            connection: { key: "xxxxxx", transport: "http", origin: "https://xxx.xxxxxx.xxx" },
            identity: { name: "xxxxxx", version: "0.0.0", websiteUrl: "https://xxxxxx.xxx/xxx" },
            source: "connection",
            iconRef: "0123456789abcdef0123456789abcdef",
            app: { resourceUri: "ui://xxxxxx/xxxx" },
          },
        },
      ],
    });
  });

  test("refuses events it cannot redact into a schema-valid event", () => {
    expect(() =>
      redactChatEvent({ type: "stream-delta", workspaceId: "ws", messageId: "m-1" }, hash, lossless)
    ).toThrow(UnsupportedTapeRedactionError);
  });

  test("keeps structural Dates so history rows with createdAt stay recordable", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const event = WorkspaceChatMessageSchema.parse({
      type: "message",
      id: "m-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      createdAt,
    });
    const redacted = redactChatEvent(event, hash, lossless);
    expect(redacted).toMatchObject({ createdAt, parts: [{ text: "xx" }] });
    expect(JSON.parse(JSON.stringify(redacted))).toMatchObject({
      createdAt: createdAt.toISOString(),
    });
  });

  test("masks cumulative provider metadata even under id/model keys", () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const event = WorkspaceChatMessageSchema.parse({
      type: "usage-delta",
      workspaceId: "ws-secret",
      messageId: "m-1",
      usage,
      cumulativeUsage: usage,
      cumulativeProviderMetadata: { openai: { responseId: "resp_SECRET", modelId: "gpt-x" } },
    });
    expect(redactChatEvent(event, hash, lossless)).toMatchObject({
      usage,
      cumulativeProviderMetadata: {
        openai: { responseId: "xxxx_xxxxxx", modelId: "xxx-x" },
      },
    });
  });
});
