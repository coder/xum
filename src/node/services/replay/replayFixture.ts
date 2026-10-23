/**
 * Deterministic fixture-session generator for the replay harness tests and
 * the replay-verify / cache-audit debug CLI commands.
 *
 * Regenerating (only needed when the request pipeline intentionally changes):
 *   MUX_REGENERATE_REPLAY_FIXTURE=1 bun test src/node/services/replay/replayVerify.fixture.test.ts
 *
 * The recorded devtools.jsonl requests are produced through the SAME capture
 * harness the verifier uses, so the fixture is a frozen golden snapshot of the
 * production pipeline's bytes: any later request-time injection of live state
 * (the regression this net exists to catch) rebuilds different bytes in the
 * test environment and fails the byte-equality assertions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tool, type Tool } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { z } from "zod";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { DevToolsLogEntry } from "@/common/types/devtools";
import {
  createMuxMessage,
  filterOrphanedMcpPromptSnapshots,
  type MuxMessage,
  type PluginHookContextEntry,
  type SystemSectionRecords,
} from "@/common/types/message";
import { applyCacheControlToTools, type AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import assert from "@/common/utils/assert";
import { collectDeferLoadingToolNames } from "@/common/utils/tools/toolCatalog";
import { replaceOrAppendMessageById } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import { assemblePromptPayload } from "@/node/services/turnContextAssembler";
import { emitTurnEnvelope } from "@/node/services/turnEnvelope";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { buildReplayRequest, captureLanguageModelPrompt } from "./replayRequestBuilder";
import { DEVTOOLS_LOG_FILE_NAME } from "./replayVerify";

export const REPLAY_FIXTURE_WORKSPACE_ID = "replay-fixture";
/** Anthropic model so the cached-system-message request shape is exercised. */
export const REPLAY_FIXTURE_MODEL = "anthropic:claude-sonnet-4-5";
/** A model whose direct route sends system-section rows (acceptsVolatileSystemTailRow). */
const REPLAY_FIXTURE_ROWS_MODEL = "anthropic:claude-opus-5-5";
// __dirname (not import.meta.dir): tsconfig.main.json's module target rejects
// import.meta, and bun provides __dirname in both CJS and ESM transpilation.
export const REPLAY_FIXTURE_DIR = path.join(__dirname, "__fixtures__", "replay-session");

const SYSTEM_PROMPT_V1 =
  "You are a sanitized replay fixture agent.\n\nAnswer briefly and never call tools unless asked.";
const SYSTEM_PROMPT_V2 = `${SYSTEM_PROMPT_V1}\n\nAddendum: a skill was loaded, changing the system prompt.`;

function fixtureToolsV1(): Record<string, Tool> {
  return {
    file_read: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
    }),
  };
}

function fixtureToolsV2(): Record<string, Tool> {
  return {
    ...fixtureToolsV1(),
    bash: tool({
      description: "Run a command",
      inputSchema: z.object({ script: z.string() }),
    }),
  };
}

/** The wire provider of every fixture request (direct Anthropic model string). */
const REPLAY_FIXTURE_WIRE_PROVIDER = "anthropic";

