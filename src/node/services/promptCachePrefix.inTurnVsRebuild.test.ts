/**
 * Prompt-cache prefix contract across a turn boundary (in-turn steps vs the
 * next turn's rebuild from chat.jsonl).
 *
 * Anthropic reuses a cache entry only when request N+1 starts with exactly the
 * bytes request N sent. Inside a turn, the AI SDK builds each step's request by
 * appending the previous step's response messages. The next turn instead
 * rebuilds the whole conversation from persisted history
 * (assemblePromptPayload -> prepareMessagesForProvider). Any byte the in-turn
 * request carried that the persisted rows cannot reproduce (or the reverse)
 * moves the first divergence back into the previous turn, and the next turn
 * re-writes everything after it.
 *
 * Each case runs one real turn through the real StreamManager + real AI SDK
 * Anthropic provider (+ Xum's wire cache-control wrapper) against a scripted
 * SSE fetch, lets StreamManager persist the assistant row to a real
 * HistoryService, appends the next trigger row (a bash-monitor-style wake),
 * rebuilds the next turn's request the production way, and compares the two
 * wire bodies with `cache_control` markers removed.
 *
 * No network: the fetch is local and scripted.
 *
 * The control and the fixed mechanisms are plain tests. Every other case is a repro wrapped in
 * expectReproFailure: it passes while the break still exists, at the pinned divergence index,
 * and fails with "repro passed" once a fix removes it. That makes the fix PR turn the repro into a plain test, so CI keeps each fixed
 * mechanism fixed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool, type Tool } from "ai";
import { z } from "zod";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import { attachModelOnlyToolNotifications } from "@/common/utils/tools/internalToolResultFields";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { HistoryService } from "./historyService";
import { wrapFetchWithAnthropicCacheControl } from "./providerModelFactory";
import { mcpToModelOutput } from "./mcpClient";
import { wrapMCPTools } from "./mcpServerManager";
import { createStreamManagerForTests } from "./streamManager.testHarness";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import { withExecutionScope } from "./tools/withExecutionScope";
import { createTestHistoryService } from "./testHistoryService";
import { expectReproFailure } from "@/node/utils/repro.testHarness";
import { assemblePromptPayload } from "./turnContextAssembler";

const WORKSPACE_ID = "prefix-ws";
const MODEL_STRING = "anthropic:claude-opus-5-5";
const MODEL_ID = "claude-opus-5-5";
const SYSTEM = "You are a test agent.\n".repeat(20);

interface WireBody {
  system?: unknown;
  tools?: unknown;
  messages: unknown[];
}

/** One scripted model step: the SSE events the fake Anthropic API streams back. */
type ScriptedStep = Array<Record<string, unknown>>;
/** A scripted HTTP error reply instead of a step. */
interface ScriptedError {
  status: number;
  message: string;
}

function sse(events: ScriptedStep): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function messageStart(): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
}

function thinkingBlock(index: number, text: string): ScriptedStep {
  return [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
    {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: `sig-${text}` },
    },
    { type: "content_block_stop", index },
  ];
}

function textBlock(index: number, text: string): ScriptedStep {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
}

function toolUseBlock(index: number, id: string, name: string, input: unknown): ScriptedStep {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index },
  ];
}

