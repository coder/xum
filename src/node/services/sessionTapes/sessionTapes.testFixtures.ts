/**
 * Synthetic onChat events for session tape tests: one or more of every event kind the recorder
 * covers, with Dates, undefined usage counts and nested tool payloads. Each event is built
 * through `WorkspaceChatMessageSchema.parse`, so it has the shape the router path delivers.
 * `buildSyntheticSessionTape` turns events into tape text for loader, replay and perf E2E tests.
 * Synthetic only: real tapes hold full chat content and must never become fixtures.
 */
import { hashSessionTapeWorkspaceId } from "./sessionTapeRecorder";
import { RPCJsonSerializer } from "@orpc/client";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  SESSION_TAPE_MASKING,
  SESSION_TAPE_VERSION,
  type SessionTapeHeader,
  type SessionTapeTrailer,
} from "@/common/types/sessionTape";

const createdAt = new Date("2026-05-29T00:00:00.000Z");
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
// Providers can leave token counts empty; the schema keeps such keys with an undefined value.
const sparseUsage = { inputTokens: undefined, outputTokens: 5, totalTokens: undefined };
const mcpServer = {
  connection: { key: "github", transport: "http", origin: "https://mcp.example.com:8443" },
  identity: { name: "GitHub", version: "1.0.0", title: "GitHub MCP" },
  source: "connection",
  iconRef: "0123456789abcdef0123456789abcdef",
  app: { resourceUri: "ui://github/view" },
};
const workflowRun = {
  id: "wfr_123",
  workspaceId: "ws-1",
  workflow: { name: "deep-research", description: "Research", scope: "built-in", executable: true },
  source: "export default async function workflow() { return null; }",
  sourceHash: "sha256:abc123",
  args: { topic: "replay" },
  status: "running",
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
      details: { agentId: "explore" },
    },
  ],
  steps: [],
};
const toolPart = {
  type: "dynamic-tool",
  toolCallId: "call-1",
  toolName: "bash",
  state: "output-available",
  input: { script: "cat Sample.txt", timeout_secs: 30 },
  output: { output: "Sample contents 42", exitCode: 0 },
  mcpServer,
  workflowRun: { runId: "wfr_123", run: workflowRun, timestamp: 2 },
  nestedCalls: [
    {
      toolCallId: "call-1-n",
      toolName: "file_read",
      state: "output-available",
      input: { path: "Sample.md" },
      output: { content: "Sample" },
    },
  ],
};
const userMessage = {
  type: "message",
  id: "msg-user-1",
  role: "user",
  createdAt,
  parts: [
    { type: "text", text: "Sample plan: **ship** it by 2026-10-02 🚀" },
    {
      type: "file",
      url: "data:image/png;base64,U2FtcGxl",
      mediaType: "image/png",
      filename: "Sample.png",
    },
  ],
  metadata: {
    historySequence: 1,
    timestamp: 1,
    muxMetadata: { type: "normal", rawCommand: "/opus+high Sample plan" },
    retrySendOptions: { additionalSystemInstructions: "Sample instructions" },
    agentSkillSnapshot: { skillName: "deep-research", scope: "project", sha256: "abc" },
    mcpPromptSnapshot: { serverName: "github", promptName: "review", commandKey: "github:review" },
  },
};
const assistantMessage = {
  type: "message",
  id: "msg-assistant-1",
  role: "assistant",
  createdAt,
  parts: [
    { type: "reasoning", text: "Sample thought" },
    toolPart,
    { type: "text", text: "Sample" },
  ],
  metadata: {
    historySequence: 2,
    model: "anthropic:claude-opus-5-5",
    usage,
    providerMetadata: { anthropic: { cacheCreationInputTokens: 3 } },
    compacted: "user",
    error: "Sample failure",
    errorType: "unknown",
  },
};
const review = {
  filePath: "src/app.ts",
  lineRange: "1-2",
  selectedCode: "const Sample = 1;",
  userNote: "Sample note",
};