/** One turn appended to a fixture session by appendReplayFixtureTurn. */
export interface ReplayFixtureTurnSpec {
  userText: string;
  /** Prompt-hook context saved on the user row (MuxMetadata.pluginHookContext). */
  pluginHookContext?: PluginHookContextEntry[];
  /** Omit to simulate a stream that failed before appending an assistant row. */
  assistantText?: string;
  /** Extra assistant-row parts after the text (e.g. completed tool calls). */
  assistantParts?: MuxMessage["parts"];
  /** Agent handling the request; recorded on the assistant row. Default "exec". */
  agentId?: string;
  systemPrompt: string;
  tools: Record<string, Tool>;
  usage?: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
  /** Request-time inputs beyond chat.jsonl — logged in the turn envelope. */
  planContentForTransition?: string;
  planFilePath?: string;
  postCompactionAttachments?: PostCompactionAttachment[];
  /** Refusal-fallback partial continuation (envelope-only, never in chat.jsonl). */
  partialContinuation?: MuxMessage;
  /** MCP Apps model context message (request-only, never in chat.jsonl). */
  mcpAppModelContext?: MuxMessage;
  /** Simulate an envelope written without the model context it sent. */
  envelopeOmitsMcpAppModelContext?: boolean;
  anthropicCacheTtl?: AnthropicCacheTtl;
  /** Volatile system tail length (production splits it into its own block). */
  systemVolatileSuffixLength?: number;
  /** Set false to simulate devtools logging being off for this turn. */
  recordDevtools?: boolean;
  /**
   * Emit this many extra turn-envelope rows (same requestHistorySequence)
   * before the final one — simulates retried attempts whose streams failed.
   */
  extraEnvelopeAttempts?: number;
  /** A trimmed compaction request: the budget production recorded in its DevTools run. */
  compactionInputBudgetTokens?: number;
  /**
   * Record the request the way a live turn builds it: assemblePromptPayload with `tools` and
   * these `Tool:` instructions, on REPLAY_FIXTURE_ROWS_MODEL over the direct route, with the
   * request's system-section records on the assistant row. `tools` must end each description
   * with "\n\n" + its instructions, as getToolsForModel appends them. Replay must then rebuild
   * the request from the records alone.
   */
  liveToolInstructions?: Record<string, string>;
}

/** Mutable state threaded through appendReplayFixtureTurn calls. */
export interface ReplayFixtureSessionContext {
  sessionDir: string;
  workspaceId: string;
  historyService: HistoryService;
  journal: DurableEventJournal;
  devtoolsLines: string[];
  turnCounter: number;
}

export function createReplayFixtureSessionContext(
  sessionDir: string,
  workspaceId: string = REPLAY_FIXTURE_WORKSPACE_ID
): ReplayFixtureSessionContext {
  return {
    sessionDir,
    workspaceId,
    historyService: new HistoryService({
      getSessionDir: () => sessionDir,
      // Fixture writes take the history write lock under `<rootDir>/locks`;
      // lockfiles are transient (removed on release).
      rootDir: path.dirname(sessionDir),
    }),
    journal: new DurableEventJournal(sessionDir),
    devtoolsLines: [],
    turnCounter: 0,
  };
}

async function appendOrThrow(
  ctx: ReplayFixtureSessionContext,
  message: MuxMessage
): Promise<number> {
  const result = await ctx.historyService.appendToHistory(ctx.workspaceId, message);
  assert(result.success, `fixture append failed: ${String(!result.success && result.error)}`);
  const sequence = message.metadata?.historySequence;
  assert(sequence != null, "appendToHistory must assign historySequence");
  return sequence;
}

/**
 * Append one stream turn to a fixture session the way production does:
 * user row → turn-envelope row (with the replay pairing key and request-time
 * inputs) → recorded devtools request built via the production pipeline →
 * assistant row. The spec knobs simulate the log shapes the verifier must
 * survive (failed streams, devtools toggling, injected plan/post-compaction
 * content).
 */
