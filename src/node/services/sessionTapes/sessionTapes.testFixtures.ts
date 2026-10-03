/**
 * Synthetic onChat events for session tape tests: one or more of every event kind the recorder
 * covers, with Dates, undefined usage counts and nested tool payloads. Each event is built
 * through `WorkspaceChatMessageSchema.parse`, so it has the shape the router path delivers.
 * Synthetic only: real tapes hold full chat content and must never become fixtures.
 */
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

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
  input: { script: "cat Secret.txt", timeout_secs: 30 },
  output: { output: "Secret contents 42", exitCode: 0 },
  mcpServer,
  workflowRun: { runId: "wfr_123", run: workflowRun, timestamp: 2 },
  nestedCalls: [
    {
      toolCallId: "call-1-n",
      toolName: "file_read",
      state: "output-available",
      input: { path: "Secret.md" },
      output: { content: "Secret" },
    },
  ],
};
const userMessage = {
  type: "message",
  id: "msg-user-1",
  role: "user",
  createdAt,
  parts: [
    { type: "text", text: "Secret plan: **ship** it by 2026-10-02 🚀" },
    {
      type: "file",
      url: "data:image/png;base64,U2VjcmV0",
      mediaType: "image/png",
      filename: "Secret.png",
    },
  ],
  metadata: {
    historySequence: 1,
    timestamp: 1,
    muxMetadata: { type: "normal", rawCommand: "/opus+high Secret plan" },
    retrySendOptions: { additionalSystemInstructions: "Secret instructions" },
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
    { type: "reasoning", text: "Secret thought" },
    toolPart,
    { type: "text", text: "Secret" },
  ],
  metadata: {
    historySequence: 2,
    model: "anthropic:claude-opus-5-5",
    usage,
    providerMetadata: { anthropic: { cacheCreationInputTokens: 3 } },
    compacted: "user",
    error: "Secret failure",
    errorType: "unknown",
  },
};
const review = {
  filePath: "src/app.ts",
  lineRange: "1-2",
  selectedCode: "const Secret = 1;",
  userNote: "Secret note",
};

const RAW_EVENTS: unknown[] = [
  { type: "message-batch", messages: [userMessage, assistantMessage] },
  userMessage,
  {
    type: "caught-up",
    replay: "full",
    historyReplayStatus: "complete",
    windowSeed: {
      todos: [{ content: "Secret todo", status: "pending" }],
      assistedReview: [{ path: "src/app.ts", comment: "Secret comment" }],
    },
  },
  { type: "heartbeat" },
  {
    type: "runtime-status",
    workspaceId: "ws-1",
    phase: "starting",
    runtimeType: "worktree",
    detail: "Secret status",
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
      rawCommand: "/compact Secret focus",
      parsed: { followUpContent: { text: "Secret follow-up" } },
    },
  },
  {
    type: "reasoning-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    delta: "Secret",
    tokens: 1,
    timestamp: 1,
    signature: "sig-1",
  },
  {
    type: "stream-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    delta: "Secret `code`",
    tokens: 2,
    timestamp: 2,
  },
  {
    type: "tool-call-start",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    args: { script: "Secret" },
    tokens: 3,
    timestamp: 3,
  },
  {
    type: "tool-call-delta",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    delta: '{"script":"Secret',
    tokens: 1,
    timestamp: 3,
  },
  {
    type: "bash-output",
    workspaceId: "ws-1",
    toolCallId: "call-1",
    text: "Secret line\n",
    isError: false,
    timestamp: 4,
  },
  {
    type: "tool-call-end",
    workspaceId: "ws-1",
    messageId: "msg-assistant-2",
    toolCallId: "call-1",
    toolName: "bash",
    result: { output: "Secret", exitCode: 0 },
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
      muxMetadata: { type: "agent-skill", rawCommand: "/review Secret", arguments: "Secret" },
    },
    parts: [{ type: "text", text: "Secret answer" }, toolPart],
  },
  {
    type: "stream-error",
    messageId: "msg-assistant-3",
    error: "Secret error",
    errorType: "unknown",
  },
  { type: "init-output", line: "Secret hook output", timestamp: 6 },
  { type: "init-progress", label: "Secret filter", percent: 50, timestamp: 6 },
  {
    type: "queued-message-changed",
    workspaceId: "ws-1",
    queuedMessages: ["Secret queued"],
    displayText: "Secret queued",
    fileParts: [{ url: "data:image/png;base64,U2VjcmV0", mediaType: "image/png" }],
    reviews: [review],
  },
  { type: "restore-to-input", workspaceId: "ws-1", text: "Secret restore", reviews: [review] },
  {
    type: "held-inputs-changed",
    workspaceId: "ws-1",
    heldInputs: [
      {
        id: "held-1",
        reason: "interrupted",
        displayText: "Secret",
        attachmentCount: 0,
        reviewCount: 0,
      },
    ],
  },
  { type: "auto-retry-abandoned", reason: "Secret reason" },
  { type: "auto-retry-abandoned", reason: "rate_limit" },
  { type: "delete", historySequences: [1] },
];

/** Synthetic wire events covering history, tool, usage, workflow, snapshot and queue events. */
export function syntheticChatEvents(): WorkspaceChatMessage[] {
  return RAW_EVENTS.map((event) => WorkspaceChatMessageSchema.parse(event));
}