const RAW_EVENTS: unknown[] = [
  { type: "message-batch", messages: [userMessage, assistantMessage] },
  userMessage,
  {
    type: "caught-up",
    replay: "full",
    historyReplayStatus: "complete",
    windowSeed: {
      todos: [{ content: "Sample todo", status: "pending" }],
      assistedReview: [{ path: "src/app.ts", comment: "Sample comment" }],
    },
  },
  { type: "heartbeat" },
  {
    type: "runtime-status",
    workspaceId: "ws-1",
    phase: "starting",
    runtimeType: "worktree",
    detail: "Sample status",
  },
  {
    type: "stream-start",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    model: "anthropic:claude-opus-5-5",
    historySequence: 3,
    startTime: 1,
    muxMetadata: {
      type: "compaction-request",
      rawCommand: "/compact Sample focus",
      parsed: { followUpContent: { text: "Sample follow-up" } },
    },
  },
  {
    type: "reasoning-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    delta: "Sample",
    tokens: 1,
    timestamp: 1,
    signature: "sig-1",
  },
  {
    type: "stream-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    delta: "Sample `code`",
    tokens: 2,
    timestamp: 2,
  },
  {
    type: "tool-call-start",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    args: { script: "Sample" },
    tokens: 3,
    timestamp: 3,
  },
  {
    type: "tool-call-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    delta: '{"script":"Sample',
    tokens: 1,
    timestamp: 3,
  },
  {
    type: "bash-output",
    workspaceId: "ws-1",
    toolCallId: "call-1",
    text: "Sample line\n",
    isError: false,
    timestamp: 4,
  },
  {
    type: "tool-call-end",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    result: { output: "Sample", exitCode: 0 },
    mcpServer,
    timestamp: 5,
  },
  {
    type: "workflow-run-attached",
    workspaceId: "ws-1",
    toolCallId: "call-1",
    runId: "wfr_123",
    run: workflowRun,
    timestamp: 5,
  },
  {
    type: "usage-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    usage: sparseUsage,
    providerMetadata: { openai: { responseId: "resp_1" } },
    cumulativeUsage: usage,
    cumulativeProviderMetadata: { openai: { responseId: "resp_1" } },
  },
  {
    type: "stream-end",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    metadata: {
      model: "anthropic:claude-opus-5-5",
      usage,
      historySequence: 3,
      muxMetadata: { type: "agent-skill", rawCommand: "/review Sample", arguments: "Sample" },
    },
    parts: [{ type: "text", text: "Sample answer" }, toolPart],
  },
  {
    type: "stream-error",
    messageId: "msg-assistant-3",
    error: "Sample error",
    errorType: "unknown",
  },
  { type: "init-output", line: "Sample hook output", timestamp: 6 },
  { type: "init-progress", label: "Sample filter", percent: 50, timestamp: 6 },
  {
    type: "queued-message-changed",
    workspaceId: "ws-1",
    queuedMessages: ["Sample queued"],
    displayText: "Sample queued",
    fileParts: [{ url: "data:image/png;base64,U2FtcGxl", mediaType: "image/png" }],
    reviews: [review],
  },
  { type: "restore-to-input", workspaceId: "ws-1", text: "Sample restore", reviews: [review] },
  {
    type: "held-inputs-changed",
    workspaceId: "ws-1",
    heldInputs: [
      {
        id: "held-1",
        reason: "interrupted",
        displayText: "Sample",
        attachmentCount: 0,
        reviewCount: 0,
      },
    ],
  },
  { type: "auto-retry-abandoned", reason: "rate_limit" },
  { type: "delete", historySequences: [1] },
];

/** Synthetic wire events covering history, tool, usage, workflow, snapshot and queue events. */
export function syntheticChatEvents(): WorkspaceChatMessage[] {
  return RAW_EVENTS.map((event) => WorkspaceChatMessageSchema.parse(event));
}

/**
 * A coherent synthetic transcript as one full-replay onChat subscription delivers it: history
 * (a batch and a single row), caught-up, then a live turn with reasoning, text and a tool call,
 * and a delete. Events carry `workspaceId` verbatim, like recorded ones.
 */