export async function appendReplayFixtureTurn(
  ctx: ReplayFixtureSessionContext,
  spec: ReplayFixtureTurnSpec
): Promise<void> {
  ctx.turnCounter += 1;
  const turnNumber = ctx.turnCounter;
  const baseTimestamp = 1_700_000_000_000 + turnNumber * 10_000;
  const agentId = spec.agentId ?? "exec";
  const modelString = fixtureModel(spec);

  const userMessage = createMuxMessage(`user-${turnNumber}`, "user", spec.userText, {
    timestamp: baseTimestamp,
    ...(spec.pluginHookContext != null ? { pluginHookContext: spec.pluginHookContext } : {}),
  });
  const requestHistorySequence = await appendOrThrow(ctx, userMessage);

  // The request is built from history as read BEFORE the assistant row is
  // appended — same ordering as AgentSession.streamWithHistory.
  const historyResult = await ctx.historyService.getHistoryFromLatestBoundary(ctx.workspaceId);
  assert(historyResult.success, "fixture history read failed");

  // Built whatever recordDevtools is: production writes the row's records either way, and the
  // envelope logs the system content the request sent.
  const recorded = await buildFixtureRequest(ctx, spec, historyResult.data, agentId);

  // Retries re-emit an envelope per attempt; only the final attempt streams
  // the surviving assistant row, so 1 + extraEnvelopeAttempts rows share one
  // requestHistorySequence.
  for (let attempt = 0; attempt <= (spec.extraEnvelopeAttempts ?? 0); attempt++) {
    await emitTurnEnvelope({
      journal: ctx.journal,
      workspaceId: ctx.workspaceId,
      systemMessage: recorded.sentSystem.message,
      systemVolatileSuffixLength: recorded.sentSystem.volatileSuffixLength,
      tools: spec.tools,
      modelString,
      thinkingLevel: "off",
      providerOptions: { anthropic: {} },
      requestHistorySequence,
      wireProviderName: REPLAY_FIXTURE_WIRE_PROVIDER,
      anthropicCacheTtl: spec.anthropicCacheTtl,
      planContentForTransition: spec.planContentForTransition,
      planFilePath: spec.planFilePath,
      postCompactionAttachments: spec.postCompactionAttachments,
      partialContinuationMessage: spec.partialContinuation,
      mcpAppModelContextMessage:
        spec.envelopeOmitsMcpAppModelContext === true ? undefined : spec.mcpAppModelContext,
    });
  }

  if (spec.recordDevtools !== false) {
    const runEntry: DevToolsLogEntry = {
      type: "run",
      run: {
        id: `run-${turnNumber}`,
        workspaceId: ctx.workspaceId,
        startedAt: new Date(baseTimestamp + 1_000).toISOString(),
        requestHistorySequence,
        // JSON drops the key when the turn has no budget.
        compactionInputBudgetTokens: spec.compactionInputBudgetTokens,
      },
    };
    const stepEntry: DevToolsLogEntry = {
      type: "step",
      step: {
        id: `step-${turnNumber}`,
        runId: `run-${turnNumber}`,
        stepNumber: 0,
        type: "stream",
        modelId: modelString,
        provider: REPLAY_FIXTURE_WIRE_PROVIDER,
        startedAt: new Date(baseTimestamp + 1_000).toISOString(),
        durationMs: 1234,
        input: {
          prompt: JSON.parse(JSON.stringify(recorded.prompt)) as unknown,
          tools: JSON.parse(JSON.stringify(recorded.tools)) as unknown,
        },
        output: null,
        usage: null,
        error: null,
        rawRequest: null,
        requestHeaders: null,
        responseHeaders: null,
        rawResponse: null,
        rawChunks: null,
        inputTransformations: null,
      },
    };
    ctx.devtoolsLines.push(JSON.stringify(runEntry), JSON.stringify(stepEntry));
  }

  if (spec.assistantText !== undefined) {
    const assistantMessage = createMuxMessage(
      `assistant-${turnNumber}`,
      "assistant",
      spec.assistantText,
      {
        timestamp: baseTimestamp + 2_000,
        model: modelString,
        agentId,
        thinkingLevel: "off",
        requestHistorySequence,
        ...recorded.rowMetadata,
        ...(spec.usage !== undefined ? { usage: spec.usage } : {}),
        ...(spec.providerMetadata !== undefined ? { providerMetadata: spec.providerMetadata } : {}),
      },
      spec.assistantParts
    );
    await appendOrThrow(ctx, assistantMessage);
  }
}

function fixtureModel(spec: ReplayFixtureTurnSpec): string {
  return spec.liveToolInstructions == null ? REPLAY_FIXTURE_MODEL : REPLAY_FIXTURE_ROWS_MODEL;
}

/** The recorded request of a fixture turn, and what its assistant row records about it. */
function buildFixtureRequest(
  ctx: ReplayFixtureSessionContext,
  spec: ReplayFixtureTurnSpec,
  historyMessages: MuxMessage[],
  agentId: string
) {
  return spec.liveToolInstructions == null
    ? buildReplayedFixtureRequest(ctx, spec, historyMessages, agentId)
    : buildLiveFixtureRequest(ctx, spec, historyMessages, agentId);
}