function finish(stopReason: "tool_use" | "end_turn"): ScriptedStep {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

/** A turn that thinks, calls `tool` once, then answers in text. */
function toolThenTextTurn(toolName: string, toolCallId: string): ScriptedStep[] {
  return [
    [
      messageStart(),
      ...thinkingBlock(0, `plan-${toolCallId}`),
      ...textBlock(1, "Let me check."),
      ...toolUseBlock(2, toolCallId, toolName, { script: "echo hi" }),
      ...finish("tool_use"),
    ],
    [
      messageStart(),
      ...thinkingBlock(0, `done-${toolCallId}`),
      ...textBlock(1, "All done."),
      ...finish("end_turn"),
    ],
  ];
}

/**
 * Scripted Anthropic Messages endpoint. Records every request body after Xum's
 * wire cache-control wrapper, i.e. the bytes Anthropic hashes for caching.
 */
function createScriptedAnthropic() {
  const bodies: WireBody[] = [];
  let queue: Array<ScriptedStep | ScriptedError> = [];
  const baseFetch = ((_input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as WireBody);
    const step = queue.shift();
    if (step == null) throw new Error("scripted anthropic: no step left");
    if (!Array.isArray(step)) {
      const error = { type: "invalid_request_error", message: step.message };
      return Promise.resolve(
        new Response(JSON.stringify({ type: "error", error }), {
          status: step.status,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response(sse(step), { status: 200, headers: { "content-type": "text/event-stream" } })
    );
  }) as unknown as typeof fetch;
  const provider = createAnthropic({
    apiKey: "test-key",
    baseURL: "http://scripted.invalid/v1",
    fetch: wrapFetchWithAnthropicCacheControl(baseFetch, "1h"),
  });
  return {
    model: provider(MODEL_ID),
    bodies,
    script(steps: Array<ScriptedStep | ScriptedError>) {
      queue = [...steps];
    },
  };
}

/** Drop cache markers: only their position moves between requests, by design. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, entry]) => [key, withoutCacheControl(entry)])
    );
  }
  return value;
}

/**
 * Index of the first `messages` entry where `next` stops repeating `previous`
 * (byte-wise JSON, cache markers removed), or -1 when `previous` is a prefix.
 */
const MONITOR_WAKE = "[bash monitor] The background job finished.";

/**
 * True when `next` ends with a message carrying `text` that `previous` never sent. Once the
 * prefix matches, that message must come after every message of `previous`. This holds while a
 * break shortens the rebuilt list too (merged steps, coalesced polls).
 */
function sendsAfter(previous: WireBody, next: WireBody, text: string): boolean {
  return (
    !JSON.stringify(previous.messages).includes(text) &&
    JSON.stringify(next.messages.at(-1) ?? null).includes(text)
  );
}

/** The next turn's first request ends with the previous answer (assistant text), then the trigger. */
function endsWithAnswerThenTrigger(next: WireBody): boolean {
  const answer = next.messages.at(-2) as { role?: unknown; content?: unknown } | undefined;
  return (
    answer?.role === "assistant" &&
    Array.isArray(answer.content) &&
    answer.content.some((block) => (block as { type?: unknown }).type === "text")
  );
}

function firstPrefixDivergence(previous: WireBody, next: WireBody): number {
  const a = previous.messages.map((m) => JSON.stringify(withoutCacheControl(m)));
  const b = next.messages.map((m) => JSON.stringify(withoutCacheControl(m)));
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return index;
  }
  return -1;
}

let historyService: HistoryService;
let cleanup: () => Promise<void>;
let nextSequence = 0;

beforeEach(async () => {
  ({ historyService, cleanup } = await createTestHistoryService());
  nextSequence = 0;
});

afterEach(async () => {
  await cleanup();
});

async function appendUser(text: string, extra?: Partial<MuxMessage["metadata"]>): Promise<void> {
  const message = createMuxMessage(`user-${nextSequence}`, "user", text, {
    timestamp: 1_000 + nextSequence,
    ...extra,
  });
  const result = await historyService.appendToHistory(WORKSPACE_ID, message);
  if (!result.success) throw new Error(result.error);
  nextSequence = (message.metadata?.historySequence ?? nextSequence) + 1;
}

async function readHistory(): Promise<MuxMessage[]> {
  const result = await historyService.getHistoryFromLatestBoundary(WORKSPACE_ID);
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/**
 * Run one turn the production way: rebuild the request from persisted history,
 * stream it through StreamManager (which persists the assistant row), and
 * return the wire body of every provider step this turn sent.
 */
async function runTurn(
  anthropic: ReturnType<typeof createScriptedAnthropic>,
  tools: Record<string, Tool>,
  steps: Array<ScriptedStep | ScriptedError>,
  /** Volatile system tail (hot memories, MCP warning, context-window ids) after SYSTEM. */
  volatileTail = "",
  /** Tool search: the advertised tool set changes when a step activates a deferred tool. */
  toolSearchState?: ToolSearchStreamState,
  /** Runs after the request read history and before the assistant row is appended. */
  beforePlaceholder?: () => Promise<void>
): Promise<WireBody[]> {
  const history = await readHistory();
  // As turnRequestBuilder records it: the highest history row the request includes.
  const requestHistorySequence = Math.max(
    -1,
    ...history.map((row) => row.metadata?.historySequence ?? -1)
  );
  const payload = await assemblePromptPayload({
    history,
    systemMessage: SYSTEM + volatileTail,
    volatileSystemSuffixLength: volatileTail.length,
    tools,
    modelString: MODEL_STRING,
    routeProvider: "anthropic",
    providerForMessages: "anthropic",
    effectiveThinkingLevel: "high",
    effectiveAgentId: "exec",
    toolNamesForSentinel: Object.keys(tools).sort(),
    anthropicCacheTtl: "1h",
    workspaceId: WORKSPACE_ID,
  });
  await beforePlaceholder?.();
  const messageId = `assistant-${nextSequence}`;
  const historySequence = nextSequence;
  const placeholder = await historyService.appendToHistory(WORKSPACE_ID, {
    id: messageId,
    role: "assistant",
    metadata: { historySequence, partial: true, model: MODEL_STRING },
    parts: [],
  });
  if (!placeholder.success) throw new Error(placeholder.error);
  nextSequence = historySequence + 1;

  const streamManager = createStreamManagerForTests(historyService, {
    toolCallDisplayRegistry: displayRegistry,
  });
  const before = anthropic.bodies.length;
  anthropic.script(steps);
  // As turnRequestBuilder does: the tools carry the stream's scope, so MCP wrappers can publish
  // the display data that StreamManager persists as `mcpServer`.
  const streamToken = streamManager.generateStreamToken();
  const executionScope = { workspaceId: WORKSPACE_ID, messageId, token: streamToken };
  const started = await streamManager.startStream({
    workspaceId: WORKSPACE_ID,
    messageId,
    model: anthropic.model,
    modelString: MODEL_STRING,
    messages: payload.messages,
    system: payload.system,
    tools: payload.tools && withExecutionScope(payload.tools, executionScope),
    providedStreamToken: streamToken,
    executionScope,
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    historySequence,
    initialMetadata: { requestHistorySequence },
    thinkingLevel: "high",
    // TurnRequestBuilder puts the assembler's tail record on the turn's assistant row.
    ...(payload.volatileSystemTail != null
      ? { initialMetadata: { volatileSystemTail: payload.volatileSystemTail } }
      : {}),
    toolSearchState,
    runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
    providedRuntimeTempDir: "",
  });
  if (!started.success) throw new Error(JSON.stringify(started.error));
  await started.data.completion;
  const bodies = anthropic.bodies.slice(before);
  // The comparisons below strip cache markers, so first check that Xum still marks the
  // conversation for caching: without that marker no history is cached at all.
  for (const body of bodies) expect(hasConversationBreakpoint(body)).toBe(true);
  return bodies;
}

function hasConversationBreakpoint(body: WireBody): boolean {
  const last = body.messages.at(-1) as { content?: unknown } | undefined;
  const lastBlock = Array.isArray(last?.content) ? (last.content.at(-1) as unknown) : undefined;
  return lastBlock != null && typeof lastBlock === "object" && "cache_control" in lastBlock;
}

/**
 * The contract: the next turn's first request repeats the previous turn's LAST
 * step request (system, tools and every message), then appends.
 */
async function expectNextTurnExtendsLastStep(params: {
  tools: Record<string, Tool>;
  firstTurn: ScriptedStep[];
}): Promise<void> {
  const anthropic = createScriptedAnthropic();
  await appendUser("Start the job and wait for it.");
  const firstTurnBodies = await runTurn(anthropic, params.tools, params.firstTurn);
  expect(firstTurnBodies.length).toBe(params.firstTurn.length);
  // A monitor wake: the next trigger is one appended user row, nothing else changes.
  await appendUser(MONITOR_WAKE);
  const [nextFirst] = await runTurn(
    anthropic,
    params.tools,
    toolThenTextTurn("probe", "call-next")
  );
  expectExtendsLastStep(firstTurnBodies[firstTurnBodies.length - 1], nextFirst, MONITOR_WAKE);
}

/**
 * `body` without a trailing system row: a volatile-tail change goes after the trigger as a
 * mid-conversation system row (mechanism 10), and the checks below look at the conversation.
 */
function withoutTrailingSystemRow(body: WireBody): WireBody {
  const last = body.messages.at(-1) as { role?: unknown } | undefined;
  return last?.role === "system" ? { ...body, messages: body.messages.slice(0, -1) } : body;
}

/** The contract for one turn boundary: `nextFirst` repeats `lastStep`, then sends `trigger`. */
function expectExtendsLastStep(lastStep: WireBody, sentFirst: WireBody, trigger: string): void {
  const nextFirst = withoutTrailingSystemRow(sentFirst);
  expect(withoutCacheControl(nextFirst.system)).toEqual(withoutCacheControl(lastStep.system));
  expect(withoutCacheControl(nextFirst.tools)).toEqual(withoutCacheControl(lastStep.tools));
  // A request that dropped the new trigger would match the previous one exactly, so check it
  // is sent after the previous request's messages before checking the prefix.
  expect(sendsAfter(lastStep, nextFirst, trigger)).toBe(true);
  // The previous turn's final answer must precede the trigger: a rebuild that lost it would
  // still repeat every earlier message and end with the trigger.
  expect(endsWithAnswerThenTrigger(nextFirst)).toBe(true);
  // Target assertion: the index of the first message the next turn changed (-1 = none).
  expect(firstPrefixDivergence(lastStep, nextFirst)).toBe(-1);
}

/**
 * Each repro below states the CORRECT contract and fails today at its target assertion, at the
 * first diverging index given here. expectReproFailure passes only on that exact mismatch, so a
 * repro broken elsewhere fails instead of passing. When a fix lands, the repro fails with "repro
 * passed": the fix PR unwraps it into a plain test.
 */
const divergesAt = (index: number) => ({
  matcher: "toBe",
  expected: "-1",
  received: String(index),
});

/** Display data the real MCP wrapper publishes for each call; runTurn's StreamManager reads it. */
const displayRegistry = new ToolCallDisplayRegistry();

/**
 * An MCP tool as mcpServerManager builds it: the client's raw tool (mcpToModelOutput) inside
 * the real wrapMCPTools, optionally inside the model-only notification wrapper of tools.ts.
 */
function mcpTool(name: string, notes: string[] = []): Tool {
  const raw = tool({
    description: `${name} tool`,
    inputSchema: z.object({ script: z.string() }),
    execute: () =>
      Promise.resolve({ content: [{ type: "text", text: "page body" }], isError: false }),
    toModelOutput: mcpToModelOutput,
  });
  const wrapped = wrapMCPTools(
    { [name]: raw },
    {
      display: {
        connection: { key: "notion", transport: "http", origin: "https://mcp.example.com" },
        identity: { name: "Notion MCP", version: "1.0.0" },
        registry: displayRegistry,
      },
    }
  )[name];
  const execute = wrapped.execute;
  if (execute === undefined) throw new Error("expected an executable MCP tool");
  const reminded: Tool = {
    ...wrapped,
    execute: async (input, options) =>
      attachModelOnlyToolNotifications(await execute(input, options), notes),
  };
  return reminded;
}

const plainTool = (name: string) =>
  tool({
    description: `${name} tool`,
    inputSchema: z.object({ script: z.string() }),
    execute: () => Promise.resolve({ success: true, output: "hi" }),
  });

describe("prompt-cache prefix: next turn vs the previous turn's last step", () => {
  // A sub-agent report (TaskService appends it to the parent's history at once) can land after
  // the request read history but before the assistant row is appended. It then sorts before
  // that row, although the turn never saw it. Seen live on the dogfood server (f5714aa3af,
  // 2026-10-14): the next turn rebuilt the earlier user message with the report merged in, and
  // Anthropic rejected the turn's thinking ("Content before this block differs").
  test("a row appended while the request was being built keeps the prefix", async () => {
    const anthropic = createScriptedAnthropic();
    const tools = { bash: plainTool("bash"), probe: plainTool("probe") };
    await appendUser("Start the job and wait for it.");
    const firstTurnBodies = await runTurn(
      anthropic,
      tools,
      toolThenTextTurn("bash", "call-1"),
      "",
      undefined,
      () => appendUser("<mux_subagent_report>done</mux_subagent_report>", { synthetic: true })
    );
    await appendUser(MONITOR_WAKE);
    const [nextFirst] = await runTurn(anthropic, tools, toolThenTextTurn("probe", "call-next"));
    expectExtendsLastStep(firstTurnBodies[firstTurnBodies.length - 1], nextFirst, MONITOR_WAKE);
    // The model reads the report after its own reply, where it arrived.
    expect(JSON.stringify(nextFirst.messages.at(-1))).toContain("mux_subagent_report");
  });

  test("control: a plain tool round trip keeps the prefix", async () => {
    await expectNextTurnExtendsLastStep({
      tools: { bash: plainTool("bash"), probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("bash", "call-1"),
    });
  });

  // tools.ts wrapToolsWithModelOnlyNotifications (TodoListReminderSource on the 5th, 15th, ...
  // tool call while todos are open; HomeClutterReminderSource once per turn) attaches
  // `__mux_notifications` to the result the model sees in-turn. StreamManager keeps the notes
  // beside the persisted output (modelOnlyNotifications), and the rebuild puts them back, so
  // the next turn repeats the tool_result bytes the in-turn step sent. Before that, the changed
  // tool_result also made Anthropic reject every later thinking block of the row ("Content
  // before this block differs"): the most frequent rejection on the dogfood server.
  test("model-only tool notifications keep the prefix", async () => {
    const reminded = tool({
      description: "bash tool",
      inputSchema: z.object({ script: z.string() }),
      execute: () =>
        Promise.resolve(
          attachModelOnlyToolNotifications({ success: true, output: "hi" }, [
            "<notification>\nIt's been 5 tool calls since you last updated the TODO list.\n</notification>",
          ])
        ),
    });
    await expectNextTurnExtendsLastStep({
      tools: { bash: reminded, probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("bash", "call-1"),
    });
  });

  // mcpClient.ts gives every MCP tool a toModelOutput (mcpToModelOutput) that turns the
  // CallToolResult into `content` text parts in-turn. The rebuild used to call
  // convertToModelMessages without tools, so the persisted output replayed through the SDK's
  // default JSON encoding instead. It now applies mcpToModelOutput to every persisted part with
  // `mcpServer` (the display snapshot the real MCP wrapper publishes), so the bytes match.
  test("MCP toModelOutput results keep the prefix", async () => {
    await expectNextTurnExtendsLastStep({
      tools: { notion_fetch: mcpTool("notion_fetch"), probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("notion_fetch", "call-1"),
    });
  });

  // The model-only notes (#6658) ride on the MCP result too. In-turn, mcpToModelOutput reads
  // only `content`, so the notes never reach the model. The rebuild re-attaches them before the
  // same conversion, which must drop them the same way.
  test("MCP results with model-only notifications keep the prefix", async () => {
    const reminded = mcpTool("notion_fetch", [
      "<notification>\nIt's been 5 tool calls since you last updated the TODO list.\n</notification>",
    ]);
    await expectNextTurnExtendsLastStep({
      tools: { notion_fetch: reminded, probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("notion_fetch", "call-1"),
    });
  });

  // The rebuild (applyToolOutputRedaction) used to cut every string over 12,000 chars while
  // in-turn steps sent the tool's full string, so a long file_read/bash/memory/web_fetch result
  // changed bytes at the next turn. Both paths now run sanitizeUnknownForProviderOutput, which
  // keeps the full length.
  test("tool results with a string over 12,000 chars keep the prefix", async () => {
    const bigRead = tool({
      description: "file_read tool",
      inputSchema: z.object({ script: z.string() }),
      execute: () => Promise.resolve({ success: true, content: "line\n".repeat(2_600) }),
    });
    await expectNextTurnExtendsLastStep({
      tools: { file_read: bigRead, probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("file_read", "call-1"),
    });
  });

  // Binary-like text (NUL, U+FFFD, dense control characters) is redacted in both paths, so the
  // in-turn step sends the same redaction the next turn's rebuild does.
  test("binary-like tool results keep the prefix", async () => {
    const binaryRead = tool({
      description: "bash tool",
      inputSchema: z.object({ script: z.string() }),
      execute: () =>
        Promise.resolve({ success: true, output: "PNG\u0000\u0001\ufffd\u001b[0m body" }),
    });
    const anthropic = createScriptedAnthropic();
    await appendUser("Start the job and wait for it.");
    const [, afterTool] = await runTurn(
      anthropic,
      { bash: binaryRead },
      toolThenTextTurn("bash", "call-1")
    );
    // The in-turn step after the tool call already carries the redaction, not the raw bytes.
    const sent = JSON.stringify(afterTool.messages);
    expect(sent).toContain("[redacted binary-like provider-output;");
    expect(sent).not.toContain("\\u0000");
    await expectNextTurnExtendsLastStep({
      tools: { bash: binaryRead, probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("bash", "call-2"),
    });
  });

  // modelMessageTransform.ts coalesceConsecutiveNoProgressTaskAwaitPairs keeps only the
  // last of consecutive identical no-progress task_await polls. It runs in the rebuild
  // (transformModelMessages) but not on in-turn steps (StreamManager transformStepMessages),
  // so the polls the previous turn sent one by one vanish from the next turn's prefix.
  // Only polls without a thinking block qualify (the pair's assistant must hold just the call).
  test("repeated no-progress task_await polls keep the prefix", async () => {
    const taskAwait = tool({
      description: "task_await tool",
      inputSchema: z.object({ task_ids: z.array(z.string()) }),
      execute: () => Promise.resolve({ results: [{ taskId: "t1", status: "running" }] }),
    });
    const poll = (id: string): ScriptedStep => [
      messageStart(),
      ...toolUseBlock(0, id, "task_await", { task_ids: ["t1"] }),
      ...finish("tool_use"),
    ];
    await expectReproFailure(
      () =>
        expectNextTurnExtendsLastStep({
          tools: { task_await: taskAwait, probe: plainTool("probe") },
          firstTurn: [
            poll("call-1"),
            poll("call-2"),
            [messageStart(), ...textBlock(0, "Still waiting."), ...finish("end_turn")],
          ],
        }),
      divergesAt(1)
    );
  });

  // StreamManager persists step boundaries only as `metadata.stepStartPartIndices`, and
  // convertToModelMessages starts a new assistant message only at a `step-start` part. Without
  // insertStepStartPartsForSdk, a step that opens with a tool call (no thinking block, no text;
  // common with adaptive thinking) folded into the previous step's tool_use block: two
  // sequential calls replayed as one parallel call and the prefix diverged at message 1.
  test("a step that opens with a tool call keeps its own assistant message", async () => {
    await expectNextTurnExtendsLastStep({
      tools: { bash: plainTool("bash"), probe: plainTool("probe") },
      firstTurn: [
        [
          messageStart(),
          ...textBlock(0, "First."),
          ...toolUseBlock(1, "call-1", "bash", { script: "a" }),
          ...finish("tool_use"),
        ],
        [
          messageStart(),
          ...toolUseBlock(0, "call-2", "bash", { script: "b" }),
          ...finish("tool_use"),
        ],
        [messageStart(), ...textBlock(0, "Done."), ...finish("end_turn")],
      ],
    });
  });

  // A thrown tool error reaches the in-turn step as an AI SDK tool-error
  // (`is_error: true`, "Error: <message>"). StreamManager persists it as
  // `{ success: false, error }`, which the rebuild replays as a normal JSON result.
  test("a tool that throws replays the same error result", async () => {
    const failing = tool({
      description: "bash tool",
      inputSchema: z.object({ script: z.string() }),
      execute: (): Promise<{ success: boolean }> => Promise.reject(new Error("boom")),
    });
    await expectReproFailure(
      () =>
        expectNextTurnExtendsLastStep({
          tools: { bash: failing, probe: plainTool("probe") },
          firstTurn: toolThenTextTurn("bash", "call-1"),
        }),
      divergesAt(2)
    );
  });

  // In-turn, StreamManager's transformStepMessages
  // (extractToolMediaAsUserMessagesFromModelMessages) puts the extracted image right after
  // the tool result of that step. The rebuild's extractToolMediaAsUserMessages works on
  // whole MuxMessages and appends the synthetic attachment row after the assistant row, so
  // the image moves behind the turn's final text and merges into the NEXT user message.
  test("attach_file media stays where the in-turn step put it", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const attachFile = tool({
      description: "attach_file tool",
      inputSchema: z.object({ script: z.string() }),
      execute: () =>
        Promise.resolve({
          type: "content",
          value: [
            { type: "text", text: "[Attachment prepared: a.png]" },
            { type: "media", data: png, mediaType: "image/png", filename: "a.png" },
          ],
        }),
    });
    await expectReproFailure(
      () =>
        expectNextTurnExtendsLastStep({
          tools: { attach_file: attachFile, probe: plainTool("probe") },
          firstTurn: toolThenTextTurn("attach_file", "call-1"),
        }),
      divergesAt(2)
    );
  });
});

/** A turn step that thinks, then calls `toolName`. */
function thinkThenCall(toolCallId: string, toolName: string): ScriptedStep {
  return [
    messageStart(),
    ...thinkingBlock(0, `plan-${toolCallId}`),
    ...toolUseBlock(1, toolCallId, toolName, { script: "echo hi" }),
    ...finish("tool_use"),
  ];
}

function thinkThenAnswer(label: string): ScriptedStep {
  return [
    messageStart(),
    ...thinkingBlock(0, `done-${label}`),
    ...textBlock(1, `Answer ${label}.`),
    ...finish("end_turn"),
  ];
}

/** Thinking texts a wire body replays (Anthropic `thinking` blocks). */
function sentThinking(body: WireBody): string[] {
  return body.messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? content
          .filter((block) => (block as { type?: unknown }).type === "thinking")
          .map((block) => String((block as { thinking?: unknown }).thinking))
      : [];
  });
}

/**
 * Mechanism 11: a thinking-replay receipt (an in-turn strip or a signature repair) used to make
 * every later turn strip all Anthropic thinking of the context segment, while the turn itself
 * kept sending the thinking produced after the strip. Each later turn then rewrote the previous
 * turn's tail. The receipt now records its point, and the rebuild strips only up to it.
 */
describe("prompt-cache prefix: thinking-replay receipt", () => {
  // Core tools, plus deferred tools a step activates: the advertised tool set changes in-turn.
  const deferredTools = ["slack_send", "slack_list"];
  const toolSearchState = (): ToolSearchStreamState => ({
    catalog: deferredTools.map((name) => ({ name, description: name, paramText: "" })),
    deferredToolNames: new Set(deferredTools),
    allToolNames: ["bash", "probe", "activate_send", "activate_list", ...deferredTools],
    activatedToolNames: new Set(),
    native: false,
  });
  const activating = (state: ToolSearchStreamState, name: string) =>
    tool({
      description: `activate ${name}`,
      inputSchema: z.object({ script: z.string() }),
      execute: () => {
        state.activatedToolNames.add(name);
        return Promise.resolve({ success: true, output: "activated" });
      },
    });
  const toolsFor = (state: ToolSearchStreamState): Record<string, Tool> => ({
    bash: plainTool("bash"),
    probe: plainTool("probe"),
    activate_send: activating(state, "slack_send"),
    activate_list: activating(state, "slack_list"),
    slack_send: plainTool("slack_send"),
    slack_list: plainTool("slack_list"),
  });

  /**
   * Runs a thinking turn, then `stripTurn`, then two more turns, and checks both later turn
   * boundaries: the second one fails when the rebuild keeps rewriting older turns.
   */
  async function expectStripTurnKeepsPrefix(params: {
    stripTurn: Array<ScriptedStep | ScriptedError>;
    /** Thinking the strip turn's last step sent after the strip: the rebuild must keep it. */
    keptThinking: string;
    /** Volatile system tail of each of the four turns (default: none). */
    tails?: [string, string, string, string];
  }): Promise<{ receipt: MuxMessage["metadata"]; stripBodies: WireBody[]; laterFirst: WireBody }> {
    const tails = params.tails ?? ["", "", "", ""];
    const state = toolSearchState();
    const tools = toolsFor(state);
    const anthropic = createScriptedAnthropic();
    await appendUser("Start the job and wait for it.");
    await runTurn(
      anthropic,
      tools,
      [thinkThenCall("call-0", "bash"), thinkThenAnswer("0")],
      tails[0],
      state
    );
    await appendUser("Now the next part.");
    const stripBodies = await runTurn(anthropic, tools, params.stripTurn, tails[1], state);
    const stripLast = stripBodies[stripBodies.length - 1];
    // The strip happened: the last step sent no earlier thinking, but kept the newer block.
    expect(sentThinking(stripLast)).toEqual([params.keptThinking]);
    const receipt = (await readHistory()).at(-1)?.metadata;

    await appendUser(MONITOR_WAKE);
    const nextBodies = await runTurn(
      anthropic,
      tools,
      toolThenTextTurn("probe", "call-n"),
      tails[2],
      state
    );
    expectExtendsLastStep(stripLast, nextBodies[0], MONITOR_WAKE);
    const laterWake = "[bash monitor] The second job finished.";
    await appendUser(laterWake);
    const [laterFirst] = await runTurn(
      anthropic,
      tools,
      toolThenTextTurn("probe", "call-l"),
      tails[3],
      state
    );
    expectExtendsLastStep(nextBodies[nextBodies.length - 1], laterFirst, laterWake);
    return { receipt, stripBodies, laterFirst };
  }

  test("an in-turn tool-set change keeps the thinking sent after the strip", async () => {
    // Step 0 activates a deferred tool, so step 1 advertises another tool set and strips
    // every earlier thinking block. Step 1's own block keeps replaying in step 2.
    const { receipt } = await expectStripTurnKeepsPrefix({
      stripTurn: [
        thinkThenCall("call-1", "activate_send"),
        thinkThenCall("call-2", "bash"),
        thinkThenAnswer("1"),
      ],
      keptThinking: "plan-call-2",
    });
    expect(receipt?.anthropicThinkingReplay).toBe("off");
    expect(receipt?.anthropicThinkingReplayFromStep).toBe(1);
  });

  test("volatile-tail rows in the segment keep the receipt's point", async () => {
    // Mechanism 10 rows are request messages, not parts of an assistant row, so they move no
    // part or step index the receipt points at. The strip turn and the last turn each change
    // the hot memories, so each sends a system row after its trigger.
    const hot = (text: string) => `\n\n<hot_memories>\n${text}\n</hot_memories>`;
    const { receipt, stripBodies, laterFirst } = await expectStripTurnKeepsPrefix({
      stripTurn: [
        thinkThenCall("call-1", "activate_send"),
        thinkThenCall("call-2", "bash"),
        thinkThenAnswer("1"),
      ],
      keptThinking: "plan-call-2",
      tails: [hot("A"), hot("B"), hot("B"), hot("C")],
    });
    const systemRows = (body: WireBody) =>
      body.messages.filter((message) => (message as { role?: unknown }).role === "system");
    // The strip turn's row stays in place, before the steps, in its later requests.
    const stripLast = stripBodies[stripBodies.length - 1];
    expect(JSON.stringify(systemRows(stripLast))).toContain("B\\n</hot_memories>");
    expect((stripLast.messages.at(-1) as { role?: unknown }).role).not.toBe("system");
    expect(systemRows(laterFirst)).toHaveLength(2);
    expect(JSON.stringify(laterFirst.messages.at(-1))).toContain("C\\n</hot_memories>");
    expect(receipt?.anthropicThinkingReplayFromStep).toBe(1);
  });

  test("a signature repair at the turn start keeps the thinking produced after it", async () => {
    // The first request is rejected for its replayed thinking. The retry sends no thinking,
    // and every block of this row is bound to that stripped prefix.
    const { receipt } = await expectStripTurnKeepsPrefix({
      stripTurn: [
        {
          status: 400,
          message: "messages.1.content.0: Invalid `signature` in `thinking` block",
        },
        thinkThenCall("call-1", "bash"),
        thinkThenAnswer("1"),
      ],
      keptThinking: "plan-call-1",
    });
    expect(receipt?.anthropicThinkingReplayFromStep).toBe(0);
  });

  test("a second strip in the same turn moves the point forward", async () => {
    // Steps 1 and 2 both see a new tool set. Step 2's strip also removed step 1's block,
    // so the next turn must not put it back.
    const { receipt } = await expectStripTurnKeepsPrefix({
      stripTurn: [
        thinkThenCall("call-1", "activate_send"),
        thinkThenCall("call-2", "activate_list"),
        thinkThenCall("call-3", "bash"),
        thinkThenAnswer("1"),
      ],
      keptThinking: "plan-call-3",
    });
    expect(receipt?.anthropicThinkingReplayFromStep).toBe(2);
  });
});

/** Every cacheable block in Anthropic prefix order: tools, then system blocks, then messages. */
function wireBlocks(body: WireBody): string[] {
  const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : value == null ? [] : [value];
  return [...asArray(body.tools), ...asArray(body.system), ...body.messages].map((block) =>
    JSON.stringify(withoutCacheControl(block))
  );
}

describe("prompt-cache prefix: volatile system tail", () => {
  // turnContextAssembler.ts assemblePromptPayload sends
  // [cachedSystemMessage, ...volatileRows, ...messages]: the uncached volatile tail
  // (hot memories, MCP failure warning, <context_window>) is a system block, and Anthropic
  // puts all system blocks before the conversation. #5260 keeps the STABLE block cached
  // when the tail changes, but every message after the tail still misses, so a tail
  // change re-writes the whole conversation.
  test("a hot-memory change in the volatile tail costs only the tail", async () => {
    await hotMemoryChangeKeepsHistoryCached();
  });
});

async function hotMemoryChangeKeepsHistoryCached(): Promise<void> {
  const anthropic = createScriptedAnthropic();
  const tools = { bash: plainTool("bash") };
  const endTurn: ScriptedStep[] = [[messageStart(), ...textBlock(0, "Ok."), ...finish("end_turn")]];
  await appendUser("First request.");
  const [first] = await runTurn(
    anthropic,
    tools,
    endTurn,
    "\n\n<hot_memories>\nA\n</hot_memories>"
  );
  await appendUser(MONITOR_WAKE);
  const [second] = await runTurn(
    anthropic,
    tools,
    endTurn,
    "\n\n<hot_memories>\nB\n</hot_memories>"
  );

  // A fix may send the new tail as a system row after the trigger: check the conversation
  // without it.
  const conversation = withoutTrailingSystemRow(second);
  expect(sendsAfter(first, conversation, MONITOR_WAKE)).toBe(true);
  // The first turn's answer must precede the trigger: a fix that rebuilt the history without
  // it would still keep the tail-only change below and pass the target assertion.
  expect(endsWithAnswerThenTrigger(conversation)).toBe(true);
  // Each request must send its own hot memories: a fix that dropped the tail or kept "A"
  // would otherwise pass the prefix check below.
  expect(JSON.stringify(first)).toContain("<hot_memories>\\nA\\n</hot_memories>");
  expect(JSON.stringify(second)).toContain("<hot_memories>\\nB\\n</hot_memories>");
  const previous = wireBlocks(first);
  const next = wireBlocks(second);
  const firstChanged = previous.findIndex((block, index) => block !== next[index]);
  // Anthropic reuses the cache up to the first changed block. Contract: only the tail itself
  // may fall outside that prefix. A fix can keep the old tail in place (no change at all) or
  // move it behind the history (the change starts at the tail), and both pass.
  const cachedBlocks = firstChanged < 0 ? previous.length : firstChanged;
  const uncachedNonTailBlocks = previous
    .slice(cachedBlocks)
    .filter((block) => !block.includes("<hot_memories>")).length;
  // Target assertion: today the tail sits before the history, so the user message misses.
  expect(uncachedNonTailBlocks).toBe(0);
}