export function syntheticReplayTranscript(workspaceId: string): WorkspaceChatMessage[] {
  const messageId = "msg-assistant-live";
  const raw: unknown[] = [
    {
      type: "message-batch",
      messages: [
        {
          type: "message",
          id: "msg-user-1",
          role: "user",
          createdAt,
          parts: [{ type: "text", text: "Sample question" }],
          metadata: { historySequence: 1, timestamp: 1 },
        },
        {
          type: "message",
          id: "msg-assistant-1",
          role: "assistant",
          createdAt,
          parts: [{ type: "text", text: "Sample answer" }],
          metadata: { historySequence: 2, timestamp: 2, model: "anthropic:claude-opus-5-5", usage },
        },
      ],
    },
    {
      type: "message",
      id: "msg-user-2",
      role: "user",
      createdAt,
      parts: [{ type: "text", text: "Sample follow-up" }],
      metadata: { historySequence: 3, timestamp: 3 },
    },
    { type: "caught-up", replay: "full", historyReplayStatus: "complete" },
    {
      type: "stream-start",
      workspaceId,
      messageId,
      model: "anthropic:claude-opus-5-5",
      historySequence: 4,
      startTime: 4,
    },
    {
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: "Sample thought",
      tokens: 1,
      timestamp: 5,
    },
    {
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: "Sample live ",
      tokens: 1,
      timestamp: 6,
    },
    {
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: "call-live",
      toolName: "bash",
      args: { script: "echo Sample" },
      tokens: 1,
      timestamp: 7,
    },
    {
      type: "tool-call-delta",
      workspaceId,
      messageId,
      toolCallId: "call-live",
      toolName: "bash",
      delta: '{"script":"echo Sample"}',
      tokens: 1,
      timestamp: 7,
    },
    {
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId: "call-live",
      toolName: "bash",
      result: { output: "Sample", exitCode: 0 },
      timestamp: 8,
    },
    { type: "stream-delta", workspaceId, messageId, delta: "reply", tokens: 1, timestamp: 9 },
    {
      type: "stream-end",
      workspaceId,
      messageId,
      metadata: { model: "anthropic:claude-opus-5-5", usage, historySequence: 4 },
      parts: [
        { type: "reasoning", text: "Sample thought" },
        { type: "text", text: "Sample live " },
        {
          type: "dynamic-tool",
          toolCallId: "call-live",
          toolName: "bash",
          state: "output-available",
          input: { script: "echo Sample" },
          output: { output: "Sample", exitCode: 0 },
        },
        { type: "text", text: "reply" },
      ],
    },
    { type: "delete", historySequences: [1] },
  ];
  return raw.map((event) => WorkspaceChatMessageSchema.parse(event));
}

export interface SyntheticSessionTapeOptions {
  /** Hashed into the header, like the recorder does. */
  workspaceId?: string;
  /** Recorded offset of event `index` in ms (non-decreasing). Default: 10 ms apart. */
  offsetMs?: (index: number) => number;
  /** Trailer `end` fields; default a complete `closed` tape. */
  end?: Partial<SessionTapeTrailer["end"]>;
}

/**
 * A valid v3 tape (file text) of the given synthetic events, encoded exactly like the recorder
 * (RPC JSON keeping undefined-valued properties, same line layout). Synthetic only.
 */
export function buildSyntheticSessionTape(
  events: WorkspaceChatMessage[] = syntheticChatEvents(),
  options: SyntheticSessionTapeOptions = {}
): string {
  const offsetMs = options.offsetMs ?? ((index: number) => index * 10);
  const serializer = new RPCJsonSerializer({ omitUndefinedProperties: false });
  const header: SessionTapeHeader = {
    tape: SESSION_TAPE_VERSION,
    xumVersion: "synthetic",
    tapeId: "synthetic-tape",
    workspaceIdHash: hashSessionTapeWorkspaceId(options.workspaceId ?? "ws-1"),
    startedAt: "2026-05-29T00:00:00.000Z",
    masking: SESSION_TAPE_MASKING,
    subscription: { batchReplay: true, replayWindow: true, validateOutput: true },
  };
  const lines = [JSON.stringify(header)];
  let lastT = 0;
  events.forEach((event, index) => {
    const encoded = serializer.serialize(event);
    const eventJson = JSON.stringify(encoded.json);
    lastT = offsetMs(index);
    lines.push(
      JSON.stringify({
        t: lastT,
        bytes: Buffer.byteLength(eventJson),
        event: encoded.json,
        ...(encoded.meta ? { meta: encoded.meta } : {}),
      })
    );
  });
  const trailer: SessionTapeTrailer = {
    t: lastT + 1,
    end: { reason: "closed", truncated: false, droppedEvents: 0, ...options.end },
  };
  lines.push(JSON.stringify(trailer));
  return lines.join("\n") + "\n";
}