/** The recorded request of a fixture turn, built through the replay pipeline itself. */
async function buildReplayedFixtureRequest(
  ctx: ReplayFixtureSessionContext,
  spec: ReplayFixtureTurnSpec,
  historyMessages: MuxMessage[],
  agentId: string
) {
  const rebuilt = await buildReplayRequest({
    historyMessages,
    systemPrompt: spec.systemPrompt,
    systemPromptVolatileSuffixLength: spec.systemVolatileSuffixLength,
    modelString: REPLAY_FIXTURE_MODEL,
    thinkingLevel: "off",
    effectiveAgentId: agentId,
    toolNamesForSentinel: Object.keys(spec.tools).sort(),
    wireProviderName: REPLAY_FIXTURE_WIRE_PROVIDER,
    anthropicCacheTtl: spec.anthropicCacheTtl,
    planContentForTransition: spec.planContentForTransition,
    planFilePath: spec.planFilePath,
    postCompactionAttachments: spec.postCompactionAttachments,
    partialContinuation: spec.partialContinuation,
    mcpAppModelContext: spec.mcpAppModelContext,
    // Production derives these from the request tools (assemblePromptPayload).
    deferLoadingToolNames: collectDeferLoadingToolNames(spec.tools),
    compactionInputBudgetTokens: spec.compactionInputBudgetTokens,
    workspaceId: ctx.workspaceId,
  });
  // Wire tool definitions use the same cache treatment as the prompt assembler.
  const { tools } = await captureLanguageModelPrompt({
    system: rebuilt.system,
    messages: rebuilt.messages,
    modelId: REPLAY_FIXTURE_MODEL,
    tools: applyCacheControlToTools(spec.tools, REPLAY_FIXTURE_MODEL, spec.anthropicCacheTtl, null),
  });
  return {
    prompt: rebuilt.lmPrompt,
    tools,
    sentSystem: {
      message: spec.systemPrompt,
      volatileSuffixLength: spec.systemVolatileSuffixLength,
    },
    rowMetadata: {},
  };
}

/** The recorded request of a live fixture turn (see liveToolInstructions) and its records. */
async function buildLiveFixtureRequest(
  ctx: ReplayFixtureSessionContext,
  spec: ReplayFixtureTurnSpec,
  history: MuxMessage[],
  agentId: string
) {
  // The same request-time inputs and history preparation as buildReplayRequest, so a live
  // turn differs from its replay only by what the records must restore.
  const filtered = filterOrphanedMcpPromptSnapshots(history);
  const payload = await assemblePromptPayload({
    history:
      spec.partialContinuation == null
        ? filtered
        : replaceOrAppendMessageById(filtered, spec.partialContinuation),
    systemMessage: spec.systemPrompt,
    volatileSystemSuffixLength: spec.systemVolatileSuffixLength,
    tools: spec.tools,
    toolInstructions: spec.liveToolInstructions,
    anthropicCacheTtl: spec.anthropicCacheTtl,
    planContentForTransition: spec.planContentForTransition,
    planFilePath: spec.planFilePath,
    postCompactionAttachments: spec.postCompactionAttachments,
    requestContextMessage: spec.mcpAppModelContext,
    compactionInputBudgetTokens: spec.compactionInputBudgetTokens,
    modelString: REPLAY_FIXTURE_ROWS_MODEL,
    routeProvider: REPLAY_FIXTURE_WIRE_PROVIDER,
    providerForMessages: REPLAY_FIXTURE_WIRE_PROVIDER,
    effectiveThinkingLevel: "off",
    effectiveAgentId: agentId,
    toolNamesForSentinel: Object.keys(spec.tools).sort(),
    workspaceId: ctx.workspaceId,
  });
  const { prompt, tools } = await captureLanguageModelPrompt({
    system: payload.system,
    messages: payload.messages,
    modelId: REPLAY_FIXTURE_ROWS_MODEL,
    tools: payload.tools,
  });
  const records: SystemSectionRecords = {
    customInstructions: payload.customInstructions,
    skillIndex: payload.skillIndex,
    toolInstructions: payload.toolInstructions,
    volatileSystemTail: payload.volatileSystemTail,
  };
  return {
    prompt,
    tools,
    // Production's envelope logs the sent system content (frozen inside a segment).
    sentSystem: {
      message: payload.sentSystem.message,
      volatileSuffixLength: payload.sentSystem.volatileSuffixLength || undefined,
    },
    rowMetadata: { routeProvider: REPLAY_FIXTURE_WIRE_PROVIDER, ...records },
  };
}

