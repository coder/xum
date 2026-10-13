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
import { attachModelOnlyToolNotifications } from "@/common/utils/tools/internalToolResultFields";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { HistoryService } from "./historyService";
import { wrapFetchWithAnthropicCacheControl } from "./providerModelFactory";
import { createStreamManagerForTests } from "./streamManager.testHarness";
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
  let queue: ScriptedStep[] = [];
  const baseFetch = ((_input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as WireBody);
    const step = queue.shift();
    if (step == null) throw new Error("scripted anthropic: no step left");
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
    script(steps: ScriptedStep[]) {
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
  steps: ScriptedStep[],
  /** Volatile system tail (hot memories, MCP warning, context-window ids) after SYSTEM. */
  volatileTail = ""
): Promise<WireBody[]> {
  const history = await readHistory();
  const payload = await assemblePromptPayload({
    history,
    systemMessage: SYSTEM + volatileTail,
    volatileSystemSuffixLength: volatileTail.length,
    tools,
    modelString: MODEL_STRING,
    providerForMessages: "anthropic",
    effectiveThinkingLevel: "high",
    effectiveAgentId: "exec",
    toolNamesForSentinel: Object.keys(tools).sort(),
    anthropicCacheTtl: "1h",
    workspaceId: WORKSPACE_ID,
  });
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

  const streamManager = createStreamManagerForTests(historyService);
  const before = anthropic.bodies.length;
  anthropic.script(steps);
  const started = await streamManager.startStream({
    workspaceId: WORKSPACE_ID,
    messageId,
    model: anthropic.model,
    modelString: MODEL_STRING,
    messages: payload.messages,
    system: payload.system,
    tools: payload.tools,
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    historySequence,
    thinkingLevel: "high",
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
  const lastStep = firstTurnBodies[firstTurnBodies.length - 1];

  expect(withoutCacheControl(nextFirst.system)).toEqual(withoutCacheControl(lastStep.system));
  expect(withoutCacheControl(nextFirst.tools)).toEqual(withoutCacheControl(lastStep.tools));
  // A request that dropped the new trigger would match the previous one exactly, so check it
  // is sent after the previous request's messages before checking the prefix.
  expect(sendsAfter(lastStep, nextFirst, MONITOR_WAKE)).toBe(true);
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

const plainTool = (name: string) =>
  tool({
    description: `${name} tool`,
    inputSchema: z.object({ script: z.string() }),
    execute: () => Promise.resolve({ success: true, output: "hi" }),
  });

describe("prompt-cache prefix: next turn vs the previous turn's last step", () => {
  test("control: a plain tool round trip keeps the prefix", async () => {
    await expectNextTurnExtendsLastStep({
      tools: { bash: plainTool("bash"), probe: plainTool("probe") },
      firstTurn: toolThenTextTurn("bash", "call-1"),
    });
  });

  // tools.ts wrapToolsWithModelOnlyNotifications (TodoListReminderSource on the 5th, 15th, ...
  // tool call while todos are open; HomeClutterReminderSource once per turn) attaches
  // `__mux_notifications` to the result the model sees in-turn; StreamManager strips the
  // field before persisting (stripInternalToolResultFields), so the next turn's rebuild
  // cannot repeat the tool_result bytes the in-turn step sent.
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
    await expectReproFailure(
      () =>
        expectNextTurnExtendsLastStep({
          tools: { bash: reminded, probe: plainTool("probe") },
          firstTurn: toolThenTextTurn("bash", "call-1"),
        }),
      divergesAt(2)
    );
  });

  // mcpClient.ts gives every MCP tool a toModelOutput (mcpToModelOutput) that turns the
  // CallToolResult into `content` text parts in-turn. The rebuild calls
  // convertToModelMessages without tools (messagePipeline.ts), so the persisted output
  // replays through the SDK's default JSON encoding instead.
  test("MCP-style toModelOutput results keep the prefix", async () => {
    const mcpLike = tool({
      description: "notion_fetch tool",
      inputSchema: z.object({ script: z.string() }),
      execute: () =>
        Promise.resolve({ content: [{ type: "text", text: "page body" }], isError: false }),
      toModelOutput: ({ output }) => {
        const result = output as { content: Array<{ type: string; text: string }> };
        return {
          type: "content",
          value: result.content.map((part) => ({ type: "text" as const, text: part.text })),
        };
      },
    });
    await expectReproFailure(
      () =>
        expectNextTurnExtendsLastStep({
          tools: { notion_fetch: mcpLike, probe: plainTool("probe") },
          firstTurn: toolThenTextTurn("notion_fetch", "call-1"),
        }),
      divergesAt(2)
    );
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
    await expectReproFailure(hotMemoryChangeKeepsHistoryCached, {
      matcher: "toBe",
      expected: "0",
      received: "1",
    });
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

  expect(sendsAfter(first, second, MONITOR_WAKE)).toBe(true);
  // The first turn's answer must precede the trigger: a fix that rebuilt the history without
  // it would still keep the tail-only change below and pass the target assertion.
  expect(endsWithAnswerThenTrigger(second)).toBe(true);
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