/**
 * Append a durable compaction boundary row (the summary assistant message a
 * compaction turn persists), sealing the current epoch.
 */
export async function appendReplayFixtureCompactionBoundary(
  ctx: ReplayFixtureSessionContext,
  summaryText: string,
  compactionEpoch: number
): Promise<void> {
  ctx.turnCounter += 1;
  const boundaryMessage = createMuxMessage(
    `compaction-${ctx.turnCounter}`,
    "assistant",
    summaryText,
    {
      timestamp: 1_700_000_000_000 + ctx.turnCounter * 10_000,
      compactionBoundary: true,
      compacted: true,
      compactionEpoch,
    }
  );
  await appendOrThrow(ctx, boundaryMessage);
}

/** Write the accumulated recorded requests to the session's devtools.jsonl. */
export async function flushReplayFixtureDevtools(ctx: ReplayFixtureSessionContext): Promise<void> {
  await fs.writeFile(
    path.join(ctx.sessionDir, DEVTOOLS_LOG_FILE_NAME),
    ctx.devtoolsLines.join("\n") + "\n",
    "utf-8"
  );
}

/**
 * The three fixture turns: baseline, prefix-stable follow-up, then a turn
 * that busts the cache twice over (system prompt change + tool added) with
 * cache-write-heavy usage for the auditor's token attribution.
 */
const FIXTURE_TURNS: ReplayFixtureTurnSpec[] = [
  {
    userText: "Hello! Which file holds the entry point?",
    assistantText: "The entry point lives in src/main.ts.",
    systemPrompt: SYSTEM_PROMPT_V1,
    tools: fixtureToolsV1(),
    usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 },
    providerMetadata: { anthropic: { cacheCreationInputTokens: 1100 } },
  },
  {
    userText: "Thanks. And the preload script?",
    assistantText: "That is src/preload.ts.",
    systemPrompt: SYSTEM_PROMPT_V1,
    tools: fixtureToolsV1(),
    usage: { inputTokens: 1260, outputTokens: 30, totalTokens: 1290, cachedInputTokens: 1200 },
  },
  {
    userText: "Now run the linter.",
    assistantText: "Lint passed with no findings.",
    systemPrompt: SYSTEM_PROMPT_V2,
    tools: fixtureToolsV2(),
    usage: { inputTokens: 1400, outputTokens: 25, totalTokens: 1425 },
    providerMetadata: { anthropic: { cacheCreationInputTokens: 1300 } },
  },
];

/** Generate the fixture session directory from scratch. */
export async function generateReplayFixtureSession(
  sessionDir: string = REPLAY_FIXTURE_DIR
): Promise<void> {
  await fs.rm(sessionDir, { recursive: true, force: true });
  await fs.mkdir(sessionDir, { recursive: true });

  const ctx = createReplayFixtureSessionContext(sessionDir);
  for (const turn of FIXTURE_TURNS) {
    await appendReplayFixtureTurn(ctx, turn);
  }

  // Envelope emission is fire-and-forget in production (never fails a turn);
  // the fixture must not silently miss rows.
  const envelopeCount = (await ctx.journal.read()).filter(
    (event) => event.kind === "turn-envelope"
  ).length;
  assert(
    envelopeCount === FIXTURE_TURNS.length,
    `expected ${FIXTURE_TURNS.length} turn-envelope rows, found ${envelopeCount}`
  );

  await flushReplayFixtureDevtools(ctx);
}
