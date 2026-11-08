import { describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { Effect } from "effect";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import { createMuxMessage } from "@/common/types/message";
import type {
  MemoryConsolidationStatusChangeEventPayload,
  MemoryHarvestRecordPayload,
} from "@/common/orpc/schemas/memory";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  MEMORY_ANALYZER_OP_BUDGET,
  MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP,
} from "@/common/constants/memory";
import { Err, Ok, type Result } from "@/common/types/result";
import { Config } from "@/node/config";
import {
  dreamStreamLockPath,
  HARVEST_MAX_ATTEMPTS,
  harvestResumeState,
  MemoryConsolidationService,
  resolveDreamAgentBody,
  resolveDreamModelString,
  resolveHeadlessAgentModelString,
  resolveHeadlessAgentSettings,
  resolveHeadlessAgentBody,
  resolveHeadlessAgentDefinition,
  staleExhaustedHarvestFailure,
} from "./memoryConsolidationService";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MEMORY_ANALYZER_SYSTEM_PROMPT } from "./memoryHarvest";
import { log } from "@/node/services/log";
import { HistoryService } from "./historyService";
import { MemoryService } from "./memoryService";
import { SessionUsageService } from "./sessionUsageService";
import { TestTempDir } from "./tools/testHelpers";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

/**
 * Behavior under test: the orchestration rails around the runner —
 * experiment gating, per-workspace debounce (manual bypass), journal
 * persistence, and launch-sweep selection. The model is a scripted mock that
 * finishes without tool calls ("no changes needed" run).
 */

function userPromptText(options: LanguageModelV3CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** Stream parts of one analyzer step that writes `text` to a workspace memory file. */
function harvestWriteChunks(
  memoryPath = "/memories/workspace/testing.md",
  text = "The user prefers concise tests.\n"
): LanguageModelV3StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: `harvest-write-${memoryPath}`,
      toolName: "memory",
      input: JSON.stringify({ command: "create", path: memoryPath, file_text: text }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 0, reasoning: 0 },
      },
    },
  ];
}

function scriptedModel(capturePrompt?: (prompt: string) => void): MockLanguageModelV3 {
  // Chunk list typed explicitly: simulateReadableStream's inferred union
  // otherwise collapses optional fields and fails LanguageModelV3 assignment.
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "no changes needed" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: (options) => {
      capturePrompt?.(userPromptText(options));
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

function harvestCandidateModel(): MockLanguageModelV3 {
  let streamCount = 0;
  return new MockLanguageModelV3({
    doStream: (options) => {
      streamCount++;
      const prompt = userPromptText(options);
      const isHarvest = prompt.includes("just-compacted transcript epoch");
      const chunks: LanguageModelV3StreamPart[] =
        isHarvest && streamCount === 1
          ? harvestWriteChunks()
          : [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "no changes needed" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

/**
 * Simulates a provider failure or timeout abort: the stream itself errors
 * mid-flight (an `error` chunk part alone would not reach consumeStream's
 * onError — real connection failures reject the stream).
 */
function failingScriptedModel(capturePrompt?: (prompt: string) => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (options) => {
      capturePrompt?.(userPromptText(options));
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          pull(controller) {
            controller.error(new Error("provider exploded"));
          },
        }),
      });
    },
  });
}

function projectMutationModel(): MockLanguageModelV3 {
  let streamCount = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      streamCount++;
      const chunks: LanguageModelV3StreamPart[] =
        streamCount === 1
          ? [
              {
                type: "tool-call",
                toolCallId: "project-write",
                toolName: "memory",
                input: JSON.stringify({
                  command: "create",
                  path: "/memories/project/should-not-exist.md",
                  file_text: "must not be written\n",
                }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 0, reasoning: 0 },
                },
              },
            ]
          : [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "project write attempted" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

function systemPromptText(options: LanguageModelV3CallOptions): string {
  return options.prompt
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n");
}

function noChangesStream(): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream<LanguageModelV3StreamPart>({
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "no changes needed" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ],
  });
}

function failingStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    pull(controller) {
      controller.error(new Error("provider exploded"));
    },
  });
}

/** One analyzer step that issues MEMORY_ANALYZER_OP_BUDGET creates: the epoch's whole edit budget. */
function spendEveryEditStream(): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream<LanguageModelV3StreamPart>({
    chunks: [
      ...Array.from(
        { length: MEMORY_ANALYZER_OP_BUDGET },
        (_, index): LanguageModelV3StreamPart => ({
          type: "tool-call",
          toolCallId: `spend-${index}`,
          toolName: "memory",
          input: JSON.stringify({
            command: "create",
            path: `/memories/workspace/spend-${index}.md`,
            file_text: `fact ${index}\n`,
          }),
        })
      ),
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 0, reasoning: 0 },
        },
      },
    ],
  });
}

/**
 * An analyzer that tries `editsPerRun` creates of distinct workspace notes in each run's first
 * step, so a test can count the edits an epoch's runs got in total. The dream makes none.
 * `beforeEdits(run)` holds a run's first step until it settles, to keep a stream open.
 * `failRun` names the analyzer run whose stream fails after its edits landed.
 */
function editsEveryRunModels(
  editsPerRun: number,
  beforeEdits?: (run: number) => Promise<void>,
  failRun?: number
): {
  factory: () => MockLanguageModelV3;
  analyzerRuns: () => number;
} {
  let analyzerRuns = 0;
  const factory = () =>
    new MockLanguageModelV3({
      doStream: async (options) => {
        const afterToolResult = options.prompt.some((message) => message.role === "tool");
        const isAnalyzer = systemPromptText(options) === MEMORY_ANALYZER_SYSTEM_PROMPT;
        if (isAnalyzer && afterToolResult && analyzerRuns === failRun) {
          return { stream: failingStream() };
        }
        if (!isAnalyzer || afterToolResult) {
          return { stream: noChangesStream() };
        }
        const run = ++analyzerRuns;
        await beforeEdits?.(run);
        return {
          stream: simulateReadableStream<LanguageModelV3StreamPart>({
            chunks: [
              ...Array.from(
                { length: editsPerRun },
                (_, index): LanguageModelV3StreamPart => ({
                  type: "tool-call",
                  toolCallId: `edit-${run}-${index}`,
                  toolName: "memory",
                  input: JSON.stringify({
                    command: "create",
                    path: `/memories/workspace/run-${run}-edit-${index}.md`,
                    file_text: `fact ${run}.${index}\n`,
                  }),
                })
              ),
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 0, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    });
  return { factory, analyzerRuns: () => analyzerRuns };
}

interface ArchivePassRun {
  kind: "analyzer" | "dream";
  prompt: string;
  /** What the first analyzer run's workspace note held when this run began; null before it exists. */
  noteAtStart: string | null;
}

/**
 * Scripts the analyzer and the dream apart by their system prompts. Analyzer run n writes the
 * workspace note `note-n.md`. Every run records the first note as it stood when the run began, so
 * a test sees whether the dream started after the analyzer's write.
 */
function archivePassModels(
  options: { analyzerFailures?: number; holdFirstAnalyzer?: Promise<void> } = {}
): {
  runs: ArchivePassRun[];
  factory: () => MockLanguageModelV3;
  readFirstNote: { current: () => Promise<string | null> };
  /** Settles when the first analyzer run has begun. */
  firstAnalyzerStarted: Promise<void>;
} {
  const runs: ArchivePassRun[] = [];
  const readFirstNote = { current: () => Promise.resolve<string | null>(null) };
  let analyzerFailures = options.analyzerFailures ?? 0;
  let analyzerRuns = 0;
  let markFirstAnalyzerStarted!: () => void;
  const firstAnalyzerStarted = new Promise<void>((resolve) => (markFirstAnalyzerStarted = resolve));
  const factory = () =>
    new MockLanguageModelV3({
      doStream: async (call) => {
        if (call.prompt.some((message) => message.role === "tool")) {
          return { stream: noChangesStream() };
        }
        const kind =
          systemPromptText(call) === MEMORY_ANALYZER_SYSTEM_PROMPT ? "analyzer" : "dream";
        const isFirstAnalyzer = kind === "analyzer" && runs.every((run) => run.kind !== "analyzer");
        runs.push({
          kind,
          prompt: userPromptText(call),
          noteAtStart: await readFirstNote.current(),
        });
        if (kind === "dream") return { stream: noChangesStream() };
        if (isFirstAnalyzer) {
          markFirstAnalyzerStarted();
          await options.holdFirstAnalyzer;
        }
        if (analyzerFailures > 0) {
          analyzerFailures--;
          return { stream: failingStream() };
        }
        analyzerRuns++;
        return {
          stream: simulateReadableStream({
            chunks: harvestWriteChunks(
              `/memories/workspace/note-${analyzerRuns}.md`,
              `analyzer note ${analyzerRuns}\n`
            ),
          }),
        };
      },
    });
  return { runs, factory, readFirstNote, firstAnalyzerStarted };
}

// $2 per million input tokens: a step of this many input tokens costs $0.50.
const PRICED_MODEL = "openai:gpt-6.1-sol";

function halfDollarUsage() {
  return {
    inputTokens: { total: 250_000, noCache: 250_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

/**
 * Scripts the analyzer and the dream with every model step costing $0.50 at PRICED_MODEL, and logs
 * each step. The analyzer edits in its first step of a chunk and ends the chunk in its second. The
 * dream either ends in its first step or lists memory in every step until the run stops it.
 */
function pricedPassModels(options: { dream: "ends" | "never-ends"; failChunkOnce?: string }): {
  steps: string[];
  factory: () => MockLanguageModelV3;
} {
  const steps: string[] = [];
  let failChunkOnce = options.failChunkOnce;
  const factory = () =>
    new MockLanguageModelV3({
      doStream: (call) => {
        const afterToolResult = call.prompt.some((message) => message.role === "tool");
        const finish = (reason: "stop" | "tool-calls"): LanguageModelV3StreamPart => ({
          type: "finish",
          finishReason: { unified: reason, raw: reason },
          usage: halfDollarUsage(),
        });
        const toolCall = (input: unknown): LanguageModelV3StreamPart => ({
          type: "tool-call",
          toolCallId: `call-${steps.length}`,
          toolName: "memory",
          input: JSON.stringify(input),
        });
        const stream = (chunks: LanguageModelV3StreamPart[]) =>
          Promise.resolve({ stream: simulateReadableStream({ chunks }) });

        if (systemPromptText(call) !== MEMORY_ANALYZER_SYSTEM_PROMPT) {
          steps.push("dream");
          if (options.dream === "ends") return stream([finish("stop")]);
          return stream([toolCall({ command: "view", path: "/memories/" }), finish("tool-calls")]);
        }
        const chunk = /Transcript chunk (\d+\/\d+)/.exec(userPromptText(call))?.[1] ?? "?";
        if (!afterToolResult && chunk === failChunkOnce) {
          failChunkOnce = undefined;
          steps.push(`analyzer ${chunk} fails`);
          return Promise.resolve({ stream: failingStream() });
        }
        steps.push(`analyzer ${chunk} ${afterToolResult ? "end" : "edit"}`);
        if (afterToolResult) return stream([finish("stop")]);
        return stream([
          toolCall({
            command: "create",
            path: `/memories/workspace/chunk-${chunk.replace("/", "-of-")}.md`,
            file_text: "fact\n",
          }),
          finish("tool-calls"),
        ]);
      },
    });
  return { steps, factory };
}

interface Fixture extends Disposable {
  xumHome: string;
  config: Config;
  service: MemoryConsolidationService;
  historyService: HistoryService;
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  /** Present with `withSessionUsage`: the service that records the dream's headless usage. */
  sessionUsage?: SessionUsageService;
  modelCalls: number[];
  modelPrompts: string[];
  setEnabled: (enabled: boolean) => void;
  /** When true, scripted runs emit a fatal stream error instead of finishing. */
  setStreamFailing: (failing: boolean) => void;
  /** When true, creating the run's model returns an error: a run fails before it reads a chunk. */
  setModelUnavailable: (unavailable: boolean) => void;
  addWorkspace: (
    id: string,
    opts?: { archivedAt?: string; parentWorkspaceId?: string }
  ) => Promise<void>;
  addMultiProjectWorkspace: (id: string, opts?: { bucket?: string }) => Promise<void>;
}

async function createFixture(options?: {
  /** Holds every model run open until resolved (for in-flight race tests). */
  modelGate?: Promise<void>;
  modelFactory?: () => MockLanguageModelV3;
  /** Holds one run's model creation (1-based, in call order) until the promise settles. */
  beforeModelCreated?: (call: number) => Promise<void>;
  /** Wire a real SessionUsageService (headless cost telemetry tests). */
  withSessionUsage?: boolean;
  /** The pricing identity every created model reports; default: the requested model string. */
  metadataModel?: string;
}): Promise<Fixture> {
  const tempDir = new TestTempDir("test-memory-consolidation-service");
  const xumHome = path.join(tempDir.path, "mux-home");
  await fsPromises.mkdir(path.join(xumHome, "memory"), { recursive: true });

  const config = new Config(xumHome);
  // Register a workspace so config.findWorkspace resolves it.
  await config.editConfig((cfg) => {
    cfg.projects.set("/projects/demo", {
      workspaces: [{ id: "ws-dream", name: "ws-dream", path: "/projects/demo/ws-dream" }],
    });
    return cfg;
  });

  const historyService = new HistoryService(config);
  const metaService = new MemoryMetaService(xumHome);
  const memoryService = new MemoryService(config, metaService);

  let enabled = true;
  let streamFailing = false;
  let modelUnavailable = false;
  const sessionUsage = options?.withSessionUsage
    ? new SessionUsageService(config, historyService)
    : undefined;
  const modelCalls: number[] = [];
  const modelPrompts: string[] = [];
  const capturePrompt = (prompt: string) => modelPrompts.push(prompt);
  const service = new MemoryConsolidationService(
    config,
    memoryService,
    metaService,
    historyService,
    {
      createModelWithPinnedMetadata: async (modelString: string) => {
        modelCalls.push(Date.now());
        if (options?.modelGate) await options.modelGate;
        await options?.beforeModelCreated?.(modelCalls.length);
        if (modelUnavailable) return Err({ type: "api_key_not_found" });
        return Ok({
          model:
            options?.modelFactory?.() ??
            (streamFailing ? failingScriptedModel(capturePrompt) : scriptedModel(capturePrompt)),
          metadataModel: options?.metadataModel ?? modelString,
        });
      },
    },
    {
      isExperimentEnabled: (id) =>
        enabled && (id === EXPERIMENT_IDS.MEMORY || id === EXPERIMENT_IDS.MEMORY_CONSOLIDATION),
    },
    sessionUsage
  );

  return {
    xumHome,
    config,
    service,
    historyService,
    memoryService,
    metaService,
    sessionUsage,
    modelCalls,
    modelPrompts,
    setEnabled: (value) => {
      enabled = value;
    },
    setStreamFailing: (value) => {
      streamFailing = value;
    },
    setModelUnavailable: (value) => {
      modelUnavailable = value;
    },
    addWorkspace: async (id, opts) => {
      await config.editConfig((cfg) => {
        cfg.projects.get("/projects/demo")?.workspaces.push({
          id,
          name: id,
          path: `/projects/demo/${id}`,
          archivedAt: opts?.archivedAt,
          parentWorkspaceId: opts?.parentWorkspaceId,
        });
        return cfg;
      });
    },
    addMultiProjectWorkspace: async (id, opts) => {
      await config.editConfig((cfg) => {
        const bucket = opts?.bucket ?? MULTI_PROJECT_CONFIG_KEY;
        let project = cfg.projects.get(bucket);
        if (project === undefined) {
          project = { workspaces: [] };
          cfg.projects.set(bucket, project);
        }
        project.workspaces.push({
          id,
          name: id,
          path: `/projects/multi/${id}`,
          projects: [
            { projectName: "demo", projectPath: "/projects/demo" },
            { projectName: "other", projectPath: "/projects/other" },
          ],
        });
        return cfg;
      });
    },
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

/** Seeds one closed compaction epoch; epoch N > 1 sits after epoch N - 1's boundary. */
async function seedCompactionEpoch(
  fixture: Fixture,
  workspaceId = "ws-dream",
  epoch = 1,
  previousBoundaryHistorySequence?: number
): Promise<CompactionCompletionMetadata> {
  // Epoch 1 keeps the original ids that other tests cite.
  const suffix = epoch === 1 ? "" : `-${epoch}`;
  await fixture.historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`pref-${epoch}`, "user", "Please remember that I prefer concise tests.")
  );
  await fixture.historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`compact-request${suffix}`, "user", "Please compact", {
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    })
  );
  const summary = createMuxMessage(
    `summary-${epoch}`,
    "assistant",
    "The user prefers concise tests.",
    { compactionBoundary: true, compacted: "user", compactionEpoch: epoch }
  );
  await fixture.historyService.appendToHistory(workspaceId, summary);

  const summaryHistorySequence = summary.metadata?.historySequence;
  expect(typeof summaryHistorySequence).toBe("number");
  return {
    workspaceId,
    summaryMessageId: `summary-${epoch}`,
    summaryHistorySequence: summaryHistorySequence ?? -1,
    compactionEpoch: epoch,
    compactionRequestMessageId: `compact-request${suffix}`,
    ...(previousBoundaryHistorySequence !== undefined ? { previousBoundaryHistorySequence } : {}),
  };
}

/** Closes the epoch the way a compaction does, without a row of its own to analyze. */
async function closeEpochWithoutNewRows(fixture: Fixture): Promise<CompactionCompletionMetadata> {
  await fixture.historyService.appendToHistory(
    "ws-dream",
    createMuxMessage("compact-request", "user", "Please compact", {
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    })
  );
  const summary = createMuxMessage("summary-1", "assistant", "Scripts use bun.", {
    compactionBoundary: true,
    compacted: "user",
    compactionEpoch: 1,
  });
  await fixture.historyService.appendToHistory("ws-dream", summary);
  return {
    workspaceId: "ws-dream",
    summaryMessageId: "summary-1",
    summaryHistorySequence: summary.metadata?.historySequence ?? -1,
    compactionEpoch: 1,
    compactionRequestMessageId: "compact-request",
  };
}

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

/** Rows that make the next epoch's transcript span three analyzer chunks (5 + 5 + 3 rows). */
async function appendBulkRows(fixture: Fixture, workspaceId = "ws-dream"): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await fixture.historyService.appendToHistory(
      workspaceId,
      createMuxMessage(`bulk-${index}`, "user", `preference ${index} ${"x".repeat(7_000)}`)
    );
  }
}

const openRowTexts: Array<[string, string]> = [
  ["open-1", "We settled on bun for every script in this repo."],
  ["open-2", "Noted: scripts use bun, never npm."],
];

async function appendRows(
  fixture: Fixture,
  rows: Array<[string, string]>,
  workspaceId = "ws-dream"
): Promise<void> {
  for (const [id, text] of rows) {
    await fixture.historyService.appendToHistory(workspaceId, createMuxMessage(id, "user", text));
  }
}

async function harvestRecords(
  fixture: Fixture,
  workspaceId = "ws-dream"
): Promise<Record<string, MemoryHarvestRecordPayload>> {
  // No sidecar until the first record is saved.
  const text = await fsPromises
    .readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    .catch(() => "{}");
  const raw = JSON.parse(text) as {
    harvestsByWorkspace?: Record<string, Record<string, MemoryHarvestRecordPayload>>;
  };
  return raw.harvestsByWorkspace?.[workspaceId] ?? {};
}

/** Rewrites one stored harvest record on disk, as a record from another run or version would read. */
async function editHarvestRecord(
  fixture: Fixture,
  boundaryKey: string,
  edit: (record: Record<string, unknown>) => void,
  workspaceId = "ws-dream"
): Promise<void> {
  const sidecarPath = path.join(fixture.xumHome, "memory-consolidation.json");
  const sidecar = JSON.parse(await fsPromises.readFile(sidecarPath, "utf-8")) as {
    harvestsByWorkspace: Record<string, Record<string, Record<string, unknown>>>;
  };
  edit(sidecar.harvestsByWorkspace[workspaceId][boundaryKey]);
  await fsPromises.writeFile(sidecarPath, JSON.stringify(sidecar));
}

/** Another backend on the same root holding the dream lock: this process sees its token as live. */
function holdForeignDreamLock(fixture: Fixture) {
  return acquireCrossProcessLock({
    lockPath: dreamStreamLockPath(fixture.xumHome),
    acquireTimeoutMs: 1_000,
    staleMs: 60_000,
    timeoutMessage: "test holder",
  });
}

/** A sweep or trigger the 6 h window refused: returned quietly as a skip, not an error to retry. */
function expectDebounced(result: Result<unknown, string>): void {
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error).toContain("debounced");
}

describe("MemoryConsolidationService", () => {
  it("teardown blocks follow-on consolidation runs (r61)", async () => {
    // The one-shot abort loop cannot reach runs registered after it (the
    // post-harvest sweep, retryable-harvest recovery): entry must refuse
    // once teardown began, locally or via a foreign backend's durable
    // removal tombstone.
    using fixture = await createFixture();
    await fixture.service.cancelInFlightConsolidation("ws-dream");
    const followOn = await fixture.service.maybeRun("ws-dream", "manual");
    expect(followOn.success).toBe(false);
    if (!followOn.success) expect(followOn.error).toContain("being removed");

    // Durable tombstone alone (removal performed by another backend).
    await fixture.addWorkspace("ws-foreign");
    const tombstonePath = workspaceRemovalTombstonePath(fixture.xumHome, "ws-foreign");
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fsPromises.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: "ws-foreign", removedAt: Date.now() })
    );
    const foreign = await fixture.service.maybeRun("ws-foreign", "manual");
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.error).toContain("being removed");
  });

  it("workspace removal aborts and drains an in-flight consolidation run (r60)", async () => {
    // Removal only ever raced the run's hard timeout before: the drain must
    // abort the stream itself, settle the run, and return promptly so
    // removal is never wedged behind an open provider stream.
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => (streamStarted = resolve));
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            streamStarted();
            // Emits nothing and never closes; like a real provider stream it
            // errors only when the request's abort signal fires.
            return Promise.resolve({
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  options.abortSignal?.addEventListener("abort", () => {
                    controller.error(new Error("request aborted"));
                  });
                },
              }),
            });
          },
        }),
    });
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
    const childMetadata = await seedCompactionEpoch(fixture, "ws-sub");
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-sub": {
            [childMetadata.summaryMessageId]: {
              status: "failed",
              startedAt: Date.now() - 10_000,
              completedAt: Date.now() - 9_000,
              attemptCount: 1,
              boundaryKey: childMetadata.summaryMessageId,
              compactionEpoch: childMetadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "crashed mid-harvest",
              completionMetadata: childMetadata,
            },
          },
        },
      })
    );
    const run = fixture.service.maybeRun("ws-dream", "manual");
    await started;
    await fixture.service.cancelInFlightConsolidation("ws-dream");
    // The run settled (abort surfaced as a stream failure) instead of
    // holding the in-flight lock until its multi-minute timeout.
    const result = await run;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream failed");
    }
    // The cancelled owner's continuation must not start recovery of a
    // sub-agent's retryable harvest (work outside the drained registry).
    const childRecords = (
      JSON.parse(
        await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
      ) as { harvestsByWorkspace: Record<string, Record<string, { attemptCount: number }>> }
    ).harvestsByWorkspace["ws-sub"];
    expect(Object.values(childRecords).map((record) => record.attemptCount)).toEqual([1]);
    // Idempotent with nothing in flight (the phantom-metadata removal path).
    await fixture.service.cancelInFlightConsolidation("ws-dream");
  });

  it("a sub-agent's removal drain aborts the owner-keyed run made on its behalf", async () => {
    // A child's trigger (and the post-harvest sweep) runs the OWNER's
    // consolidation; a cancelled child harvest deliberately falls through to
    // that sweep. The child's removal drain must still reach the owner-keyed
    // run, or it would keep mutating the shared notebook after removal.
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => (streamStarted = resolve));
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            streamStarted();
            return Promise.resolve({
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  options.abortSignal?.addEventListener("abort", () => {
                    controller.error(new Error("request aborted"));
                  });
                },
              }),
            });
          },
        }),
    });
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
    await fixture.addWorkspace("ws-sib", { parentWorkspaceId: "ws-dream" });
    const siblingMetadata = await seedCompactionEpoch(fixture, "ws-sib");
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-sib": {
            [siblingMetadata.summaryMessageId]: {
              status: "failed",
              startedAt: Date.now() - 10_000,
              completedAt: Date.now() - 9_000,
              attemptCount: 1,
              boundaryKey: siblingMetadata.summaryMessageId,
              compactionEpoch: siblingMetadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "crashed mid-harvest",
              completionMetadata: siblingMetadata,
            },
          },
        },
      })
    );
    const run = fixture.service.maybeRun("ws-sub", "manual");
    await started;
    await fixture.service.cancelInFlightConsolidation("ws-sub");
    const result = await run;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("stream failed");
    // The run was keyed by the owner, but the ACTING child is the one being
    // torn down: its continuation must not start recovery of a sibling's
    // retryable harvest (fresh provider work during the child's teardown).
    const siblingRecords = (
      JSON.parse(
        await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
      ) as { harvestsByWorkspace: Record<string, Record<string, { attemptCount: number }>> }
    ).harvestsByWorkspace["ws-sib"];
    expect(Object.values(siblingRecords).map((record) => record.attemptCount)).toEqual([1]);
    // Locally cancelled child: neither its own trigger nor an owner run made
    // on its behalf may start while teardown is under way.
    const refused = await fixture.service.maybeRun("ws-dream", "manual", {
      actingWorkspaceId: "ws-sub",
    });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toContain("being removed");
  });

  it("runs, persists the journal record, and reports it via getRecord", async () => {
    using fixture = await createFixture();
    const result = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trigger).toBe("compaction");
      expect(result.data.summary).toContain("no changes needed");
    }

    const record = await fixture.service.getRecord("ws-dream");
    expect(record?.trigger).toBe("compaction");
    // Persisted to the sidecar, not just memory.
    const raw = await fsPromises.readFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      "utf-8"
    );
    expect(raw).toContain("ws-dream");
  });

  it("emits status invalidation for successful no-op runs", async () => {
    using fixture = await createFixture();
    const events: MemoryConsolidationStatusChangeEventPayload[] = [];
    fixture.service.on("statusChange", (event: MemoryConsolidationStatusChangeEventPayload) => {
      events.push(event);
    });

    const result = await fixture.service.maybeRun("ws-dream", "manual");

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ops).toHaveLength(0);
    expect(events).toEqual([
      {
        kind: "consolidation_status",
        workspaceId: "ws-dream",
        projectPath: "/projects/demo",
      },
    ]);
  });

  it("requests an analytics ingest after recording headless sweep usage", async () => {
    using fixture = await createFixture({ withSessionUsage: true });
    const ingests: Array<{ workspaceId: string }> = [];
    fixture.service.on("analyticsIngest", (event: { workspaceId: string }) => {
      ingests.push(event);
    });

    const result = await fixture.service.maybeRun("ws-dream", "manual");
    expect(result.success).toBe(true);

    // The headless-usage sidecar only reaches dashboard totals via an
    // explicit ingest pass, and no stream-end follows a background sweep —
    // the sweep itself must request the ingest.
    expect(ingests).toEqual([{ workspaceId: "ws-dream" }]);
    const sidecar = await fsPromises.readFile(
      path.join(fixture.config.sessionsDir, "ws-dream", "headless-usage.jsonl"),
      "utf-8"
    );
    expect(sidecar).toContain('"source":"memory_consolidation"');
  });

  it("records project coverage for single-project workspace runs", async () => {
    using fixture = await createFixture();

    const result = await fixture.service.maybeRun("ws-dream", "manual");
    expect(result.success).toBe(true);

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown> };
    expect(raw.projects?.["/projects/demo"]).toBeDefined();
  });

  it("does not record project coverage for multi-project workspace runs", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-multi");

    const result = await fixture.service.maybeRun("ws-multi", "manual");
    expect(result.success).toBe(true);

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown>; workspaces?: Record<string, unknown> };
    expect(raw.workspaces?.["ws-multi"]).toBeDefined();
    expect(raw.projects?.["/projects/demo"]).toBeUndefined();
    expect(raw.projects?.["/projects/other"]).toBeUndefined();
  });

  it("disables project memory for multi-project workspace runs stored under a project bucket", async () => {
    using fixture = await createFixture({ modelFactory: projectMutationModel });
    await fixture.addMultiProjectWorkspace("ws-task", { bucket: "/projects/demo" });

    const result = await fixture.service.maybeRun("ws-task", "manual");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ops).toHaveLength(1);
      expect(result.data.ops[0]?.applied).toBe(false);
      expect(result.data.ops[0]?.note).toContain("single-project");
    }

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown>; workspaces?: Record<string, unknown> };
    expect(raw.workspaces?.["ws-task"]).toBeDefined();
    expect(raw.projects?.["/projects/demo"]).toBeUndefined();

    const status = await fixture.service.getStatus("ws-task");
    expect(status.projectAvailable).toBe(false);
    expect(status.projectRecord).toBeNull();
  });

  it("reports workspace, project, and global coverage separately", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-sibling");
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

    const siblingStatus = await fixture.service.getStatus("ws-sibling");
    expect(siblingStatus.workspaceRecord).toBeNull();
    expect(siblingStatus.projectAvailable).toBe(true);
    expect(siblingStatus.projectRecord?.trigger).toBe("manual");
    expect(siblingStatus.globalRecord?.trigger).toBe("manual");
  });

  it("does not treat older workspace-only records as project coverage", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {
          "ws-dream": {
            lastRunAt: Date.now(),
            trigger: "manual",
            summary: "old record",
            ops: [],
          },
        },
      })
    );

    const status = await fixture.service.getStatus("ws-dream");
    expect(status.workspaceRecord?.summary).toBe("old record");
    expect(status.projectAvailable).toBe(true);
    expect(status.projectRecord).toBeNull();
    expect(status.globalRecord?.summary).toBe("old record");
  });

  it("preserves consolidation status when a harvest sidecar record is malformed", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {
          "ws-dream": {
            lastRunAt: 123,
            trigger: "manual",
            summary: "valid workspace record",
            ops: [],
          },
        },
        projects: {
          "/projects/demo": {
            lastRunAt: 124,
            trigger: "manual",
            summary: "valid project record",
            ops: [],
          },
        },
        harvestsByWorkspace: {
          "ws-dream": {
            broken: { status: "bogus" },
          },
        },
      })
    );

    const status = await fixture.service.getStatus("ws-dream");

    expect(status.workspaceRecord?.summary).toBe("valid workspace record");
    expect(status.projectRecord?.summary).toBe("valid project record");
    expect(status.latestHarvestRecord).toBeNull();
  });

  it("analyzes a compaction boundary into workspace memory before running the dream sweep", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    const metadata = await seedCompactionEpoch(fixture);

    const result = await fixture.service.maybeHarvestThenSweep(metadata);

    expect(result.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
    const file = await fixture.memoryService.readFileWithSha(
      { runtime: null, checkoutCwd: "", workspaceId: "ws-dream", projectPath: "/projects/demo" },
      "/memories/workspace/testing.md"
    );
    expect(file.success).toBe(true);
    if (file.success) expect(file.data.content).toContain("concise tests");

    const status = await fixture.service.getStatus("ws-dream");
    expect(status.workspaceRecord?.trigger).toBe("compaction");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "completed",
      nextChunk: 1,
      acceptedCandidates: 1,
      skippedCandidates: 0,
      ops: [{ command: "create", path: "/memories/workspace/testing.md", applied: true }],
    });
  });

  it("prunes old harvest sidecar records while preserving the newest status", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    const metadata = await seedCompactionEpoch(fixture);
    const oldRecords = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `old-${index}`,
        {
          status: "completed",
          startedAt: index,
          completedAt: index,
          attemptCount: 1,
          boundaryKey: `old-${index}`,
          compactionEpoch: index,
          acceptedCandidates: 0,
          skippedCandidates: 0,
        },
      ])
    );
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({ workspaces: {}, harvestsByWorkspace: { "ws-dream": oldRecords } })
    );

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    ) as { harvestsByWorkspace?: Record<string, Record<string, unknown>> };
    const records = raw.harvestsByWorkspace?.["ws-dream"] ?? {};
    expect(Object.keys(records).length).toBeLessThanOrEqual(20);
    expect(records[metadata.summaryMessageId]).toBeDefined();
    expect((await fixture.service.getStatus("ws-dream")).latestHarvestRecord?.boundaryKey).toBe(
      metadata.summaryMessageId
    );
  });

  it("coalesces duplicate harvest requests for the same compaction boundary", async () => {
    let releaseHarvest!: () => void;
    const harvestReleased = new Promise<void>((resolve) => {
      releaseHarvest = resolve;
    });
    let markHarvestStarted!: () => void;
    const harvestStarted = new Promise<void>((resolve) => {
      markHarvestStarted = resolve;
    });
    let harvestStreamCount = 0;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            if (isHarvest) {
              harvestStreamCount++;
              markHarvestStarted();
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  async pull(controller) {
                    await harvestReleased;
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 0, text: 0, reasoning: 0 },
                      },
                    });
                    controller.close();
                  },
                }),
              });
            }
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "no changes needed" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ],
              }),
            });
          },
        }),
    });
    const metadata = await seedCompactionEpoch(fixture);

    const first = fixture.service.maybeHarvestThenSweep(metadata);
    await harvestStarted;
    const second = fixture.service.maybeHarvestThenSweep(metadata);
    expect(harvestStreamCount).toBe(1);

    releaseHarvest();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("queues the post-harvest compaction sweep behind an active sweep", async () => {
    let releaseFirstSweep!: () => void;
    const firstSweepReleased = new Promise<void>((resolve) => {
      releaseFirstSweep = resolve;
    });
    let markFirstSweepStarted!: () => void;
    const firstSweepStarted = new Promise<void>((resolve) => {
      markFirstSweepStarted = resolve;
    });
    let sweepStreamCount = 0;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const prompt = userPromptText(options);
            if (!prompt.includes("just-compacted transcript epoch")) {
              sweepStreamCount++;
              if (sweepStreamCount === 1) {
                markFirstSweepStarted();
                return Promise.resolve({
                  stream: new ReadableStream<LanguageModelV3StreamPart>({
                    async pull(controller) {
                      await firstSweepReleased;
                      controller.enqueue({ type: "text-start", id: "t1" });
                      controller.enqueue({ type: "text-delta", id: "t1", delta: "first sweep" });
                      controller.enqueue({ type: "text-end", id: "t1" });
                      controller.enqueue({
                        type: "finish",
                        finishReason: { unified: "stop", raw: "stop" },
                        usage: {
                          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                          outputTokens: { total: 1, text: 1, reasoning: 0 },
                        },
                      });
                      controller.close();
                    },
                  }),
                });
              }
            }
            const chunks: LanguageModelV3StreamPart[] = prompt.includes(
              "just-compacted transcript epoch"
            )
              ? harvestWriteChunks()
              : [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "second sweep" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ];
            return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
          },
        }),
    });
    const metadata = await seedCompactionEpoch(fixture);

    const activeSweep = fixture.service.maybeRun("ws-dream", "manual");
    await firstSweepStarted;
    const harvestThenSweep = fixture.service.maybeHarvestThenSweep(metadata);

    releaseFirstSweep();
    expect((await activeSweep).success).toBe(true);
    // The sweep waited for the active one (an "already in flight" refusal would say so), and
    // the active run's journal record then put it inside the 6 h window.
    expectDebounced(await harvestThenSweep);
    expect(sweepStreamCount).toBe(1);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("runs an archive final pass after harvest if the workspace is archived mid-harvest", async () => {
    let releaseHarvest!: () => void;
    const harvestReleased = new Promise<void>((resolve) => {
      releaseHarvest = resolve;
    });
    let markHarvestStarted!: () => void;
    const harvestStarted = new Promise<void>((resolve) => {
      markHarvestStarted = resolve;
    });
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            if (isHarvest) {
              markHarvestStarted();
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  async pull(controller) {
                    await harvestReleased;
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 0, text: 0, reasoning: 0 },
                      },
                    });
                    controller.close();
                  },
                }),
              });
            }
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "sweep" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ],
              }),
            });
          },
        }),
    });
    const metadata = await seedCompactionEpoch(fixture);

    const harvestThenSweep = fixture.service.maybeHarvestThenSweep(metadata);
    await harvestStarted;
    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get("/projects/demo")
        ?.workspaces.find((entry) => entry.id === "ws-dream");
      if (workspace === undefined) throw new Error("missing test workspace");
      workspace.archivedAt = new Date().toISOString();
      return cfg;
    });
    const archive = fixture.service.maybeRun("ws-dream", "archive");

    releaseHarvest();
    expect((await archive).success).toBe(true);
    const result = await harvestThenSweep;
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.trigger).toBe("archive");
  });

  it("does not re-harvest a completed compaction boundary on a later trigger", async () => {
    let harvestStreamCount = 0;
    using fixture = await createFixture({
      modelFactory: () => {
        let harvestResponded = false;
        return new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            if (isHarvest && !harvestResponded) {
              harvestResponded = true;
              harvestStreamCount++;
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: harvestWriteChunks(),
                }),
              });
            }
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "sweep still ran" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ],
              }),
            });
          },
        });
      },
    });
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
    // The second compaction signal falls inside the 6 h window: no re-harvest, and no sweep.
    expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

    expect(harvestStreamCount).toBe(1);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("retries a failed harvest record without marking the boundary completed", async () => {
    let harvestAttempts = 0;
    using fixture = await createFixture({
      modelFactory: () => {
        let harvestResponded = false;
        return new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            if (isHarvest && !harvestResponded) {
              harvestResponded = true;
              harvestAttempts++;
              if (harvestAttempts === 1) {
                return Promise.resolve({
                  stream: new ReadableStream<LanguageModelV3StreamPart>({
                    pull(controller) {
                      controller.error(new Error("harvest failed"));
                    },
                  }),
                });
              }
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: harvestWriteChunks(),
                }),
              });
            }
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "sweep still ran" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ],
              }),
            });
          },
        });
      },
    });
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
    let status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord?.status).toBe("failed");
    expect(status.latestHarvestRecord?.attemptCount).toBe(1);

    // The retry harvests even though the sweep after it is inside the 6 h window.
    expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));
    status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord?.status).toBe("completed");
    expect(status.latestHarvestRecord?.attemptCount).toBe(2);
    expect(harvestAttempts).toBe(2);
  });

  it("resumes a failed analyzer run at the chunk that failed, not at the start", async () => {
    const chunkLabels: string[] = [];
    let recordDuringChunkTwo: MemoryHarvestRecordPayload | null = null;
    let failedOnce = false;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: async (options) => {
            const prompt = userPromptText(options);
            const finish = {
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "no changes needed" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ] satisfies LanguageModelV3StreamPart[],
              }),
            };
            const afterToolResult = options.prompt.some((message) => message.role === "tool");
            if (!prompt.includes("just-compacted transcript epoch") || afterToolResult) {
              return finish;
            }
            const label = /Transcript chunk (\d+\/\d+)/.exec(prompt)?.[1] ?? "";
            chunkLabels.push(label);
            const write = (name: string) => ({
              stream: simulateReadableStream({
                chunks: harvestWriteChunks(`/memories/workspace/${name}.md`, `${name}\n`),
              }),
            });
            if (!failedOnce) {
              if (label.startsWith("1/")) return write("one");
              recordDuringChunkTwo = (await fixture.service.getStatus("ws-dream"))
                .latestHarvestRecord;
              failedOnce = true;
              return {
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  pull(controller) {
                    controller.error(new Error("provider exploded"));
                  },
                }),
              };
            }
            return label.startsWith("2/") ? write("two") : finish;
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);
    const ctx = {
      runtime: null,
      checkoutCwd: "",
      workspaceId: "ws-dream",
      projectPath: "/projects/demo",
    };

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    // The cursor reached disk as soon as chunk 1 finished, before chunk 2 failed.
    expect(recordDuringChunkTwo).toMatchObject({ status: "pending", nextChunk: 1 });
    let status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "failed",
      attemptCount: 1,
      nextChunk: 1,
      acceptedCandidates: 1,
      ops: [{ command: "create", path: "/memories/workspace/one.md", applied: true }],
    });

    expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

    // Chunk 1's model is not called again on the retry.
    expect(chunkLabels).toEqual(["1/3", "2/3", "2/3", "3/3"]);
    status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "completed",
      attemptCount: 2,
      nextChunk: 3,
      acceptedCandidates: 2,
      skippedCandidates: 0,
    });
    expect(status.latestHarvestRecord?.ops?.map((op) => op.path)).toEqual([
      "/memories/workspace/one.md",
      "/memories/workspace/two.md",
    ]);
    for (const name of ["one", "two"]) {
      expect(
        await fixture.memoryService.readFileWithSha(ctx, `/memories/workspace/${name}.md`)
      ).toMatchObject({ success: true });
    }
  });

  it("adds the tokens of the chunks a failed attempt finished to the completed record", async () => {
    let failedOnce = false;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            if (!failedOnce && userPromptText(options).includes("Transcript chunk 2/3")) {
              failedOnce = true;
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  pull(controller) {
                    controller.error(new Error("provider exploded"));
                  },
                }),
              });
            }
            // Every other call, a harvest chunk or a sweep, is one clean stream of 1 token each way.
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "no changes needed" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ] satisfies LanguageModelV3StreamPart[],
              }),
            });
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
    let status = await fixture.service.getStatus("ws-dream");
    // Chunk 1 finished and chunk 2 failed: the failed record keeps what chunk 1 cost.
    expect(status.latestHarvestRecord).toMatchObject({
      status: "failed",
      nextChunk: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

    // The retry ran chunks 2 and 3 only; the record counts all three.
    status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "completed",
      attemptCount: 2,
      usage: { inputTokens: 3, outputTokens: 3 },
    });
  });

  it("keeps the budget spent and the failed chunk's landed edits in its record, and the retry uses both", async () => {
    const chunkTwoPrompts: string[] = [];
    let failedOnce = false;
    const done = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "no changes needed" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ] satisfies LanguageModelV3StreamPart[],
      }),
    });
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const prompt = userPromptText(options);
            if (!prompt.includes("just-compacted transcript epoch")) return Promise.resolve(done());
            const afterToolResult = options.prompt.some((message) => message.role === "tool");
            const label = /Transcript chunk (\d+)\//.exec(prompt)?.[1];
            if (label === "1" && !afterToolResult) {
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: harvestWriteChunks("/memories/workspace/one.md"),
                }),
              });
            }
            if (label !== "2") return Promise.resolve(done());
            if (failedOnce) {
              chunkTwoPrompts.push(prompt);
              return Promise.resolve(done());
            }
            if (!afterToolResult) {
              // One edit lands and one dispatch fails (both spend budget), then the stream dies.
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: [
                    ...harvestWriteChunks("/memories/workspace/two.md").slice(0, 1),
                    {
                      type: "tool-call",
                      toolCallId: "missing-edit",
                      toolName: "memory",
                      input: JSON.stringify({
                        command: "str_replace",
                        path: "/memories/workspace/missing.md",
                        old_str: "a",
                        new_str: "b",
                      }),
                    },
                    ...harvestWriteChunks("/memories/workspace/two.md").slice(1),
                  ] satisfies LanguageModelV3StreamPart[],
                }),
              });
            }
            failedOnce = true;
            return Promise.resolve({
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                pull(controller) {
                  controller.error(new Error("provider exploded"));
                },
              }),
            });
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    let status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "failed",
      nextChunk: 1,
      // Chunk one's edit, then chunk two's edit and its failed dispatch.
      budgetUsed: 3,
      nextChunkOps: 2,
    });

    expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

    expect(chunkTwoPrompts[0]).toContain("/memories/workspace/two.md");
    expect(chunkTwoPrompts[0]).not.toContain("/memories/workspace/one.md");
    status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord).toMatchObject({
      status: "completed",
      nextChunk: 3,
      budgetUsed: 3,
      nextChunkOps: 0,
    });
  });

  it("skips the chunks left once the epoch's edit budget is spent, and notes it in the record", async () => {
    const chunkLabels: string[] = [];
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const prompt = userPromptText(options);
            const afterToolResult = options.prompt.some((message) => message.role === "tool");
            if (!prompt.includes("just-compacted transcript epoch") || afterToolResult) {
              return Promise.resolve({ stream: noChangesStream() });
            }
            chunkLabels.push(/Transcript chunk (\d+\/\d+)/.exec(prompt)?.[1] ?? "");
            return Promise.resolve({
              stream: spendEveryEditStream(),
            });
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    // Chunk 1 spent all of the epoch's edits, so chunks 2 and 3 made no model call.
    expect(chunkLabels).toEqual(["1/3"]);
    const record = (await fixture.service.getStatus("ws-dream")).latestHarvestRecord;
    expect(record).toMatchObject({
      status: "completed",
      nextChunk: 3,
      budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
    });
    expect(record?.note).toContain("chunks 2-3 of 3");
  });

  it("resumes at the first chunk nobody read when saving the completed record failed after a budget skip", async () => {
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const prompt = userPromptText(options);
            const afterToolResult = options.prompt.some((message) => message.role === "tool");
            return Promise.resolve({
              stream:
                prompt.includes("just-compacted transcript epoch") && !afterToolResult
                  ? spendEveryEditStream()
                  : noChangesStream(),
            });
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);
    const service = fixture.service as unknown as {
      saveHarvestRecordEffect: (
        workspaceId: string,
        boundaryKey: string,
        record: MemoryHarvestRecordPayload,
        projectPath: string
      ) => Effect.Effect<void>;
    };
    const save = service.saveHarvestRecordEffect.bind(service);
    let failedOnce = false;
    spyOn(service, "saveHarvestRecordEffect").mockImplementation(
      (workspaceId, boundaryKey, record, projectPath) => {
        if (record.status !== "completed" || failedOnce) {
          return save(workspaceId, boundaryKey, record, projectPath);
        }
        failedOnce = true;
        return Effect.promise(() => Promise.reject(new Error("disk full")));
      }
    );

    await fixture.service.maybeHarvestThenSweep(metadata);
    // The failed record resumes at the first chunk nobody read, not past the skipped ones.
    expect((await fixture.service.getStatus("ws-dream")).latestHarvestRecord).toMatchObject({
      status: "failed",
      nextChunk: 1,
    });

    await fixture.service.maybeHarvestThenSweep(metadata);
    const record = (await fixture.service.getStatus("ws-dream")).latestHarvestRecord;
    expect(record?.status).toBe("completed");
    // The retry meets the spent budget again and says which chunks it skipped.
    expect(record?.note).toContain("chunks 2-3 of 3");
  });

  it("keeps the edits of a chunk that wrote and then failed in the failed record", async () => {
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            const afterToolResult = options.prompt.some((message) => message.role === "tool");
            if (isHarvest && !afterToolResult) {
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: harvestWriteChunks("/memories/workspace/landed.md", "landed\n"),
                }),
              });
            }
            if (isHarvest) {
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  pull(controller) {
                    controller.error(new Error("provider exploded"));
                  },
                }),
              });
            }
            return Promise.resolve({ stream: noChangesStream() });
          },
        }),
    });
    const metadata = await seedCompactionEpoch(fixture);

    await fixture.service.maybeHarvestThenSweep(metadata);

    // The write landed in memory, so the record that a retry resumes from must say so.
    expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
      status: "failed",
      nextChunk: 0,
      acceptedCandidates: 1,
      budgetUsed: 1,
      nextChunkOps: 1,
      ops: [{ command: "create", path: "/memories/workspace/landed.md", applied: true }],
    });
  });

  it("refuses a harvest for a workspace that another backend is removing, before any model call", async () => {
    const models = archivePassModels();
    using fixture = await createFixture({ modelFactory: models.factory });
    const metadata = await seedCompactionEpoch(fixture);
    await appendRows(fixture, openRowTexts);
    // History writes refuse once the tombstone exists, so the rows come first.
    const tombstonePath = workspaceRemovalTombstonePath(fixture.xumHome, "ws-dream");
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fsPromises.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: "ws-dream", removedAt: Date.now() })
    );
    const harvested = await fixture.service.maybeHarvestThenSweep(metadata);
    expect(harvested.success).toBe(false);
    if (!harvested.success) expect(harvested.error).toContain("being removed");
    const archived = await fixture.service.maybeRunArchivePass("ws-dream");
    expect(archived.success).toBe(false);

    expect(models.runs).toEqual([]);
    expect(await harvestRecords(fixture)).toEqual({});
  });

  it("records an analyzer write outside workspace memory as rejected and never applies it", async () => {
    let harvestStep = 0;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (options) => {
            const isHarvest = userPromptText(options).includes("just-compacted transcript epoch");
            const chunks: LanguageModelV3StreamPart[] =
              isHarvest && harvestStep++ === 0
                ? [
                    harvestWriteChunks("/memories/global/promoted.md", "global\n")[0],
                    ...harvestWriteChunks("/memories/workspace/kept.md", "kept\n"),
                  ]
                : [
                    { type: "text-start", id: "t1" },
                    { type: "text-delta", id: "t1", delta: "no changes needed" },
                    { type: "text-end", id: "t1" },
                    {
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                      },
                    },
                  ];
            return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
          },
        }),
    });
    const metadata = await seedCompactionEpoch(fixture);

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    const record = (await fixture.service.getStatus("ws-dream")).latestHarvestRecord;
    expect(record).toMatchObject({
      status: "completed",
      acceptedCandidates: 1,
      skippedCandidates: 1,
    });
    expect(Object.fromEntries((record?.ops ?? []).map((op) => [op.path, op.applied]))).toEqual({
      "/memories/workspace/kept.md": true,
      "/memories/global/promoted.md": false,
    });
    expect(await pathExists(path.join(fixture.xumHome, "memory", "global", "promoted.md"))).toBe(
      false
    );
  });

  it("recovers retryable failed harvest records before a production sweep trigger", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    const metadata = await seedCompactionEpoch(fixture);
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-dream": {
            [metadata.summaryMessageId]: {
              status: "failed",
              startedAt: Date.now() - 10_000,
              completedAt: Date.now() - 9_000,
              attemptCount: 1,
              boundaryKey: metadata.summaryMessageId,
              compactionEpoch: metadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "transient provider error",
              completionMetadata: metadata,
            },
          },
        },
      })
    );

    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

    const status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord?.status).toBe("completed");
    expect(status.latestHarvestRecord?.attemptCount).toBe(2);
    // The manual sweep, then the recovered harvest; the sweep after that harvest is debounced.
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("normalizes stale max-attempt pending harvest records to failed", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    const metadata = await seedCompactionEpoch(fixture);
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-dream": {
            [metadata.summaryMessageId]: {
              status: "pending",
              startedAt: Date.now() - 10 * 60 * 1000,
              attemptCount: 3,
              boundaryKey: metadata.summaryMessageId,
              compactionEpoch: metadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              completionMetadata: metadata,
            },
          },
        },
      })
    );

    expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

    const status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord?.status).toBe("failed");
    expect(status.latestHarvestRecord?.attemptCount).toBe(3);
  });

  it("debounces automatic triggers but lets manual and archive runs through", async () => {
    using fixture = await createFixture();
    expect((await fixture.service.maybeRun("ws-dream", "compaction")).success).toBe(true);

    const debounced = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(debounced.success).toBe(false);
    if (!debounced.success) expect(debounced.error).toContain("debounced");

    // Archive bypasses debounce: it is the workspace's one-shot final pass
    // for promoting durable lessons to the narrowest available scope and
    // typically lands right after a compaction-triggered run anchored the debounce window.
    const archive = await fixture.service.maybeRun("ws-dream", "archive");
    expect(archive.success).toBe(true);

    const manual = await fixture.service.maybeRun("ws-dream", "manual");
    expect(manual.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(3);
  });

  it("a second compaction inside the debounce window harvests but starts no dream stream, while archive still does", async () => {
    // Each dream pass reads every memory file, so a compaction must not buy one more
    // inside the 6 h window; the harvest still files its candidates for the next pass.
    let dreamStreams = 0;
    using fixture = await createFixture({
      modelFactory: () =>
        scriptedModel((prompt) => {
          if (!prompt.includes("just-compacted transcript epoch")) dreamStreams++;
        }),
    });
    const first = await seedCompactionEpoch(fixture);
    expect((await fixture.service.maybeHarvestThenSweep(first)).success).toBe(true);
    expect(dreamStreams).toBe(1);

    const second = await seedCompactionEpoch(fixture, "ws-dream", 2, first.summaryHistorySequence);
    expectDebounced(await fixture.service.maybeHarvestThenSweep(second));
    expect(dreamStreams).toBe(1);
    const status = await fixture.service.getStatus("ws-dream");
    expect(status.latestHarvestRecord?.boundaryKey).toBe("summary-2");
    expect(status.latestHarvestRecord?.status).toBe("completed");

    // Archived mid-flight, the same compaction signal becomes the one-shot final pass.
    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get("/projects/demo")
        ?.workspaces.find((entry) => entry.id === "ws-dream");
      if (workspace === undefined) throw new Error("missing test workspace");
      workspace.archivedAt = new Date().toISOString();
      return cfg;
    });
    const third = await seedCompactionEpoch(fixture, "ws-dream", 3, second.summaryHistorySequence);
    const archive = await fixture.service.maybeHarvestThenSweep(third);
    expect(archive.success).toBe(true);
    if (archive.success) expect(archive.data.trigger).toBe("archive");
    expect(dreamStreams).toBe(2);
  });

  it("routes project-specific archive final-pass promotions to project memory when available", async () => {
    using fixture = await createFixture();

    const result = await fixture.service.maybeRun("ws-dream", "archive");
    expect(result.success).toBe(true);

    const prompt = fixture.modelPrompts.at(-1) ?? "";
    expect(prompt).toMatch(/repo-specific[\s\S]*\/memories\/project\//);
    expect(prompt).toMatch(/cross-project[\s\S]*\/memories\/global\//);
    expect(prompt).not.toMatch(
      /durable lessons from \/memories\/workspace\/\.\.\. to \/memories\/global\//
    );
  });

  it("does not advertise project-scope promotion in archive final-pass prompts when unavailable", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-multi");

    const result = await fixture.service.maybeRun("ws-multi", "archive");
    expect(result.success).toBe(true);

    const prompt = fixture.modelPrompts.at(-1) ?? "";
    expect(prompt).not.toContain("/memories/project/");
    expect(prompt).toMatch(/cross-project[\s\S]*\/memories\/global\//);
    expect(prompt).toMatch(/not promote[\s\S]*project-specific[\s\S]*global/);
  });

  it("rejects a second trigger while a run is still in flight", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    using fixture = await createFixture({ modelGate });

    // Run lock must be reserved synchronously: the model-creation await keeps
    // the first run open while the second trigger arrives.
    const first = fixture.service.maybeRun("ws-dream", "manual");
    const second = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain("in flight");

    releaseModel();
    expect((await first).success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("queues an archive trigger behind an in-flight run instead of dropping it", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    using fixture = await createFixture({ modelGate });

    const first = fixture.service.maybeRun("ws-dream", "compaction");
    // The archive caller never retries and only archive sets finalPass, so
    // dropping it here would silently skip final-scope promotion.
    const archive = fixture.service.maybeRun("ws-dream", "archive");
    const dropped = await fixture.service.maybeRun("ws-dream", "manual");
    expect(dropped.success).toBe(false);

    releaseModel();
    expect((await first).success).toBe(true);
    const archiveResult = await archive;
    expect(archiveResult.success).toBe(true);
    if (archiveResult.success) expect(archiveResult.data.trigger).toBe("archive");
    expect(fixture.modelCalls).toHaveLength(2);
  });

  describe("analyzer queue", () => {
    interface Gate {
      opened: Promise<void>;
      open: () => void;
    }
    function gate(): Gate {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    }

    /**
     * Models whose analyzer streams each hold until `release(id)`, numbered in the order they
     * start, with a log of when each starts and ends. A dream stream is not held, unless
     * `holdDream`: then the first one holds until `releaseDream()` and logs `dream-start` and
     * `dream-end` (a later one, such as a sweep, passes). `modelCreated(n)` and `streamStarted(n)`
     * resolve on the events themselves, so a test waits on what happened, not on how long it took.
     */
    function heldAnalyzers(config?: { holdDream?: boolean }) {
      const events: string[] = [];
      const dream = { started: gate(), released: gate() };
      const gates = {
        created: new Map<number, Gate>(),
        started: new Map<number, Gate>(),
        released: new Map<number, Gate>(),
      };
      const gateFor = (kind: keyof typeof gates, id: number): Gate => {
        let found = gates[kind].get(id);
        if (found === undefined) {
          found = gate();
          gates[kind].set(id, found);
        }
        return found;
      };
      let modelsCreated = 0;
      let analyzerStreams = 0;
      const factory = () => {
        gateFor("created", ++modelsCreated).open();
        const inner = scriptedModel();
        return new MockLanguageModelV3({
          doStream: async (options) => {
            if (!userPromptText(options).includes("just-compacted transcript epoch")) {
              if (config?.holdDream !== true) return inner.doStream(options);
              events.push("dream-start");
              dream.started.open();
              await dream.released.opened;
              events.push("dream-end");
              return inner.doStream(options);
            }
            const id = ++analyzerStreams;
            events.push(`start-${id}`);
            gateFor("started", id).open();
            await gateFor("released", id).opened;
            events.push(`end-${id}`);
            return inner.doStream(options);
          },
        });
      };
      return {
        events,
        factory,
        modelCreated: (id: number) => gateFor("created", id).opened,
        streamStarted: (id: number) => gateFor("started", id).opened,
        release: (id: number) => gateFor("released", id).open(),
        dreamStarted: dream.started.opened,
        releaseDream: () => dream.released.open(),
      };
    }

    /** Lets every reaction already queued on a promise run. Nothing here waits for elapsed time. */
    async function settle(): Promise<void> {
      for (let turn = 0; turn < 5; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    /**
     * Starts `first`'s analyzer and holds its stream, then starts `second`'s: past its model
     * creation, the second run has only its turn left to wait for. Returns once both settled.
     */
    async function runSecondBehindFirst(
      fixture: Fixture,
      held: ReturnType<typeof heldAnalyzers>,
      first: CompactionCompletionMetadata,
      second: CompactionCompletionMetadata
    ): Promise<void> {
      const firstRun = fixture.service.maybeHarvestThenSweep(first);
      await held.streamStarted(1);
      const secondRun = fixture.service.maybeHarvestThenSweep(second);
      await held.modelCreated(2);
      await settle();
      expect(held.events).toEqual(["start-1"]);

      held.release(1);
      await held.streamStarted(2);
      expect(held.events).toEqual(["start-1", "end-1", "start-2"]);
      held.release(2);
      await Promise.all([firstRun, secondRun]);
      expect(held.events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    }

    it("runs the analyzers of two compaction boundaries of one workspace one after the other", async () => {
      const held = heldAnalyzers();
      using fixture = await createFixture({ modelFactory: held.factory });
      const first = await seedCompactionEpoch(fixture);
      const second = await seedCompactionEpoch(
        fixture,
        "ws-dream",
        2,
        first.summaryHistorySequence
      );

      await runSecondBehindFirst(fixture, held, first, second);

      const records = await harvestRecords(fixture);
      expect(records["summary-1"]?.status).toBe("completed");
      expect(records["summary-2"]?.status).toBe("completed");
    });

    it("runs a sub-agent's analyzer after its owner's, since both write the owner's workspace memory", async () => {
      const held = heldAnalyzers();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
      const owner = await seedCompactionEpoch(fixture);
      const child = await seedCompactionEpoch(fixture, "ws-sub");

      await runSecondBehindFirst(fixture, held, owner, child);

      expect((await harvestRecords(fixture, "ws-dream"))["summary-1"]?.status).toBe("completed");
      expect((await harvestRecords(fixture, "ws-sub"))["summary-1"]?.status).toBe("completed");
    });

    it("runs the chunks of two unrelated workspaces one after the other, like every memory-writing stream", async () => {
      // The dream's exclusion is service-wide: its lock file is one for the root, so a chunk of
      // another owner cannot hold it beside this one. Each owner still has its own job queue.
      const held = heldAnalyzers();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-other");
      const first = await seedCompactionEpoch(fixture);
      const other = await seedCompactionEpoch(fixture, "ws-other");

      await runSecondBehindFirst(fixture, held, first, other);

      expect((await harvestRecords(fixture))["summary-1"]?.status).toBe("completed");
      expect((await harvestRecords(fixture, "ws-other"))["summary-1"]?.status).toBe("completed");
    });

    it("starts the owner's next analyzer while the previous one's usage is still being recorded", async () => {
      // Recording usage takes the session directory's lock: a stall there must not hold every later
      // analyzer of the owner, and the usage of both chunks must still be recorded afterwards.
      const held = heldAnalyzers();
      using fixture = await createFixture({ modelFactory: held.factory, withSessionUsage: true });
      const first = await seedCompactionEpoch(fixture);
      const second = await seedCompactionEpoch(
        fixture,
        "ws-dream",
        2,
        first.summaryHistorySequence
      );
      held.release(1);
      held.release(2);
      const usageEntered = gate();
      const usageStalled = gate();
      const recordedAnalyzers: string[] = [];
      spyOn(fixture.sessionUsage!, "recordHeadlessUsage").mockImplementation(
        async (workspaceId, _model, _usage, _providerMetadata, options) => {
          if (options?.analyticsSource !== "memory_harvest") return undefined;
          recordedAnalyzers.push(workspaceId);
          usageEntered.open();
          await usageStalled.opened;
          return undefined;
        }
      );

      let giveUp: ReturnType<typeof setTimeout> | undefined;
      try {
        const firstRun = fixture.service.maybeHarvestThenSweep(first);
        await usageEntered.opened;
        const secondRun = fixture.service.maybeHarvestThenSweep(second);
        await held.modelCreated(2);
        // The stream starting is the event waited for. The bound only turns a run stuck behind
        // the first one's usage into a failed assertion instead of a test timeout.
        const started = held.streamStarted(2).then(() => true);
        const gaveUp = new Promise<boolean>((resolve) => {
          giveUp = setTimeout(() => resolve(false), 2_000);
        });
        expect(await Promise.race([started, gaveUp])).toBe(true);

        usageStalled.open();
        await Promise.all([firstRun, secondRun]);
        expect(recordedAnalyzers).toEqual(["ws-dream", "ws-dream"]);
      } finally {
        clearTimeout(giveUp);
        usageStalled.open();
      }
    });

    it("lets removal cancel an analyzer that is still waiting its turn, without wedging the queue", async () => {
      const held = heldAnalyzers();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
      const owner = await seedCompactionEpoch(fixture);
      const child = await seedCompactionEpoch(fixture, "ws-sub");

      const ownerRun = fixture.service.maybeHarvestThenSweep(owner);
      await held.streamStarted(1);
      const childRun = fixture.service.maybeHarvestThenSweep(child);
      await held.modelCreated(2);
      await settle();

      await fixture.service.cancelInFlightConsolidation("ws-sub");
      await childRun;
      // The cancelled run never read a chunk; the owner's stream is untouched.
      expect(held.events).toEqual(["start-1"]);
      expect((await harvestRecords(fixture, "ws-sub"))["summary-1"]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("before its turn") as string,
      });

      held.release(1);
      await ownerRun;
      const next = await seedCompactionEpoch(fixture, "ws-dream", 2, owner.summaryHistorySequence);
      const nextRun = fixture.service.maybeHarvestThenSweep(next);
      await held.streamStarted(2);
      held.release(2);
      await nextRun;
      expect((await harvestRecords(fixture, "ws-dream"))["summary-2"]?.status).toBe("completed");
    });

    it("seeds a record's edit budget when its turn arrives, so an archive and a compaction of one epoch overlapping share it", async () => {
      // The compaction's job reads the earlier records before it waits behind the archive's
      // analyzer, and what the archive spends meanwhile reaches disk only when its record completes.
      const created = [gate(), gate()];
      const streamStarted = [gate(), gate()];
      const released = [gate(), gate()];
      const models = editsEveryRunModels(5, async (run) => {
        streamStarted[run - 1]?.open();
        await released[run - 1]?.opened;
      });
      let modelsCreated = 0;
      using fixture = await createFixture({
        modelFactory: () => {
          created[modelsCreated++]?.open();
          return models.factory();
        },
      });
      await appendRows(fixture, openRowTexts);

      const archive = fixture.service.maybeRunArchivePass("ws-dream");
      await streamStarted[0]?.opened;
      const compaction = fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));
      await created[1]?.opened;
      await settle();
      expect(models.analyzerRuns()).toBe(1);

      released[0]?.open();
      await streamStarted[1]?.opened;
      released[1]?.open();
      expect((await archive).success).toBe(true);
      // The compaction's own dream is debounced behind the archive's: only its analysis matters.
      await compaction;

      const records = await harvestRecords(fixture);
      // The archive's 5 edits all landed. The compaction tried 5 more and got the 3 that are left.
      expect(records["open:open-2"]?.budgetUsed).toBe(5);
      expect(records["summary-1"]?.ops?.filter((op) => op.applied)).toHaveLength(3);
      expect(records["summary-1"]?.budgetUsed).toBe(MEMORY_ANALYZER_OP_BUDGET);
    });

    /**
     * An archive pass held in its analyzer, and the compaction that `closeEpoch` makes for the
     * same epoch, started behind it: past its model creation, so only its turn is left to wait
     * for. The compaction's job reads the earlier records before that wait, and the archive's
     * rows reach them only as its analyzer finishes chunks. Returns once both ended.
     */
    async function compactionBehindHeldArchive(
      closeEpoch: (fixture: Fixture) => Promise<CompactionCompletionMetadata>
    ) {
      const releaseArchive = gate();
      const secondModel = gate();
      const models = archivePassModels({ holdFirstAnalyzer: releaseArchive.opened });
      let modelsCreated = 0;
      using fixture = await createFixture({
        modelFactory: () => {
          if (++modelsCreated === 2) secondModel.open();
          return models.factory();
        },
      });
      await appendRows(fixture, openRowTexts);

      const archive = fixture.service.maybeRunArchivePass("ws-dream");
      await models.firstAnalyzerStarted;
      const compaction = fixture.service.maybeHarvestThenSweep(await closeEpoch(fixture));
      await secondModel.opened;
      await settle();
      expect(models.runs.filter((run) => run.kind === "analyzer")).toHaveLength(1);

      releaseArchive.open();
      expect((await archive).success).toBe(true);
      await compaction;
      return {
        analyzerPrompts: models.runs
          .filter((run) => run.kind === "analyzer")
          .map((run) => run.prompt),
        records: await harvestRecords(fixture),
      };
    }

    it("starts a compaction that waited behind the archive of its epoch after the rows that archive read", async () => {
      // seedCompactionEpoch adds one more row, "remember that I prefer concise tests".
      const { analyzerPrompts, records } = await compactionBehindHeldArchive((fixture) =>
        seedCompactionEpoch(fixture)
      );

      expect(analyzerPrompts).toHaveLength(2);
      const closing = analyzerPrompts[1] ?? "";
      expect(closing).toContain("remember that I prefer concise tests");
      expect(closing).not.toContain("We settled on bun");
      expect(closing).not.toContain("never npm");
      expect(records["summary-1"]?.status).toBe("completed");
    });

    it("makes no analyzer call for a compaction that waited behind the archive that read all of its epoch", async () => {
      const { analyzerPrompts, records } =
        await compactionBehindHeldArchive(closeEpochWithoutNewRows);

      expect(analyzerPrompts).toHaveLength(1);
      expect(records["summary-1"]).toMatchObject({
        status: "completed",
        nextChunk: 0,
        analyzedFloorRowId: "open-2",
      });
    });

    it("keeps a failed run's landed edits in the sidecar before the next run's turn, so that run seeds its budget with them", async () => {
      // The failed record is saved after the turn is released, so what the run spent before its
      // chunk failed reaches the sidecar in that save alone. Holding it here makes the order
      // deterministic: the next run must find the spend without it.
      const created = [gate(), gate()];
      const streamStarted = [gate(), gate()];
      const released = [gate(), gate()];
      const failedSaveReleased = gate();
      const models = editsEveryRunModels(
        5,
        async (run) => {
          streamStarted[run - 1]?.open();
          await released[run - 1]?.opened;
        },
        1
      );
      let modelsCreated = 0;
      using fixture = await createFixture({
        modelFactory: () => {
          created[modelsCreated++]?.open();
          return models.factory();
        },
      });
      await appendRows(fixture, openRowTexts);
      const internals = fixture.service as unknown as {
        saveHarvestRecordEffect: (
          workspaceId: string,
          boundaryKey: string,
          record: { status: string },
          projectPath: string
        ) => Effect.Effect<void>;
      };
      const saveHarvestRecord = internals.saveHarvestRecordEffect.bind(fixture.service);
      spyOn(internals, "saveHarvestRecordEffect").mockImplementation(
        (workspaceId, boundaryKey, record, projectPath) =>
          record.status === "failed"
            ? Effect.flatMap(
                Effect.promise(() => failedSaveReleased.opened),
                () => saveHarvestRecord(workspaceId, boundaryKey, record, projectPath)
              )
            : saveHarvestRecord(workspaceId, boundaryKey, record, projectPath)
      );

      try {
        const archive = fixture.service.maybeRunArchivePass("ws-dream");
        await streamStarted[0]?.opened;
        const compaction = fixture.service.maybeHarvestThenSweep(
          await seedCompactionEpoch(fixture)
        );
        await created[1]?.opened;
        await settle();
        expect(models.analyzerRuns()).toBe(1);

        released[0]?.open();
        await streamStarted[1]?.opened;
        released[1]?.open();
        await compaction;
        failedSaveReleased.open();
        expect((await archive).success).toBe(true);

        const records = await harvestRecords(fixture);
        // The archive's analyzer landed 5 edits and then failed. The compaction tried 5 more and
        // got the 3 that are left of the epoch's budget.
        expect(records["open:open-2"]).toMatchObject({ status: "failed", budgetUsed: 5 });
        expect(records["summary-1"]?.ops?.filter((op) => op.applied)).toHaveLength(3);
        expect(records["summary-1"]?.budgetUsed).toBe(MEMORY_ANALYZER_OP_BUDGET);
      } finally {
        failedSaveReleased.open();
        released[0]?.open();
        released[1]?.open();
      }
    });

    describe("an archive whose analyzer turn comes after the compaction that closed its epoch", () => {
      /**
       * An archive pass that took its snapshot of the open epoch and is held at its model creation,
       * before its analyzer turn. The compaction that closes the epoch then runs to the end, and
       * only then does the archive's turn arrive. The compaction's record, keyed by its summary,
       * is then the only record of the rows and edits already spent.
       */
      async function archiveBehindClosingCompaction(
        editsPerRun: number,
        appendEpochRows: (fixture: Fixture) => Promise<void>
      ) {
        const archiveSnapshotted = gate();
        const releaseArchive = gate();
        const models = editsEveryRunModels(editsPerRun);
        using fixture = await createFixture({
          modelFactory: models.factory,
          beforeModelCreated: async (call) => {
            if (call !== 1) return;
            archiveSnapshotted.open();
            await releaseArchive.opened;
          },
        });
        await appendEpochRows(fixture);

        const archive = fixture.service.maybeRunArchivePass("ws-dream");
        await archiveSnapshotted.opened;
        // The compaction's own dream follows its analysis; only the analysis matters here.
        await fixture.service.maybeHarvestThenSweep(await closeEpochWithoutNewRows(fixture));
        const analyzerRunsBeforeArchiveTurn = models.analyzerRuns();

        releaseArchive.open();
        expect((await archive).success).toBe(true);
        return {
          analyzerRunsBeforeArchiveTurn,
          analyzerRunsAfterArchive: models.analyzerRuns(),
          records: await harvestRecords(fixture),
        };
      }

      it("does not read again the rows the compaction read", async () => {
        const { analyzerRunsBeforeArchiveTurn, analyzerRunsAfterArchive, records } =
          await archiveBehindClosingCompaction(5, (fixture) => appendRows(fixture, openRowTexts));

        expect(analyzerRunsBeforeArchiveTurn).toBe(1);
        expect(records["summary-1"]).toMatchObject({
          status: "completed",
          readThroughRowId: "open-2",
        });
        // The compaction read both rows: the archive finds nothing left, so it makes no model call.
        expect(analyzerRunsAfterArchive).toBe(1);
        expect(records["open:open-2"]).toMatchObject({
          status: "completed",
          nextChunk: 0,
          analyzedFloorRowId: "open-2",
        });
      });

      it("starts from the edits the compaction spent on the epoch's budget", async () => {
        const { analyzerRunsBeforeArchiveTurn, analyzerRunsAfterArchive, records } =
          await archiveBehindClosingCompaction(MEMORY_ANALYZER_OP_BUDGET, (fixture) =>
            appendBulkRows(fixture)
          );

        // The compaction spent the whole budget on its first chunk and skipped the other two.
        expect(analyzerRunsBeforeArchiveTurn).toBe(1);
        expect(records["summary-1"]).toMatchObject({
          status: "completed",
          budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
          readThroughRowId: "bulk-4",
        });
        // The archive's floor leaves it the rows of those two chunks. Seeded with the spent
        // budget it skips them without a model call; on a fresh budget it would edit memory again.
        expect(analyzerRunsAfterArchive).toBe(1);
        expect(records["open:bulk-11"]).toMatchObject({
          status: "completed",
          budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
          analyzedFloorRowId: "bulk-4",
        });
        expect(records["open:bulk-11"]?.note).toContain("edit budget spent");
      });
    });

    // The analyzer and the dream edit the same /memories/workspace files, and the dream's `insert`
    // takes a line offset from an earlier read: the two streams must never run at once.
    describe("with the dream stream's exclusion", () => {
      it("does not start a chunk while a dream stream of its owner holds the exclusion", async () => {
        const held = heldAnalyzers({ holdDream: true });
        using fixture = await createFixture({ modelFactory: held.factory });
        const epoch = await seedCompactionEpoch(fixture);
        held.release(1);

        const dreamRun = fixture.service.maybeRun("ws-dream", "manual");
        await held.dreamStarted;
        const harvestRun = fixture.service.maybeHarvestThenSweep(epoch);
        await held.modelCreated(2);
        await settle();
        expect(held.events).toEqual(["dream-start"]);

        held.releaseDream();
        await held.streamStarted(1);
        expect(held.events.slice(0, 3)).toEqual(["dream-start", "dream-end", "start-1"]);
        await Promise.all([dreamRun, harvestRun]);
        expect(held.events).toEqual(["dream-start", "dream-end", "start-1", "end-1"]);
        expect((await harvestRecords(fixture))["summary-1"]?.status).toBe("completed");
      });

      it("does not start a dream stream while a chunk of its owner is streaming", async () => {
        const held = heldAnalyzers({ holdDream: true });
        using fixture = await createFixture({ modelFactory: held.factory });
        const epoch = await seedCompactionEpoch(fixture);

        const harvestRun = fixture.service.maybeHarvestThenSweep(epoch);
        await held.streamStarted(1);
        const dreamRun = fixture.service.maybeRun("ws-dream", "manual");
        await held.modelCreated(2);
        // A dream with no exclusion to wait for still has disk work (its lock) before its stream,
        // which no count of loop turns bounds. The stream starting is the event waited for; the
        // bound only ends the wait of a dream that is held back, as it should be.
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        try {
          const startedEarly = await Promise.race([
            held.dreamStarted.then(() => true),
            new Promise<boolean>((resolve) => {
              giveUp = setTimeout(() => resolve(false), 250);
            }),
          ]);
          expect(startedEarly).toBe(false);
        } finally {
          clearTimeout(giveUp);
        }
        expect(held.events).toEqual(["start-1"]);

        held.release(1);
        await held.dreamStarted;
        expect(held.events.slice(0, 3)).toEqual(["start-1", "end-1", "dream-start"]);
        held.releaseDream();
        await Promise.all([harvestRun, dreamRun]);
      });

      it("starts a chunk's timeout when it gets the exclusion, not while it waits behind a dream stream", async () => {
        const held = heldAnalyzers({ holdDream: true });
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
          held.events.push("timeout");
          return realTimeout(ms);
        });
        try {
          using fixture = await createFixture({ modelFactory: held.factory });
          const epoch = await seedCompactionEpoch(fixture);
          held.release(1);

          const dreamRun = fixture.service.maybeRun("ws-dream", "manual");
          await held.dreamStarted;
          const harvestRun = fixture.service.maybeHarvestThenSweep(epoch);
          await held.modelCreated(2);
          await settle();
          // The dream's own timeout only: a chunk that waits has none running.
          expect(held.events).toEqual(["timeout", "dream-start"]);

          held.releaseDream();
          await held.streamStarted(1);
          expect(held.events.slice(0, 5)).toEqual([
            "timeout",
            "dream-start",
            "dream-end",
            "timeout",
            "start-1",
          ]);
          await Promise.all([dreamRun, harvestRun]);
        } finally {
          timeoutSpy.mockRestore();
        }
      });

      it("waits for a dream stream in another process before starting a chunk", async () => {
        const held = heldAnalyzers();
        using fixture = await createFixture({ modelFactory: held.factory });
        const epoch = await seedCompactionEpoch(fixture);
        held.release(1);
        const releaseForeign = await holdForeignDreamLock(fixture);
        try {
          const run = fixture.service.maybeHarvestThenSweep(epoch);
          await held.modelCreated(1);
          await settle();
          expect(held.events).toEqual([]);

          await releaseForeign();
          await held.streamStarted(1);
          await run;
          expect(held.events).toEqual(["start-1", "end-1"]);
          expect((await harvestRecords(fixture))["summary-1"]?.status).toBe("completed");
        } finally {
          await releaseForeign();
        }
      });

      it("lets removal cancel a chunk that is waiting for the exclusion, without wedging the queue", async () => {
        const held = heldAnalyzers();
        using fixture = await createFixture({ modelFactory: held.factory });
        await fixture.addWorkspace("ws-other");
        const epoch = await seedCompactionEpoch(fixture);
        const other = await seedCompactionEpoch(fixture, "ws-other");
        held.release(1);
        held.release(2);
        const releaseForeign = await holdForeignDreamLock(fixture);
        try {
          const run = fixture.service.maybeHarvestThenSweep(epoch);
          await held.modelCreated(1);
          await settle();

          await fixture.service.cancelInFlightConsolidation("ws-dream");
          await run;
          // No model call was made, and the run ended as a failed stream does: resumable.
          expect(held.events).toEqual([]);
          expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
            status: "failed",
            nextChunk: 0,
            error: expect.stringContaining("did not start") as string,
          });

          // The cancelled chunk gave its place in the queue back and never took the lock.
          await releaseForeign();
          await fixture.service.maybeHarvestThenSweep(other);
          expect(held.events).toEqual(["start-1", "end-1"]);
          expect((await harvestRecords(fixture, "ws-other"))["summary-1"]?.status).toBe(
            "completed"
          );
        } finally {
          await releaseForeign();
        }
      });

      it("fails the job, without a model call, when the exclusion's lock cannot be taken, and a retry runs it", async () => {
        const held = heldAnalyzers();
        using fixture = await createFixture({ modelFactory: held.factory });
        const epoch = await seedCompactionEpoch(fixture);
        held.release(1);
        const lockPath = dreamStreamLockPath(fixture.xumHome);
        const { writeFile } = fsPromises;
        // The lock's temp file cannot be written: a filesystem error, not contention.
        const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(async (file, data) => {
          if (typeof file === "string" && file.startsWith(`${lockPath}.tmp-`)) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          return writeFile(file, data);
        });
        try {
          await fixture.service.maybeHarvestThenSweep(epoch);
        } finally {
          writeSpy.mockRestore();
        }
        expect(held.events).toEqual([]);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "failed",
          attemptCount: 1,
          nextChunk: 0,
          error: expect.stringContaining("consolidation lock") as string,
        });

        await fixture.service.maybeHarvestThenSweep(epoch);
        expect(held.events).toEqual(["start-1", "end-1"]);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "completed",
          attemptCount: 2,
        });
      });
    });
  });

  describe("dream stream queue", () => {
    /**
     * Models whose streams each hold until `release(id)`, numbered in the order the runs created
     * them, and a log of when each stream starts and ends.
     */
    function heldStreams() {
      const events: string[] = [];
      const gates = new Map<number, () => void>();
      let created = 0;
      const factory = () => {
        const id = ++created;
        const inner = scriptedModel();
        return new MockLanguageModelV3({
          doStream: async (options) => {
            events.push(`start-${id}`);
            await new Promise<void>((resolve) => gates.set(id, resolve));
            events.push(`end-${id}`);
            return inner.doStream(options);
          },
        });
      };
      return { events, factory, release: (id: number) => gates.get(id)?.() };
    }

    async function until(condition: () => boolean): Promise<void> {
      for (let tick = 0; tick < 400 && !condition(); tick++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(condition()).toBe(true);
    }

    /**
     * Model creation is the last step of a run's setup that waits on the disk. What follows it up
     * to the stream is promise work only, so a few loop turns drain it: a run still without a
     * stream after them is waiting for its turn in the queue, not for the host.
     */
    async function waitingForTurn(fixture: Fixture, runs: number): Promise<void> {
      await until(() => fixture.modelCalls.length >= runs);
      for (let turn = 0; turn < 10; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it("starts a run's timeout when its turn arrives, not while it waits behind another stream", async () => {
      // Streams hold until released, so a second stream that starts anyway (no queue) shows up
      // in the log before the first one ends, however slow the host is.
      const held = heldStreams();
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      let timeoutCount = 0;
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        held.events.push(`timeout-${++timeoutCount}`);
        return realTimeout(ms);
      });
      try {
        using fixture = await createFixture({ modelFactory: held.factory });
        await fixture.addWorkspace("ws-other");

        const first = fixture.service.maybeRun("ws-dream", "manual");
        await until(() => held.events.includes("start-1"));
        const second = fixture.service.maybeRun("ws-other", "manual");
        await waitingForTurn(fixture, 2);
        expect(held.events).toEqual(["timeout-1", "start-1"]);

        held.release(1);
        await until(() => held.events.includes("start-2"));
        held.release(2);
        expect((await Promise.all([first, second])).every((run) => run.success)).toBe(true);
        expect(held.events).toEqual([
          "timeout-1",
          "start-1",
          "end-1",
          "timeout-2",
          "start-2",
          "end-2",
        ]);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it("frees the queue once a stream ends, while its usage is still being recorded", async () => {
      // Recording usage takes the session directory's lock: a stall there must not hold every
      // other workspace's dream, and the usage must still be recorded afterwards.
      let streamsStarted = 0;
      using fixture = await createFixture({
        withSessionUsage: true,
        modelFactory: () => {
          const inner = scriptedModel();
          return new MockLanguageModelV3({
            doStream: (options) => {
              streamsStarted++;
              return inner.doStream(options);
            },
          });
        },
      });
      await fixture.addWorkspace("ws-other");
      let releaseUsage!: () => void;
      const usageStalled = new Promise<void>((resolve) => {
        releaseUsage = resolve;
      });
      const recorded: string[] = [];
      spyOn(fixture.sessionUsage!, "recordHeadlessUsage").mockImplementation(
        async (workspaceId) => {
          recorded.push(workspaceId);
          await usageStalled;
          return undefined;
        }
      );

      try {
        const first = fixture.service.maybeRun("ws-dream", "manual");
        await until(() => recorded.length === 1);
        const second = fixture.service.maybeRun("ws-other", "manual");
        await until(() => streamsStarted === 2);

        releaseUsage();
        expect((await Promise.all([first, second])).every((run) => run.success)).toBe(true);
        expect(recorded.sort()).toEqual(["ws-dream", "ws-other"]);
      } finally {
        releaseUsage();
      }
    });

    it("waits for a dream stream in another process before starting its own", async () => {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      const releaseForeign = await holdForeignDreamLock(fixture);
      try {
        const run = fixture.service.maybeRun("ws-dream", "manual");
        await waitingForTurn(fixture, 1);
        expect(held.events).toEqual([]);

        await releaseForeign();
        await until(() => held.events.includes("start-1"));
        held.release(1);
        expect((await run).success).toBe(true);
      } finally {
        await releaseForeign();
      }
    });

    /**
     * A second backend on the same root: its own in-process queue and run table, the same sidecar
     * and the same dream lock. It counts the provider streams it starts.
     */
    function secondBackend(fixture: Fixture) {
      const counts = { modelsCreated: 0, streams: 0 };
      const service = new MemoryConsolidationService(
        fixture.config,
        fixture.memoryService,
        fixture.metaService,
        fixture.historyService,
        {
          createModelWithPinnedMetadata: (modelString: string) => {
            counts.modelsCreated++;
            const inner = scriptedModel();
            return Promise.resolve(
              Ok({
                model: new MockLanguageModelV3({
                  doStream: (options) => {
                    counts.streams++;
                    return inner.doStream(options);
                  },
                }),
                metadataModel: modelString,
              })
            );
          },
        },
        {
          isExperimentEnabled: (id) =>
            id === EXPERIMENT_IDS.MEMORY || id === EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
        }
      );
      return { service, counts };
    }

    /**
     * Both backends get the same trigger for one workspace before either has journaled, so both
     * pass the debounce check; this backend's run streams first and the other waits on the lock.
     */
    async function runBehindAnotherBackend(secondTrigger: "compaction" | "manual") {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      const second = secondBackend(fixture);

      const first = fixture.service.maybeRun("ws-dream", "compaction");
      await until(() => held.events.includes("start-1"));
      const behind = second.service.maybeRun("ws-dream", secondTrigger);
      await until(() => second.counts.modelsCreated === 1);
      expect(second.counts.streams).toBe(0);

      held.release(1);
      return { first: await first, behind: await behind, secondStreams: second.counts.streams };
    }

    it("skips an automatic run whose turn comes after another backend's run covered the workspace", async () => {
      const { first, behind, secondStreams } = await runBehindAnotherBackend("compaction");
      expect(first.success).toBe(true);
      expectDebounced(behind);
      expect(secondStreams).toBe(0);
    });

    it("still runs a manual trigger that waited behind another backend's run", async () => {
      const { first, behind, secondStreams } = await runBehindAnotherBackend("manual");
      expect(first.success).toBe(true);
      expect(behind.success).toBe(true);
      expect(secondStreams).toBe(1);
    });

    it("journals a run's success before it frees the dream lock", async () => {
      // The next run in any process rechecks the debounce from disk the moment it gets the lock,
      // so the record has to be there by then.
      using fixture = await createFixture();
      const lockPath = dreamStreamLockPath(fixture.xumHome);
      const sidecarPath = path.join(fixture.xumHome, "memory-consolidation.json");
      const journaledAtRelease: boolean[] = [];
      const { rm } = fsPromises;
      const rmSpy = spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
        if (target === lockPath) {
          const raw = await fsPromises.readFile(sidecarPath, "utf-8").catch(() => "{}");
          const file = JSON.parse(raw) as { workspaces?: Record<string, unknown> };
          journaledAtRelease.push(file.workspaces?.["ws-dream"] !== undefined);
        }
        return rm(target, options);
      });
      try {
        expect((await fixture.service.maybeRun("ws-dream", "compaction")).success).toBe(true);
      } finally {
        rmSpy.mockRestore();
      }
      expect(journaledAtRelease).toEqual([true]);
    });

    it("cancels a run that is waiting for another process's dream stream when its workspace is removed", async () => {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-other");
      const releaseForeign = await holdForeignDreamLock(fixture);
      try {
        const run = fixture.service.maybeRun("ws-other", "manual");
        await waitingForTurn(fixture, 1);

        await fixture.service.cancelInFlightConsolidation("ws-other");
        const cancelled = await run;
        expect(cancelled.success).toBe(false);
        if (!cancelled.success) expect(cancelled.error).toContain("being removed");
        expect(held.events).toEqual([]);

        // The cancelled run released its queue slot and never took the lock.
        await releaseForeign();
        const next = fixture.service.maybeRun("ws-dream", "manual");
        await until(() => held.events.includes("start-2"));
        held.release(2);
        expect((await next).success).toBe(true);
      } finally {
        await releaseForeign();
      }
    });

    it("skips the run, without a stream or a journal row, when the dream lock cannot be taken", async () => {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      const lockPath = dreamStreamLockPath(fixture.xumHome);
      const { writeFile } = fsPromises;
      // The lock's temp file cannot be written: a filesystem error, not contention.
      const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(async (file, data) => {
        if (typeof file === "string" && file.startsWith(`${lockPath}.tmp-`)) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return writeFile(file, data);
      });
      try {
        const failed = await fixture.service.maybeRun("ws-dream", "manual");
        expect(failed.success).toBe(false);
        if (!failed.success) expect(failed.error).toContain("consolidation lock");
        expect(held.events).toEqual([]);
        expect(await fixture.service.getRecord("ws-dream")).toBeNull();
      } finally {
        writeSpy.mockRestore();
      }

      // The failed run released its queue slot, so the next run goes through once the lock works.
      const retry = fixture.service.maybeRun("ws-dream", "manual");
      await until(() => held.events.includes("start-2"));
      held.release(2);
      expect((await retry).success).toBe(true);
    });

    it("starts waiting runs in the order they arrived, each after the one before it ended", async () => {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-two");
      await fixture.addWorkspace("ws-three");

      const first = fixture.service.maybeRun("ws-dream", "manual");
      await until(() => held.events.includes("start-1"));
      const second = fixture.service.maybeRun("ws-two", "manual");
      await waitingForTurn(fixture, 2);
      const third = fixture.service.maybeRun("ws-three", "manual");
      await waitingForTurn(fixture, 3);
      expect(held.events).toEqual(["start-1"]);

      held.release(1);
      await until(() => held.events.includes("start-2"));
      expect(held.events).toEqual(["start-1", "end-1", "start-2"]);
      held.release(2);
      await until(() => held.events.includes("start-3"));
      held.release(3);

      expect((await Promise.all([first, second, third])).every((run) => run.success)).toBe(true);
      expect(held.events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
    });

    it("lets no run pass the running stream when a run between them is cancelled", async () => {
      const held = heldStreams();
      using fixture = await createFixture({ modelFactory: held.factory });
      await fixture.addWorkspace("ws-two");
      await fixture.addWorkspace("ws-three");

      const first = fixture.service.maybeRun("ws-dream", "manual");
      await until(() => held.events.includes("start-1"));
      const middle = fixture.service.maybeRun("ws-two", "manual");
      await waitingForTurn(fixture, 2);
      const last = fixture.service.maybeRun("ws-three", "manual");
      await waitingForTurn(fixture, 3);

      await fixture.service.cancelInFlightConsolidation("ws-two");
      const cancelled = await middle;
      expect(cancelled.success).toBe(false);
      // The cancelled run released its slot, but the stream ahead of it still holds the queue.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(held.events).toEqual(["start-1"]);

      held.release(1);
      await until(() => held.events.includes("start-3"));
      held.release(3);
      expect((await first).success).toBe(true);
      expect((await last).success).toBe(true);
      expect(held.events).toEqual(["start-1", "end-1", "start-3", "end-3"]);
    });
  });

  it("workspace removal cancels a dream run that is still waiting for its turn", async () => {
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let markHolderStarted!: () => void;
    const holderStarted = new Promise<void>((resolve) => {
      markHolderStarted = resolve;
    });
    let streamCount = 0;
    using fixture = await createFixture({
      modelFactory: () => {
        const inner = scriptedModel();
        return new MockLanguageModelV3({
          doStream: async (options) => {
            streamCount++;
            markHolderStarted();
            await holderReleased;
            return inner.doStream(options);
          },
        });
      },
    });
    await fixture.addWorkspace("ws-other");

    const holder = fixture.service.maybeRun("ws-dream", "manual");
    await holderStarted;
    const queued = fixture.service.maybeRun("ws-other", "manual");
    // Past its model creation, the queued run is only waiting for the holder's stream.
    while (fixture.modelCalls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await fixture.service.cancelInFlightConsolidation("ws-other");
    const cancelled = await queued;
    expect(cancelled.success).toBe(false);
    if (!cancelled.success) expect(cancelled.error).toContain("being removed");

    releaseHolder();
    expect((await holder).success).toBe(true);
    // The cancelled run never started a stream, and its queue slot did not wedge the next one.
    expect(streamCount).toBe(1);
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
    expect(streamCount).toBe(2);
  });

  it("does not journal or debounce a run whose stream failed", async () => {
    using fixture = await createFixture();
    fixture.setStreamFailing(true);
    const failed = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(failed.success).toBe(false);
    if (!failed.success) expect(failed.error).toContain("stream failed");
    // No record: the Memory tab must not report a consolidation that never
    // completed.
    expect(await fixture.service.getRecord("ws-dream")).toBeNull();

    // And no debounce anchor: the next automatic trigger retries immediately.
    fixture.setStreamFailing(false);
    const retry = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(retry.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  describe("archive pass", () => {
    function readNote(fixture: Fixture, n: number): Promise<string | null> {
      return fixture.memoryService
        .readFileWithSha(
          {
            runtime: null,
            checkoutCwd: "",
            workspaceId: "ws-dream",
            projectPath: "/projects/demo",
          },
          `/memories/workspace/note-${n}.md`
        )
        .then((file) => (file.success ? file.data.content : null));
    }

    it("analyzes the rows after the last compaction, then runs the dream over what it wrote", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      models.readFirstNote.current = () => readNote(fixture, 1);
      await seedCompactionEpoch(fixture);
      await appendRows(fixture, openRowTexts);

      const result = await fixture.service.maybeRunArchivePass("ws-dream");

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.trigger).toBe("archive");
      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
      const [analyzer, dream] = models.runs;
      expect(analyzer?.prompt).toContain("We settled on bun");
      expect(analyzer?.prompt).toContain("never npm");
      // The closed epoch was analyzed when it closed: neither its rows nor its summary come back.
      expect(analyzer?.prompt).not.toContain("remember that I prefer");
      expect(analyzer?.prompt).not.toContain("prefers concise tests");
      // The dream started after the analyzer's write, so it can promote it.
      expect(dream?.noteAtStart).toContain("analyzer note 1");
      expect(await harvestRecords(fixture)).toMatchObject({
        "open:open-2": { status: "completed", nextChunk: 1, acceptedCandidates: 1 },
      });
    });

    it("analyzes an epoch that never compacted", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
      expect(models.runs[0]?.prompt).toContain("We settled on bun");
    });

    it("makes no second analyzer call for an archive that finds no new rows", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await seedCompactionEpoch(fixture);
      await appendRows(fixture, openRowTexts);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      // Archive is never debounced, so the final dream runs again.
      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream", "dream"]);
    });

    it("analyzes only the rows added after an unarchive on the next archive", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await seedCompactionEpoch(fixture);
      await appendRows(fixture, openRowTexts);
      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual([
        "analyzer",
        "dream",
        "analyzer",
        "dream",
      ]);
      expect(models.runs[2]?.prompt).toContain("CI pins node 22");
      // The rows the first archive's analysis already read are not sent again.
      expect(models.runs[2]?.prompt).not.toContain("We settled on bun");
      expect(models.runs[2]?.prompt).not.toContain("never npm");
      expect(Object.keys(await harvestRecords(fixture)).sort()).toEqual([
        "open:open-2",
        "open:open-3",
      ]);
    });

    describe("rows an earlier archive analyzed", () => {
      const analyzerRuns = (models: ReturnType<typeof archivePassModels>) =>
        models.runs.filter((run) => run.kind === "analyzer");

      it("sends the compaction that closes the epoch only the rows after them", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
        // seedCompactionEpoch adds one more row, "remember that I prefer concise tests".
        const metadata = await seedCompactionEpoch(fixture);

        await fixture.service.maybeHarvestThenSweep(metadata);

        expect(analyzerRuns(models)).toHaveLength(2);
        const closing = analyzerRuns(models)[1]?.prompt ?? "";
        expect(closing).toContain("CI pins node 22");
        expect(closing).toContain("remember that I prefer concise tests");
        expect(closing).not.toContain("We settled on bun");
        expect(closing).not.toContain("never npm");
        expect((await harvestRecords(fixture))["summary-1"]?.status).toBe("completed");
      });

      it("starts after the newest archive's floor, not the oldest, when several archives ran", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await appendRows(fixture, [["open-4", "Releases are cut from the main branch."]]);
        const metadata = await seedCompactionEpoch(fixture);

        await fixture.service.maybeHarvestThenSweep(metadata);

        expect(analyzerRuns(models)).toHaveLength(3);
        const closing = analyzerRuns(models)[2]?.prompt ?? "";
        expect(closing).toContain("Releases are cut from the main branch.");
        expect(closing).toContain("remember that I prefer concise tests");
        // The second archive read up to open-3: the first archive's floor is behind it.
        expect(closing).not.toContain("CI pins node 22");
        expect(closing).not.toContain("We settled on bun");
      });

      /**
       * A closing compaction whose epoch spans three chunks and whose first attempt fails on the
       * second. `betweenAttempts` then changes the sidecar, and the retry runs. Returns the chunks
       * the model was asked about (the failed one twice) and the compaction's final record.
       */
      async function retryAfterSecondChunkFailed(
        betweenAttempts: (fixture: Fixture) => Promise<void>
      ) {
        const chunkLabels: string[] = [];
        let failedOnce = false;
        using fixture = await createFixture({
          modelFactory: () =>
            new MockLanguageModelV3({
              doStream: (options) => {
                const prompt = userPromptText(options);
                const label = /Transcript chunk (\d+\/\d+)/.exec(prompt)?.[1] ?? "";
                if (!prompt.includes("just-compacted transcript epoch")) {
                  return Promise.resolve({ stream: noChangesStream() });
                }
                chunkLabels.push(label);
                if (label.startsWith("2/") && !failedOnce) {
                  failedOnce = true;
                  return Promise.resolve({ stream: failingStream() });
                }
                return Promise.resolve({ stream: noChangesStream() });
              },
            }),
        });
        await appendBulkRows(fixture);
        const metadata = await seedCompactionEpoch(fixture);
        expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "failed",
          nextChunk: 1,
          // No archive had read this epoch: the record says "no floor", not "not looked at".
          analyzedFloorRowId: null,
        });

        await betweenAttempts(fixture);

        expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));
        return { chunkLabels, record: (await harvestRecords(fixture))["summary-1"] };
      }

      it("keeps a retry of the closing compaction on the rows its first attempt read, even if an archive completes meanwhile", async () => {
        const { chunkLabels, record } = await retryAfterSecondChunkFailed(async (fixture) => {
          // An archive pass that read the epoch before it closed finishes after the first attempt:
          // its row is inside the closed epoch, so it must not move the rows under the saved cursor.
          const sidecarPath = path.join(fixture.xumHome, "memory-consolidation.json");
          const sidecar = JSON.parse(await fsPromises.readFile(sidecarPath, "utf-8")) as {
            harvestsByWorkspace: Record<string, Record<string, unknown>>;
          };
          sidecar.harvestsByWorkspace["ws-dream"]["open:bulk-9"] = {
            status: "completed",
            startedAt: Date.now(),
            completedAt: Date.now(),
            attemptCount: 1,
            boundaryKey: "open:bulk-9",
            compactionEpoch: 1,
            acceptedCandidates: 0,
            skippedCandidates: 0,
          };
          await fsPromises.writeFile(sidecarPath, JSON.stringify(sidecar));
        });

        expect(chunkLabels).toEqual(["1/3", "2/3", "2/3", "3/3"]);
        expect(record).toMatchObject({ status: "completed", nextChunk: 3 });
      });

      it("does not start a retry after what its own record read when that record names no floor", async () => {
        // A record saved before the floor was: it has the cursor and the row its chunks read, no
        // floor. The cursor counts chunks of the rows after the job's floor, so a floor taken from
        // the record's own `readThroughRowId` would leave the retry fewer rows than the cursor
        // counts, and skip some. With no floor to reuse it reads the rows again from the start,
        // its first chunk included: the recomputed floor may differ from the one the cursor counted.
        const { chunkLabels, record } = await retryAfterSecondChunkFailed((fixture) =>
          editHarvestRecord(fixture, "summary-1", (stored) => {
            expect(typeof stored.readThroughRowId).toBe("string");
            delete stored.analyzedFloorRowId;
          })
        );

        expect(chunkLabels).toEqual(["1/3", "2/3", "1/3", "2/3", "3/3"]);
        expect(record).toMatchObject({ status: "completed", nextChunk: 3 });
      });

      it("makes no analyzer call for a compaction that closes an epoch an archive fully analyzed", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        const metadata = await closeEpochWithoutNewRows(fixture);

        await fixture.service.maybeHarvestThenSweep(metadata);

        expect(analyzerRuns(models)).toHaveLength(1);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "completed",
          nextChunk: 0,
          acceptedCandidates: 0,
        });
      });

      it("matches the archive of an epoch whose compaction was pending to the compaction that later closes it", async () => {
        const models = editsEveryRunModels(5);
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        // The workspace is archived after the request row is saved, before the compaction ends.
        // The closing compaction's reader skips this row (getMessagesForCompactionEpoch).
        await fixture.historyService.appendToHistory(
          "ws-dream",
          createMuxMessage("compact-request", "user", "Please compact", {
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        );
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        const archive = (await harvestRecords(fixture))["open:open-2"];
        expect(archive).toMatchObject({ readThroughRowId: "open-2", budgetUsed: 5 });

        // The compaction completes after the unarchive, with one more row in the epoch.
        await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
        const summary = createMuxMessage("summary-1", "assistant", "Scripts use bun.", {
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: 1,
        });
        await fixture.historyService.appendToHistory("ws-dream", summary);
        await fixture.service.maybeHarvestThenSweep({
          workspaceId: "ws-dream",
          summaryMessageId: "summary-1",
          summaryHistorySequence: summary.metadata?.historySequence ?? -1,
          compactionEpoch: 1,
          compactionRequestMessageId: "compact-request",
        });

        // The closing run starts after the rows the archive read and shares its budget: it tried
        // 5 more edits and got the 3 that were left.
        expect(models.analyzerRuns()).toBe(2);
        const closing = (await harvestRecords(fixture))["summary-1"];
        expect(closing).toMatchObject({
          status: "completed",
          analyzedFloorRowId: "open-2",
          budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
        });
        expect(closing?.ops?.filter((op) => op.applied)).toHaveLength(3);
      });

      it("makes no analyzer call for the compaction that closes an epoch whose every edit an archive spent, though rows are left unread", async () => {
        const analyzerPrompts: Array<{ closing: boolean; prompt: string }> = [];
        using fixture = await createFixture({
          modelFactory: () =>
            new MockLanguageModelV3({
              doStream: (options) => {
                const afterToolResult = options.prompt.some((message) => message.role === "tool");
                if (
                  systemPromptText(options) !== MEMORY_ANALYZER_SYSTEM_PROMPT ||
                  afterToolResult
                ) {
                  return Promise.resolve({ stream: noChangesStream() });
                }
                const prompt = userPromptText(options);
                const closing = prompt.includes("just-compacted transcript epoch");
                analyzerPrompts.push({ closing, prompt });
                if (closing) return Promise.resolve({ stream: noChangesStream() });
                // The archive's first chunk spends every edit of the epoch's budget.
                return Promise.resolve({
                  stream: spendEveryEditStream(),
                });
              },
            }),
        });
        // Three chunks of rows bulk-0..4, bulk-5..9 and bulk-10..11.
        await appendBulkRows(fixture);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        expect(analyzerPrompts.map((run) => run.closing)).toEqual([false]);
        const archive = (await harvestRecords(fixture))["open:bulk-11"];
        expect(archive?.note).toContain("chunks 2-3 of 3");
        expect(archive?.readThroughRowId).toBe("bulk-4");

        await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));

        // The epoch has one budget (see "the epoch's one edit budget"): the compaction that closes
        // it starts with the archive's spend, so it reads none of the rows the archive left.
        expect(analyzerPrompts.filter((run) => run.closing)).toEqual([]);
        const closing = (await harvestRecords(fixture))["summary-1"];
        expect(closing).toMatchObject({
          status: "completed",
          budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
        });
        expect(closing?.note).toContain("edit budget spent");
      });

      it("keeps the chunks an archive skipped unread when saving its completed record failed", async () => {
        using fixture = await createFixture({
          modelFactory: () =>
            new MockLanguageModelV3({
              doStream: (options) => {
                const afterToolResult = options.prompt.some((message) => message.role === "tool");
                const analyzing = systemPromptText(options) === MEMORY_ANALYZER_SYSTEM_PROMPT;
                return Promise.resolve({
                  stream:
                    analyzing && !afterToolResult ? spendEveryEditStream() : noChangesStream(),
                });
              },
            }),
        });
        // Three chunks of rows bulk-0..4, bulk-5..9 and bulk-10..11. The first spends every edit.
        await appendBulkRows(fixture);
        // The harvest's last step, the completed record, is the one write that fails (once).
        const service = fixture.service as unknown as {
          saveHarvestRecordEffect: (
            workspaceId: string,
            boundaryKey: string,
            record: MemoryHarvestRecordPayload,
            projectPath: string
          ) => Effect.Effect<void>;
        };
        const save = service.saveHarvestRecordEffect.bind(service);
        let failedOnce = false;
        spyOn(service, "saveHarvestRecordEffect").mockImplementation(
          (workspaceId, boundaryKey, record, projectPath) => {
            if (record.status !== "completed" || failedOnce) {
              return save(workspaceId, boundaryKey, record, projectPath);
            }
            failedOnce = true;
            return Effect.promise(() => Promise.reject(new Error("disk full")));
          }
        );

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        // The failed record resumes at the first chunk nobody read, not past the skipped ones.
        expect((await harvestRecords(fixture))["open:bulk-11"]).toMatchObject({
          status: "failed",
          nextChunk: 1,
        });

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        // The retry meets the spent budget again: it says which chunks it skipped, and the rows
        // after chunk 1 stay unread for the compaction that closes the epoch.
        expect((await harvestRecords(fixture))["open:bulk-11"]).toMatchObject({
          status: "completed",
          readThroughRowId: "bulk-4",
        });
        expect((await harvestRecords(fixture))["open:bulk-11"]?.note).toContain("chunks 2-3 of 3");
      });

      describe("an archive that failed after reading some chunks", () => {
        /**
         * Chunks bulk-0..4, bulk-5..9 and bulk-10..11. The first chunk's edit lands; the stream of
         * the archive's second chunk fails once, so the record reads through bulk-4.
         */
        function archiveFailingAtItsSecondChunk() {
          const prompts: Array<{ closing: boolean; prompt: string }> = [];
          let failed = false;
          const factory = () =>
            new MockLanguageModelV3({
              doStream: (options) => {
                const afterToolResult = options.prompt.some((message) => message.role === "tool");
                if (
                  systemPromptText(options) !== MEMORY_ANALYZER_SYSTEM_PROMPT ||
                  afterToolResult
                ) {
                  return Promise.resolve({ stream: noChangesStream() });
                }
                const prompt = userPromptText(options);
                const closing = prompt.includes("just-compacted transcript epoch");
                prompts.push({ closing, prompt });
                const label = /Transcript chunk (\d+\/\d+)/.exec(prompt)?.[1] ?? "";
                if (label.startsWith("2/") && !failed && !closing) {
                  failed = true;
                  return Promise.resolve({ stream: failingStream() });
                }
                return Promise.resolve({
                  stream: label.startsWith("1/")
                    ? simulateReadableStream({
                        chunks: harvestWriteChunks("/memories/workspace/landed.md", "landed\n"),
                      })
                    : noChangesStream(),
                });
              },
            });
          return { prompts, factory };
        }

        async function failFirstArchive(fixture: Fixture): Promise<void> {
          await appendBulkRows(fixture);
          await fixture.service.maybeRunArchivePass("ws-dream");
          expect((await harvestRecords(fixture))["open:bulk-11"]).toMatchObject({
            status: "failed",
            nextChunk: 1,
            // The chunk that read cleanly is read through, though a later one failed.
            readThroughRowId: "bulk-4",
          });
        }

        function expectRowsFromFive(prompt: string): void {
          for (let index = 0; index < 12; index++) {
            const row = `preference ${index} x`;
            if (index < 5) expect(prompt).not.toContain(row);
            else expect(prompt).toContain(row);
          }
        }

        it("starts the next archive, after another row arrived, behind the chunks it read", async () => {
          const scripted = archiveFailingAtItsSecondChunk();
          using fixture = await createFixture({ modelFactory: scripted.factory });
          await failFirstArchive(fixture);
          await appendRows(fixture, [["open-new", "CI pins node 22 for the release job."]]);
          const before = scripted.prompts.length;

          await fixture.service.maybeRunArchivePass("ws-dream");

          const rerun = scripted.prompts
            .slice(before)
            .map((run) => run.prompt)
            .join("\n");
          expect(rerun).toContain("CI pins node 22");
          expectRowsFromFive(rerun);
          expect((await harvestRecords(fixture))["open:open-new"]?.status).toBe("completed");
        });

        it("keeps the rows its chunks read through a retry that fails before it reads a chunk", async () => {
          const scripted = archiveFailingAtItsSecondChunk();
          using fixture = await createFixture({ modelFactory: scripted.factory });
          await failFirstArchive(fixture);

          // The retry cannot load its model, so it fails with nothing read of its own.
          fixture.setModelUnavailable(true);
          await fixture.service.maybeRunArchivePass("ws-dream");
          fixture.setModelUnavailable(false);

          const failed = (await harvestRecords(fixture))["open:bulk-11"];
          expect(failed?.error).toContain("could not create model");
          expect(failed).toMatchObject({
            status: "failed",
            attemptCount: 2,
            nextChunk: 1,
            readThroughRowId: "bulk-4",
          });
          // The failure record is what the next run's floor comes from: it still skips chunk 1.
          const before = scripted.prompts.length;
          await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));
          const closing = scripted.prompts
            .slice(before)
            .filter((run) => run.closing)
            .map((run) => run.prompt)
            .join("\n");
          expectRowsFromFive(closing);
        });

        it("starts the compaction that closes the epoch behind the chunks it read", async () => {
          const scripted = archiveFailingAtItsSecondChunk();
          using fixture = await createFixture({ modelFactory: scripted.factory });
          await failFirstArchive(fixture);
          const before = scripted.prompts.length;

          await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));

          const closing = scripted.prompts
            .slice(before)
            .filter((run) => run.closing)
            .map((run) => run.prompt)
            .join("\n");
          expect(closing).toContain("remember that I prefer concise tests");
          expectRowsFromFive(closing);
          expect((await harvestRecords(fixture))["summary-1"]?.status).toBe("completed");
        });
      });

      describe("a harvest record with a corrupt count", () => {
        /** Chunk 1 of the first attempt lands one edit; its chunk 2 fails; then every step spends 8. */
        function failingThenSpendingModels() {
          let analyzerCalls = 0;
          const factory = () =>
            new MockLanguageModelV3({
              doStream: (options) => {
                const afterToolResult = options.prompt.some((message) => message.role === "tool");
                if (
                  systemPromptText(options) !== MEMORY_ANALYZER_SYSTEM_PROMPT ||
                  afterToolResult
                ) {
                  return Promise.resolve({ stream: noChangesStream() });
                }
                const call = ++analyzerCalls;
                if (call === 1) {
                  return Promise.resolve({
                    stream: simulateReadableStream({
                      chunks: harvestWriteChunks("/memories/workspace/landed.md", "landed\n"),
                    }),
                  });
                }
                if (call === 2) return Promise.resolve({ stream: failingStream() });
                // Distinct paths per step, so every create applies unless the budget refuses it.
                return Promise.resolve({
                  stream: simulateReadableStream({
                    chunks: [
                      ...Array.from(
                        { length: MEMORY_ANALYZER_OP_BUDGET },
                        (_, index): LanguageModelV3StreamPart => ({
                          type: "tool-call",
                          toolCallId: `spend-${call}-${index}`,
                          toolName: "memory",
                          input: JSON.stringify({
                            command: "create",
                            path: `/memories/workspace/call-${call}-${index}.md`,
                            file_text: "fact\n",
                          }),
                        })
                      ),
                      {
                        type: "finish",
                        finishReason: { unified: "tool-calls", raw: "tool-calls" },
                        usage: {
                          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                          outputTokens: { total: 1, text: 0, reasoning: 0 },
                        },
                      },
                    ],
                  }),
                });
              },
            });
          return { factory };
        }

        it("cannot widen the edit budget: a negative budgetUsed restarts the epoch on a fresh budget of 8", async () => {
          using fixture = await createFixture({
            modelFactory: failingThenSpendingModels().factory,
          });
          // Chunks bulk-0..4, bulk-5..9 and bulk-10..11.
          await appendBulkRows(fixture);
          const metadata = await seedCompactionEpoch(fixture);
          expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
          expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
            status: "failed",
            nextChunk: 1,
          });
          // A budget of -100 used to leave 108 edits: chunks 2 and 3 would each spend 8 more.
          await editHarvestRecord(fixture, "summary-1", (record) => {
            record.budgetUsed = -100;
          });

          expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

          const record = (await harvestRecords(fixture))["summary-1"];
          expect(record?.status).toBe("completed");
          expect(record?.ops?.filter((op) => op.applied)).toHaveLength(MEMORY_ANALYZER_OP_BUDGET);
          expect(record?.note).toContain("edit budget spent");
        });

        it("cannot widen the attempt limit: a negative attemptCount restarts the epoch on the bound every epoch has", async () => {
          let analyzerCalls = 0;
          using fixture = await createFixture({
            modelFactory: () =>
              new MockLanguageModelV3({
                doStream: (options) => {
                  if (systemPromptText(options) !== MEMORY_ANALYZER_SYSTEM_PROMPT) {
                    return Promise.resolve({ stream: noChangesStream() });
                  }
                  analyzerCalls++;
                  return Promise.resolve({ stream: failingStream() });
                },
              }),
          });
          const metadata = await seedCompactionEpoch(fixture);
          expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
          expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
            status: "failed",
            attemptCount: 1,
          });
          // An attemptCount of -100 used to stay under HARVEST_MAX_ATTEMPTS for 100 more attempts.
          await editHarvestRecord(fixture, "summary-1", (record) => {
            record.attemptCount = -100;
          });
          analyzerCalls = 0;

          for (let run = 0; run < HARVEST_MAX_ATTEMPTS + 3; run++) {
            await fixture.service.maybeHarvestThenSweep(metadata);
          }

          expect(analyzerCalls).toBe(HARVEST_MAX_ATTEMPTS);
          expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
            status: "failed",
            attemptCount: HARVEST_MAX_ATTEMPTS,
          });
        });

        it.each([
          ["attemptCount", -1],
          ["attemptCount", 1.5],
          ["budgetUsed", -100],
          ["budgetUsed", 1.5],
          ["nextChunk", -1],
          ["nextChunkOps", -1],
        ])("drops a record whose %s is %d on load", async (field, value) => {
          const models = archivePassModels();
          using fixture = await createFixture({ modelFactory: models.factory });
          await appendRows(fixture, openRowTexts);
          expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
          expect((await fixture.service.getStatus("ws-dream")).latestHarvestRecord).not.toBeNull();
          await editHarvestRecord(fixture, "open:open-2", (record) => {
            record[field] = value;
          });

          expect((await fixture.service.getStatus("ws-dream")).latestHarvestRecord).toBeNull();
        });
      });

      it("takes an archive record from before `readThroughRowId` to have read up to the row its key names", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await editHarvestRecord(fixture, "open:open-2", (record) => {
          expect(record.readThroughRowId).toBe("open-2");
          delete record.readThroughRowId;
        });

        await fixture.service.maybeHarvestThenSweep(await closeEpochWithoutNewRows(fixture));

        expect(analyzerRuns(models)).toHaveLength(1);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "completed",
          nextChunk: 0,
        });
      });

      it("keeps a record that read nothing, and reads every row at the compaction that closes the epoch", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        // An archive that found its edit budget spent before its first chunk read no row. The key
        // still names the newest row, so a floor taken from the key would skip rows nobody read.
        await editHarvestRecord(fixture, "open:open-2", (record) => {
          record.readThroughRowId = null;
        });

        // The record must load: a record that fails the schema is dropped, and the status shows none.
        expect((await fixture.service.getStatus("ws-dream")).latestHarvestRecord).toMatchObject({
          boundaryKey: "open:open-2",
          readThroughRowId: null,
        });
        await fixture.service.maybeHarvestThenSweep(await closeEpochWithoutNewRows(fixture));

        expect(analyzerRuns(models)).toHaveLength(2);
        expect(analyzerRuns(models)[1]?.prompt).toContain("We settled on bun");
      });

      it("analyzes every row again once the chat was rewound past the row an archive stopped at", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        // Rewind to before the row the archive stopped at, then grow past its old position. A
        // history sequence is reused after a rewind; a row id never is.
        expect(
          (await fixture.historyService.truncateAfterMessage("ws-dream", "open-2")).success
        ).toBe(true);
        await appendRows(fixture, [["open-2b", "Actually scripts use pnpm."]]);

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

        const rerun = analyzerRuns(models)[1]?.prompt ?? "";
        expect(rerun).toContain("Actually scripts use pnpm.");
        expect(rerun).toContain("We settled on bun");
      });

      it("keeps the floor of an older archive when a newer one was rewound away", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        expect(
          (await fixture.historyService.truncateAfterMessage("ws-dream", "open-3")).success
        ).toBe(true);
        await appendRows(fixture, [["open-3b", "CI pins node 24 instead."]]);

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

        // open-2 is still in the chat, so what an archive read up to it stays read.
        const rerun = analyzerRuns(models)[2]?.prompt ?? "";
        expect(rerun).toContain("CI pins node 24 instead.");
        expect(rerun).not.toContain("We settled on bun");
        expect(rerun).not.toContain("CI pins node 22");
      });
    });

    type EmptyOpenEpoch =
      | "no history"
      | "only the boundary"
      | "only keep-recent tail copies after the boundary";
    const emptyOpenEpochs: EmptyOpenEpoch[] = [
      "no history",
      "only the boundary",
      "only keep-recent tail copies after the boundary",
    ];

    async function seedEmptyOpenEpoch(fixture: Fixture, kind: EmptyOpenEpoch): Promise<void> {
      if (kind === "no history") return;
      await seedCompactionEpoch(fixture);
      if (kind === "only the boundary") return;
      await fixture.historyService.appendToHistory(
        "ws-dream",
        createMuxMessage("tail-copy", "user", "A row the closed epoch already analyzed.", {
          synthetic: true,
          rlmPreservedTailCopy: true,
        })
      );
    }

    it.each(emptyOpenEpochs)("makes no analyzer call for an open epoch with %s", async (kind) => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await seedEmptyOpenEpoch(fixture, kind);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
      expect(fixture.modelCalls).toHaveLength(1);
      expect(await harvestRecords(fixture)).toEqual({});
    });

    describe("the epoch's one edit budget", () => {
      const appliedEdits = (records: Record<string, MemoryHarvestRecordPayload>): number =>
        Object.values(records).reduce(
          (total, record) => total + (record.ops ?? []).filter((op) => op.applied).length,
          0
        );

      it("cannot be spent again by archiving after each new row: the epoch gets MEMORY_ANALYZER_OP_BUDGET edits in all", async () => {
        const models = editsEveryRunModels(3);
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        // Each cycle is an archive, an unarchive and a new row. Each archive tries 3 edits: the
        // first two get 3 and 3, the third gets the 2 that are left, the fourth none.
        for (const row of ["open-3", "open-4", "open-5"]) {
          expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
          await appendRows(fixture, [[row, `Another fact in ${row}.`]]);
        }
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

        const records = await harvestRecords(fixture);
        expect(Object.keys(records).sort()).toEqual([
          "open:open-2",
          "open:open-3",
          "open:open-4",
          "open:open-5",
        ]);
        expect(appliedEdits(records)).toBe(MEMORY_ANALYZER_OP_BUDGET);
        expect(records["open:open-4"]?.ops?.filter((op) => op.applied)).toHaveLength(2);
        // The last archive found the budget spent: no analyzer call, and a note saying why.
        expect(records["open:open-5"]).toMatchObject({
          status: "completed",
          budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
        });
        expect(records["open:open-5"]?.note).toContain("edit budget spent");
        expect(models.analyzerRuns()).toBe(3);
      });

      it("is spent by the archives before it when the compaction closes the epoch", async () => {
        const models = editsEveryRunModels(5);
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        expect((await harvestRecords(fixture))["open:open-2"]?.budgetUsed).toBe(5);

        await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));

        // The compaction tried 5 more edits and got the 3 the archive left.
        const records = await harvestRecords(fixture);
        expect(records["summary-1"]?.ops?.filter((op) => op.applied)).toHaveLength(3);
        expect(records["summary-1"]?.budgetUsed).toBe(MEMORY_ANALYZER_OP_BUDGET);
        expect(appliedEdits(records)).toBe(MEMORY_ANALYZER_OP_BUDGET);
      });

      it("starts the next epoch on a fresh budget", async () => {
        const models = editsEveryRunModels(MEMORY_ANALYZER_OP_BUDGET);
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture));
        // Epoch 1 spent everything on its archive. Epoch 2 is a different epoch.
        await appendRows(fixture, [["next-1", "Epoch 2 settled on vitest for unit tests."]]);

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

        const next = (await harvestRecords(fixture))["open:next-1"];
        expect(next?.ops?.filter((op) => op.applied)).toHaveLength(MEMORY_ANALYZER_OP_BUDGET);
      });

      it("does not count what a rewound-away timeline of the epoch spent", async () => {
        const models = editsEveryRunModels(MEMORY_ANALYZER_OP_BUDGET);
        using fixture = await createFixture({ modelFactory: models.factory });
        await appendRows(fixture, openRowTexts);
        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
        // Rewind to before the row the archive stopped at: the new rows are a new timeline of
        // the same epoch, which an epoch number alone cannot tell apart.
        expect(
          (await fixture.historyService.truncateAfterMessage("ws-dream", "open-1")).success
        ).toBe(true);
        await appendRows(fixture, [["open-2b", "Actually scripts use pnpm."]]);

        expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

        const rerun = (await harvestRecords(fixture))["open:open-2b"];
        expect(rerun?.ops?.filter((op) => op.applied)).toHaveLength(MEMORY_ANALYZER_OP_BUDGET);
      });
    });

    describe("a sub-agent's archive", () => {
      const refusal = "share their owner's workspace memory";

      it("analyzes its open epoch into the owner's workspace memory, without a final dream for it", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await appendRows(fixture, openRowTexts, "ws-sub");

        const result = await fixture.service.maybeRunArchivePass("ws-sub");

        // The owner's archive pass promotes: the child's own pass is still refused, after analyzing.
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toContain(refusal);
        expect(models.runs.map((run) => run.kind)).toEqual(["analyzer"]);
        expect(models.runs[0]?.prompt).toContain("We settled on bun");
        expect(await readNote(fixture, 1)).toContain("analyzer note 1");
        expect(await harvestRecords(fixture, "ws-sub")).toMatchObject({
          "open:open-2": { status: "completed", nextChunk: 1, acceptedCandidates: 1 },
        });
        expect(await harvestRecords(fixture)).toEqual({});
        expect(await fixture.service.getRecord("ws-dream")).toBeNull();
      });

      it("does not analyze rows it already analyzed, and still refuses after a failed analysis", async () => {
        const models = archivePassModels({ analyzerFailures: 1 });
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await appendRows(fixture, openRowTexts, "ws-sub");

        const failed = await fixture.service.maybeRunArchivePass("ws-sub");
        expect(failed.success).toBe(false);
        if (!failed.success) expect(failed.error).toContain(refusal);
        expect(await harvestRecords(fixture, "ws-sub")).toMatchObject({
          "open:open-2": { status: "failed", attemptCount: 1 },
        });

        await fixture.service.maybeRunArchivePass("ws-sub");
        await fixture.service.maybeRunArchivePass("ws-sub");

        // The retry completed the epoch; the third archive found nothing new to read.
        expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "analyzer"]);
        expect(await harvestRecords(fixture, "ws-sub")).toMatchObject({
          "open:open-2": { status: "completed", attemptCount: 2 },
        });
      });

      it("makes no model call for a sub-agent with no rows to analyze", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });

        const result = await fixture.service.maybeRunArchivePass("ws-sub");

        expect(result.success).toBe(false);
        expect(fixture.modelCalls).toHaveLength(0);
      });
    });

    describe("a task-tree archive", () => {
      /**
       * The deterministic arrival of the owner's pass at its wait for the sub-agents' passes,
       * which is the one point a test can tell "waiting" from "has not got there yet".
       */
      function ownerWaitsForSubAgents(): { arrived: Promise<void>; restore: () => void } {
        let arrive!: () => void;
        const arrived = new Promise<void>((resolve) => (arrive = resolve));
        const debug = spyOn(log, "debug").mockImplementation((message) => {
          if (String(message).includes("waiting for sub-agent archive analyses")) arrive();
        });
        return { arrived, restore: () => debug.mockRestore() };
      }

      /** Which happens first: the owner's pass starts waiting, or it finishes without waiting. */
      function whatComesFirst(
        wait: ReturnType<typeof ownerWaitsForSubAgents>,
        owner: Promise<unknown>
      ): Promise<"owner is waiting" | "owner finished"> {
        return Promise.race([
          wait.arrived.then(() => "owner is waiting" as const),
          owner.then(() => "owner finished" as const),
        ]);
      }

      it("starts the owner's final dream only after a sub-agent's analysis into the owner's memory settled", async () => {
        let releaseChild!: () => void;
        const models = archivePassModels({
          holdFirstAnalyzer: new Promise<void>((resolve) => (releaseChild = resolve)),
        });
        using fixture = await createFixture({ modelFactory: models.factory });
        models.readFirstNote.current = () => readNote(fixture, 1);
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await appendRows(fixture, openRowTexts, "ws-sub");
        const wait = ownerWaitsForSubAgents();
        try {
          // The order of a task-tree archive: archive's own trigger starts each sub-agent's pass
          // in the background, then the owner's follows.
          fixture.service.triggerInBackground("ws-sub", "archive");
          await models.firstAnalyzerStarted;
          const owner = fixture.service.maybeRunArchivePass("ws-dream");

          // The owner settling first would mean it ran its dream while the child's analysis,
          // still held, could yet write to its memory.
          expect(await whatComesFirst(wait, owner)).toBe("owner is waiting");
          expect(models.runs.map((run) => run.kind)).toEqual(["analyzer"]);

          releaseChild();
          expect((await owner).success).toBe(true);
          expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
          // The dream saw what the sub-agent's analyzer wrote, so it could promote it.
          expect(models.runs[1]?.noteAtStart).toContain("analyzer note 1");
        } finally {
          releaseChild();
          wait.restore();
        }
      });

      it("counts a sub-agent's archive pass as in flight from the call that triggers it", async () => {
        // The owner's pass reaches its wait after disk reads, so a registration that slips by an
        // await or a microtask still lands before that wait in every ordering a pass-against-pass
        // race can produce. The wait itself, evaluated in the frame right after the trigger, is
        // the one place a gap shows: a registration made later finds no pass there and returns.
        let releaseChild!: () => void;
        const models = archivePassModels({
          holdFirstAnalyzer: new Promise<void>((resolve) => (releaseChild = resolve)),
        });
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await appendRows(fixture, openRowTexts, "ws-sub");
        const waitForSubAgents = (
          fixture.service as unknown as {
            awaitDescendantArchivePasses: (ownerId: string, signal: AbortSignal) => Promise<void>;
          }
        ).awaitDescendantArchivePasses.bind(fixture.service);
        try {
          fixture.service.triggerInBackground("ws-sub", "archive");
          const ownerWait = waitForSubAgents("ws-dream", new AbortController().signal);

          // Held in its analyzer, the child's pass cannot end, so the wait is pending unless it
          // missed the pass.
          await models.firstAnalyzerStarted;
          const first = await Promise.race([
            ownerWait.then(() => "wait ended"),
            new Promise<string>((resolve) => setImmediate(() => resolve("still waiting"))),
          ]);
          expect(first).toBe("still waiting");

          releaseChild();
          await ownerWait;
        } finally {
          releaseChild();
        }
      });

      it("stops waiting for the sub-agents when the owner is removed, and runs no dream", async () => {
        let releaseChild!: () => void;
        const models = archivePassModels({
          holdFirstAnalyzer: new Promise<void>((resolve) => (releaseChild = resolve)),
        });
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await appendRows(fixture, openRowTexts, "ws-sub");
        const wait = ownerWaitsForSubAgents();
        try {
          const child = fixture.service.maybeRunArchivePass("ws-sub");
          await models.firstAnalyzerStarted;
          const owner = fixture.service.maybeRunArchivePass("ws-dream");
          expect(await whatComesFirst(wait, owner)).toBe("owner is waiting");

          // The child's analysis is still held: removal must not wait for it.
          await fixture.service.cancelInFlightConsolidation("ws-dream");
          const result = await owner;

          expect(result.success).toBe(false);
          if (!result.success) expect(result.error).toContain("being removed");
          expect(models.runs.map((run) => run.kind)).toEqual(["analyzer"]);
          releaseChild();
          await child;
        } finally {
          releaseChild();
          wait.restore();
        }
      });

      it("does not wait for the archive pass of a workspace outside the owner's task tree", async () => {
        // The other pass is held before it takes any turn: every analyzer chunk and dream shares
        // one stream exclusion, so holding its stream would hold up the owner for that reason.
        let releaseOther!: () => void;
        const otherHeld = new Promise<void>((resolve) => (releaseOther = resolve));
        let otherReading!: () => void;
        const otherReached = new Promise<void>((resolve) => (otherReading = resolve));
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-other");
        await appendRows(fixture, openRowTexts, "ws-other");
        const readHistory = fixture.historyService.getHistoryFromLatestBoundary.bind(
          fixture.historyService
        );
        spyOn(fixture.historyService, "getHistoryFromLatestBoundary").mockImplementation(
          async (...args: Parameters<typeof readHistory>) => {
            if (args[0] === "ws-other") {
              otherReading();
              await otherHeld;
            }
            return readHistory(...args);
          }
        );
        const wait = ownerWaitsForSubAgents();
        try {
          const other = fixture.service.maybeRunArchivePass("ws-other");
          await otherReached;

          // Settles while the other workspace's pass is held: no wait on it. Only the owner's
          // dream runs (its own open epoch is empty).
          const owner = fixture.service.maybeRunArchivePass("ws-dream");
          expect(await whatComesFirst(wait, owner)).toBe("owner finished");
          expect((await owner).success).toBe(true);
          expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
          releaseOther();
          await other;
        } finally {
          releaseOther();
          wait.restore();
        }
      });
    });

    it("still runs the final dream when the open epoch cannot be read", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);
      const read = spyOn(
        fixture.historyService,
        "getHistoryFromLatestBoundary"
      ).mockResolvedValueOnce(Err("history file unreadable"));

      const result = await fixture.service.maybeRunArchivePass("ws-dream");

      expect(read).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
      expect(await harvestRecords(fixture)).toEqual({});
    });

    it("still runs the final dream when the analysis itself throws", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);
      spyOn(fixture.historyService, "getHistoryFromLatestBoundary").mockRejectedValueOnce(
        new Error("history read exploded")
      );

      const result = await fixture.service.maybeRunArchivePass("ws-dream");

      expect(result.success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
    });

    it("still runs the final dream after a failed analysis, and retries that analysis on the next archive", async () => {
      const models = archivePassModels({ analyzerFailures: 1 });
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
      expect(await harvestRecords(fixture)).toMatchObject({
        "open:open-2": { status: "failed", attemptCount: 1 },
      });

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual([
        "analyzer",
        "dream",
        "analyzer",
        "dream",
      ]);
      expect(await harvestRecords(fixture)).toMatchObject({
        "open:open-2": { status: "completed", attemptCount: 2 },
      });
    });

    it("queues an archive behind the active pass, so rows added meanwhile are analyzed", async () => {
      let releaseFirstAnalyzer!: () => void;
      const models = archivePassModels({
        holdFirstAnalyzer: new Promise<void>((resolve) => (releaseFirstAnalyzer = resolve)),
      });
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);

      const first = fixture.service.maybeRunArchivePass("ws-dream");
      await models.firstAnalyzerStarted;
      // An unarchive, more chat and a second archive, all inside the first pass.
      await appendRows(fixture, [["open-3", "CI pins node 22 for the release job."]]);
      const second = fixture.service.maybeRunArchivePass("ws-dream");
      releaseFirstAnalyzer();
      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual([
        "analyzer",
        "dream",
        "analyzer",
        "dream",
      ]);
      expect(models.runs[2]?.prompt).toContain("CI pins node 22");
    });

    it("is what archive's background trigger runs", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);

      fixture.service.triggerInBackground("ws-dream", "archive");
      // The trigger is fire-and-forget: wait for its two runs (bounded: 2 s).
      for (let tick = 0; tick < 400 && models.runs.length < 2; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
    });

    it("lets the removal drain abort an analysis in flight and stops before the dream", async () => {
      let analyzerStarted!: () => void;
      const started = new Promise<void>((resolve) => (analyzerStarted = resolve));
      using fixture = await createFixture({
        modelFactory: () =>
          new MockLanguageModelV3({
            doStream: (call) => {
              analyzerStarted();
              return new Promise((_resolve, reject) => {
                call.abortSignal?.addEventListener("abort", () =>
                  reject(new Error("stalled provider call aborted"))
                );
              });
            },
          }),
      });
      await appendRows(fixture, openRowTexts);

      const pass = fixture.service.maybeRunArchivePass("ws-dream");
      await started;
      await fixture.service.cancelInFlightConsolidation("ws-dream");
      const result = await pass;

      // Only the analyzer's stream was ever opened: the removed workspace gets no final dream.
      expect(fixture.modelCalls).toHaveLength(1);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("being removed");
    });
  });

  describe("dream cost ceiling", () => {
    function setCeiling(fixture: Fixture, usd: number | null): Promise<void> {
      return fixture.config.updateUserPreferences([{ memory: { dreamCostCeilingUsd: usd } }]);
    }

    it("runs both passes to their own ends with no ceiling, and records what each cost", async () => {
      const models = pricedPassModels({ dream: "ends" });
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: PRICED_MODEL,
      });
      await appendRows(fixture, openRowTexts);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      expect(models.steps).toEqual(["analyzer 1/1 edit", "analyzer 1/1 end", "dream"]);
      const harvest = (await harvestRecords(fixture))["open:open-2"];
      expect(harvest?.status).toBe("completed");
      expect(harvest?.spentUsd).toBeCloseTo(1, 3);
      expect(harvest?.note).toBeUndefined();
      const dream = await fixture.service.getRecord("ws-dream");
      expect(dream?.spentUsd).toBeCloseTo(0.5, 3);
      expect(dream?.note).toBeUndefined();
    });

    it("completes an analyzer job the ceiling stopped, with its cursor saved, and never retries it", async () => {
      const models = pricedPassModels({ dream: "ends" });
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: PRICED_MODEL,
      });
      await appendBulkRows(fixture);
      const metadata = await seedCompactionEpoch(fixture);
      await setCeiling(fixture, 0.25);

      expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

      // The first step costs $0.50, over the ceiling: chunk 1 never takes its second step, and
      // chunks 2 and 3 are never read.
      expect(models.steps.filter((step) => step.startsWith("analyzer"))).toEqual([
        "analyzer 1/3 edit",
      ]);
      const record = (await harvestRecords(fixture))["summary-1"];
      expect(record).toMatchObject({
        status: "completed",
        attemptCount: 1,
        nextChunk: 3,
        readThroughRowId: "bulk-4",
        acceptedCandidates: 1,
        note: "stopped at the cost ceiling after $0.50",
      });
      expect(record?.error).toBeUndefined();
      expect(record?.spentUsd).toBeCloseTo(0.5, 3);

      // A later trigger finds a completed job: raising the ceiling does not reread the epoch.
      await setCeiling(fixture, null);
      expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));
      expect(models.steps.filter((step) => step.startsWith("analyzer"))).toHaveLength(1);
    });

    it("continues a retry from the spend its failed attempt persisted", async () => {
      const models = pricedPassModels({ dream: "ends", failChunkOnce: "2/3" });
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: PRICED_MODEL,
      });
      await appendBulkRows(fixture);
      const metadata = await seedCompactionEpoch(fixture);
      await setCeiling(fixture, 1.5);

      expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
      const failed = (await harvestRecords(fixture))["summary-1"];
      // Chunk 1's two steps are paid for ($1.00, under the ceiling); chunk 2's stream failed.
      expect(failed).toMatchObject({ status: "failed", nextChunk: 1 });
      expect(failed?.spentUsd).toBeCloseTo(1, 3);

      expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

      // The retry's first step brings the job to $1.50: chunk 2 stops there, chunk 3 is never
      // read. Without the carried $1.00 the retry would run chunk 2 whole and read chunk 3 too.
      expect(models.steps.filter((step) => step.startsWith("analyzer"))).toEqual([
        "analyzer 1/3 edit",
        "analyzer 1/3 end",
        "analyzer 2/3 fails",
        "analyzer 2/3 edit",
      ]);
      const retried = (await harvestRecords(fixture))["summary-1"];
      expect(retried).toMatchObject({
        status: "completed",
        attemptCount: 2,
        nextChunk: 3,
        note: "stopped at the cost ceiling after $1.50",
      });
      expect(retried?.spentUsd).toBeCloseTo(1.5, 3);
    });

    it("cannot widen the ceiling: a negative persisted spend drops the record and restarts the job from nothing", async () => {
      const models = pricedPassModels({ dream: "ends", failChunkOnce: "2/3" });
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: PRICED_MODEL,
      });
      await appendBulkRows(fixture);
      const metadata = await seedCompactionEpoch(fixture);
      await setCeiling(fixture, 1.5);
      expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
      await editHarvestRecord(fixture, "summary-1", (record) => {
        record.spentUsd = -100;
      });

      expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

      // A carried -$100 would let every chunk run. The invalid record is dropped on load, so the
      // job starts again at chunk 1, as a first attempt, and the ceiling holds on its own spend.
      const restarted = (await harvestRecords(fixture))["summary-1"];
      expect(restarted).toMatchObject({ status: "completed", attemptCount: 1 });
      expect(restarted?.spentUsd).toBeCloseTo(1.5, 3);
    });

    describe("a model with no known price", () => {
      // The meter counts such a step as $0, so a ceiling would never stop the run. The note puts
      // that on the record the Memory tab shows, instead of leaving the ceiling looking enforced.
      const UNPRICED_MODEL = "ollama:no-such-model";
      const unenforced = "price unknown, ceiling not enforced";

      it("notes on an organizer run that the ceiling was not enforced", async () => {
        const models = pricedPassModels({ dream: "ends" });
        using fixture = await createFixture({
          modelFactory: models.factory,
          metadataModel: UNPRICED_MODEL,
        });
        await setCeiling(fixture, 0.25);

        expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

        expect((await fixture.service.getRecord("ws-dream"))?.note).toBe(unenforced);
      });

      it("notes on an analyzer job that the ceiling was not enforced", async () => {
        const models = pricedPassModels({ dream: "ends" });
        using fixture = await createFixture({
          modelFactory: models.factory,
          metadataModel: UNPRICED_MODEL,
        });
        await appendBulkRows(fixture);
        const metadata = await seedCompactionEpoch(fixture);
        await setCeiling(fixture, 0.25);

        expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);

        // Every chunk was read: the ceiling stopped nothing.
        expect(models.steps.filter((step) => step.startsWith("analyzer"))).toHaveLength(6);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "completed",
          note: unenforced,
        });
      });

      it("makes no note when no ceiling is set", async () => {
        const models = pricedPassModels({ dream: "ends" });
        using fixture = await createFixture({
          modelFactory: models.factory,
          metadataModel: UNPRICED_MODEL,
        });

        expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

        expect((await fixture.service.getRecord("ws-dream"))?.note).toBeUndefined();
      });
    });

    it("saves the record of an organizer run the ceiling stopped, so the debounce applies", async () => {
      const models = pricedPassModels({ dream: "never-ends" });
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: PRICED_MODEL,
      });
      await setCeiling(fixture, 0.75);

      const result = await fixture.service.maybeRun("ws-dream", "manual");

      // $0.50 a step: the second step brings the run to $1.00, over the ceiling.
      expect(models.steps).toEqual(["dream", "dream"]);
      expect(result.success).toBe(true);
      const record = await fixture.service.getRecord("ws-dream");
      expect(record?.note).toBe("stopped at the cost ceiling after $1.00");
      expect(record?.spentUsd).toBeCloseTo(1, 3);

      expectDebounced(await fixture.service.maybeRun("ws-dream", "compaction"));
      expect(models.steps).toHaveLength(2);
    });
  });

  it("does not treat a run of many chunks as stale while its chunks keep finishing", async () => {
    // Attempt 3 is the one a stale record would flip to failed on a sidecar read.
    const start = Date.now();
    const minute = 60_000;
    let statusDuringChunkTwo: MemoryHarvestRecordPayload | null = null;
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: async (call) => {
            const label = /Transcript chunk (\d+)\//.exec(userPromptText(call))?.[1];
            if (label === "1") setSystemTime(new Date(start + 4 * minute));
            if (label === "2") {
              setSystemTime(new Date(start + 8 * minute));
              statusDuringChunkTwo = (await fixture.service.getStatus("ws-dream"))
                .latestHarvestRecord;
            }
            return { stream: noChangesStream() };
          },
        }),
    });
    await appendBulkRows(fixture);
    const metadata = await seedCompactionEpoch(fixture);
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-dream": {
            [metadata.summaryMessageId]: {
              status: "failed",
              startedAt: start - 20_000,
              completedAt: start - 10_000,
              attemptCount: 2,
              boundaryKey: metadata.summaryMessageId,
              compactionEpoch: metadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "provider exploded",
              completionMetadata: metadata,
            },
          },
        },
      })
    );
    try {
      setSystemTime(new Date(start));
      expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
    } finally {
      setSystemTime();
    }

    // 8 minutes after the attempt began, but 4 after its last finished chunk.
    expect(statusDuringChunkTwo).toMatchObject({ status: "pending", attemptCount: 3 });
  });

  it("does not journal a dream that removal cut short as a success", async () => {
    // A real provider stream ends silently when its request is aborted: no error part reaches
    // the runner, which used to read the pass as clean.
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => (streamStarted = resolve));
    using fixture = await createFixture({
      modelFactory: () =>
        new MockLanguageModelV3({
          doStream: (call) => {
            streamStarted();
            return new Promise((_resolve, reject) => {
              call.abortSignal?.addEventListener("abort", () =>
                reject(new Error("stalled provider call aborted"))
              );
            });
          },
        }),
    });

    const run = fixture.service.maybeRun("ws-dream", "manual");
    await started;
    await fixture.service.cancelInFlightConsolidation("ws-dream");
    const result = await run;

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("stream failed");
    expect(await fixture.service.getRecord("ws-dream")).toBeNull();
  });

  it("self-heals a corrupt sidecar instead of failing every later read", async () => {
    using fixture = await createFixture();
    const sidecarPath = path.join(fixture.xumHome, "memory-consolidation.json");
    // typeof null === "object": this once passed a hand-rolled validity check
    // and then blew up getRecord/saveRecord with a TypeError forever.
    await fsPromises.writeFile(sidecarPath, JSON.stringify({ workspaces: null }));
    expect(await fixture.service.getRecord("ws-dream")).toBeNull();

    // The next completed run repairs the file.
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
    const record = await fixture.service.getRecord("ws-dream");
    expect(record?.trigger).toBe("manual");
  });

  it("dream override shadows the built-in; malformed overrides fall back", async () => {
    using fixture = await createFixture();
    // Resolution is rooted at the provided mux root (Config.rootDir), never a
    // hardcoded ~/.mux — the fixture root proves the isolation.
    const builtIn = await resolveDreamAgentBody(fixture.xumHome);
    expect(builtIn).not.toBeNull();

    const agentsDir = path.join(fixture.xumHome, "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "dream.md"),
      "---\nname: Dream\n---\n\nCustom dream body\n"
    );
    expect(await resolveDreamAgentBody(fixture.xumHome)).toBe("Custom dream body");

    // Malformed override (missing frontmatter) falls back to the built-in.
    await fsPromises.writeFile(path.join(agentsDir, "dream.md"), "body without frontmatter\n");
    expect(await resolveDreamAgentBody(fixture.xumHome)).toBe(builtIn);
  });

  it("does nothing when the experiment is disabled", async () => {
    using fixture = await createFixture();
    fixture.setEnabled(false);
    const result = await fixture.service.maybeRun("ws-dream", "manual");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("disabled");
    expect(fixture.modelCalls).toHaveLength(0);

    fixture.service.triggerInBackground("ws-dream", "compaction");
    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("launch sweep selects only idle workspaces with memory writes since the last run", async () => {
    using fixture = await createFixture();
    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    // No writes recorded => sweep skips even idle workspaces.
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(0);

    // A fresh global write qualifies the idle workspace.
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(1);

    // Recently-active workspaces are never swept regardless of writes.
    await fixture.metaService.recordAccess("global:lesson2.md", { write: true });
    await fixture.service.runLaunchSweep(new Map([["ws-dream", now]]));
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("recovers a sub-agent's failed harvest through the owner's run", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
    const metadata = await seedCompactionEpoch(fixture, "ws-sub");
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-sub": {
            [metadata.summaryMessageId]: {
              status: "failed",
              startedAt: Date.now() - 10_000,
              completedAt: Date.now() - 9_000,
              attemptCount: 1,
              boundaryKey: metadata.summaryMessageId,
              compactionEpoch: metadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "crashed mid-harvest",
              completionMetadata: metadata,
            },
          },
        },
      })
    );

    // The child's manual run redirects to the owner; the owner's recovery
    // must still retry the CHILD's bucket (the launch sweep never visits it).
    expect((await fixture.service.maybeRun("ws-sub", "manual")).success).toBe(true);
    const status = await fixture.service.getStatus("ws-sub");
    expect(status.latestHarvestRecord?.status).toBe("completed");
    expect(status.latestHarvestRecord?.attemptCount).toBe(2);
  });

  it("redirects a sub-agent's Dream runs and status to the memory owner", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });

    // Launch sweep: a child's workspace write is keyed under the owner
    // (MemoryService resolution), so the idle owner qualifies while the idle
    // child is skipped even though it is listed.
    await fixture.memoryService.create(
      { runtime: null, checkoutCwd: "", workspaceId: "ws-sub", projectPath: "" },
      "/memories/workspace/from-child.md",
      "shared lesson",
      "agent"
    );
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    // A recently-used child keeps the whole tree's notebook "not idle": the
    // owner must not be swept on its own stale recency.
    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-sub", Date.now()],
        ["ws-dream", dayAgo],
      ])
    );
    expect(fixture.modelCalls).toHaveLength(0);
    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-sub", dayAgo],
        ["ws-dream", dayAgo],
      ])
    );
    expect(fixture.modelCalls).toHaveLength(1);
    expect(await fixture.service.getRecord("ws-sub")).toBeNull();
    expect(await fixture.service.getRecord("ws-dream")).not.toBeNull();

    // Manual/compaction runs from the child consolidate the OWNER's store
    // under the owner's lock; the record lands on the owner and the child's
    // status view reports it (the tab shows the shared store).
    const manual = await fixture.service.maybeRun("ws-sub", "manual");
    expect(manual.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
    expect(await fixture.service.getRecord("ws-sub")).toBeNull();
    expect((await fixture.service.getStatus("ws-sub")).workspaceRecord).toEqual(
      await fixture.service.getRecord("ws-dream")
    );

    // Archive is the owner's own one-shot promotion pass: a child archive is
    // refused instead of running it.
    const archive = await fixture.service.maybeRun("ws-sub", "archive");
    expect(archive.success).toBe(false);
    if (!archive.success) expect(archive.error).toContain("owner");
    expect(fixture.modelCalls).toHaveLength(2);

    // A child mid-teardown must not start an owner run: locally cancelled
    // (the child's removal drain could never cancel an owner-keyed run) or
    // tombstoned by another backend.
    await fixture.addWorkspace("ws-sub-gone", { parentWorkspaceId: "ws-dream" });
    const tombstonePath = workspaceRemovalTombstonePath(fixture.xumHome, "ws-sub-gone");
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fsPromises.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: "ws-sub-gone", removedAt: Date.now() })
    );
    const tombstoned = await fixture.service.maybeRun("ws-sub-gone", "manual");
    expect(tombstoned.success).toBe(false);
    if (!tombstoned.success) expect(tombstoned.error).toContain("being removed");
    await fixture.service.cancelInFlightConsolidation("ws-sub");
    const cancelled = await fixture.service.maybeRun("ws-sub", "manual");
    expect(cancelled.success).toBe(false);
    if (!cancelled.success) expect(cancelled.error).toContain("being removed");
    expect(fixture.modelCalls).toHaveLength(2);

    // A dangling parent chain resolves to a PRIVATE store (owner == self), so
    // that workspace consolidates itself rather than being orphaned forever.
    await fixture.addWorkspace("ws-orphan", { parentWorkspaceId: "ws-gone" });
    const orphan = await fixture.service.maybeRun("ws-orphan", "manual");
    expect(orphan.success).toBe(true);
    expect(await fixture.service.getRecord("ws-orphan")).not.toBeNull();
    expect(fixture.modelCalls).toHaveLength(3);
  });

  it("releases the teardown gate when a removal aborts before its point of no return", async () => {
    using fixture = await createFixture();
    // The removal drain marks the workspace; every trigger is refused...
    await fixture.service.cancelInFlightConsolidation("ws-dream");
    const refused = await fixture.service.maybeRun("ws-dream", "manual");
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toContain("being removed");
    expect(fixture.modelCalls).toHaveLength(0);
    // ...until the aborted removal (no tombstone, workspace intact) lifts it.
    fixture.service.releaseRemovalCancellation("ws-dream");
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("finalizes a removed workspace's retryable harvest records so they are never retried", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
    const metadata = await seedCompactionEpoch(fixture, "ws-sub");
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        harvestsByWorkspace: {
          "ws-sub": {
            [metadata.summaryMessageId]: {
              status: "failed",
              startedAt: Date.now() - 10_000,
              completedAt: Date.now() - 9_000,
              attemptCount: 1,
              boundaryKey: metadata.summaryMessageId,
              compactionEpoch: metadata.compactionEpoch,
              acceptedCandidates: 0,
              skippedCandidates: 0,
              error: "crashed mid-harvest",
              completionMetadata: metadata,
            },
          },
        },
      })
    );
    await fixture.service.finalizeHarvestsForRemoval("ws-sub");
    const record = (await fixture.service.getStatus("ws-sub")).latestHarvestRecord;
    expect(record?.status).toBe("failed");
    expect(record?.attemptCount).toBe(HARVEST_MAX_ATTEMPTS);
    // The owner's run no longer sees a retryable child bucket.
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
    expect((await fixture.service.getStatus("ws-sub")).latestHarvestRecord?.attemptCount).toBe(
      HARVEST_MAX_ATTEMPTS
    );
  });

  it("keeps a removal-finalized harvest record terminal against residual retryable writes", async () => {
    using fixture = await createFixture({ modelFactory: harvestCandidateModel });
    await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
    const metadata = await seedCompactionEpoch(fixture, "ws-sub");
    const boundaryKey = metadata.summaryMessageId;
    const base = {
      startedAt: Date.now() - 10_000,
      attemptCount: 1,
      boundaryKey,
      compactionEpoch: metadata.compactionEpoch,
      acceptedCandidates: 0,
      skippedCandidates: 0,
      completionMetadata: metadata,
    };
    // Residual runs of the bounded cancellation drain record through the same
    // path as the live harvest; reach it directly to interleave with finalization.
    const save = (record: MemoryHarvestRecordPayload) =>
      Effect.runPromise(
        (
          fixture.service as unknown as {
            saveHarvestRecordEffect: (
              workspaceId: string,
              boundaryKey: string,
              record: MemoryHarvestRecordPayload,
              projectPath: string
            ) => Effect.Effect<void>;
          }
        ).saveHarvestRecordEffect("ws-sub", boundaryKey, record, "")
      );
    await save({ ...base, status: "pending" });
    await fixture.service.finalizeHarvestsForRemoval("ws-sub");
    const latest = async () => (await fixture.service.getStatus("ws-sub")).latestHarvestRecord;
    expect((await latest())?.attemptCount).toBe(HARVEST_MAX_ATTEMPTS);

    // A residual retryable failure landing after finalization must not reopen the bucket...
    await save({ ...base, status: "failed", completedAt: Date.now(), error: "residual failure" });
    expect((await latest())?.attemptCount).toBe(HARVEST_MAX_ATTEMPTS);
    expect((await latest())?.error).toContain("workspace removed");
    // ...while a residual completion (its writes really landed) is kept as the truth,
    // and finalization never demotes a completed record.
    await save({ ...base, status: "completed", completedAt: Date.now(), acceptedCandidates: 1 });
    await fixture.service.finalizeHarvestsForRemoval("ws-sub");
    expect((await latest())?.status).toBe("completed");
  });

  it("launch sweep skips archived workspaces and caps runs per launch", async () => {
    using fixture = await createFixture();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const writeFor = (workspaceId: string) =>
      fixture.metaService.recordAccess(
        memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId }),
        { write: true }
      );
    await fixture.addWorkspace("ws-archived", { archivedAt: new Date().toISOString() });
    await writeFor("ws-archived");
    const extraIds: string[] = [];
    for (let i = 0; i < MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP + 1; i++) {
      const id = `ws-extra-${i}`;
      extraIds.push(id);
      await fixture.addWorkspace(id);
      // Each workspace qualifies via its own workspace-scope write.
      await writeFor(id);
    }

    const recency = new Map<string, number>([
      ["ws-archived", dayAgo],
      ...extraIds.map((id): [string, number] => [id, dayAgo]),
    ]);
    await fixture.service.runLaunchSweep(recency);

    // Archived workspaces never run (they got their final pass at archive
    // time) and the cap bounds the rest.
    expect(fixture.modelCalls).toHaveLength(MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP);
    expect(await fixture.service.getRecord("ws-archived")).toBeNull();
    expect(
      await fixture.service.getRecord(`ws-extra-${MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP}`)
    ).toBeNull();
  });

  it("a project-only write qualifies one sibling workspace per sweep", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "lesson.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-dream",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-dream", dayAgo],
        ["ws-other", dayAgo],
      ])
    );

    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("debounces project-only launch writes against recent project coverage", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const recentProjectRunAt = Date.now() - 60_000;
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        projects: {
          "/projects/demo": {
            lastRunAt: recentProjectRunAt,
            trigger: "launch",
            summary: "recent project coverage",
            ops: [],
          },
        },
      })
    );
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "new.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-dream",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(new Map([["ws-other", dayAgo]]));

    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("does not qualify real-bucket multi-project workspaces from project-only writes", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-task", { bucket: "/projects/demo" });
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "lesson.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-task",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(new Map([["ws-task", dayAgo]]));

    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("recent legacy workspace-only records do not suppress first project launch coverage", async () => {
    using fixture = await createFixture();
    const recentWorkspaceRunAt = Date.now() - 60_000;
    // Pre-project-memory sidecars only proved workspace/global coverage. Even a
    // project write older than that legacy run still needs one project pass.
    const projectWriteAt = recentWorkspaceRunAt - 1_000;
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {
          "ws-dream": {
            lastRunAt: recentWorkspaceRunAt,
            trigger: "manual",
            summary: "pre-project-memory record",
            ops: [],
          },
        },
      })
    );
    const logicalKey = memoryLogicalKey("project", "lesson.md", {
      projectPath: "/projects/demo",
      workspaceId: "ws-dream",
    });
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-meta.json"),
      JSON.stringify({
        entries: {
          [logicalKey]: {
            pinned: false,
            accessCount: 1,
            lastAccessedAt: projectWriteAt,
            lastWriteAt: projectWriteAt,
          },
        },
      })
    );

    await fixture.service.runLaunchSweep(new Map([["ws-dream", Date.now() - 25 * 60 * 60 * 1000]]));

    expect(fixture.modelCalls).toHaveLength(1);
    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.xumHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown> };
    expect(raw.projects?.["/projects/demo"]).toBeDefined();
  });

  it("does not spend the launch cap on candidates skipped by workspace debounce", async () => {
    using fixture = await createFixture();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const recentRunAt = Date.now() - MEMORY_CONSOLIDATION_DEBOUNCE_MS + 60_000;
    const debouncedIds = Array.from(
      { length: MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP },
      (_, index) => `ws-debounced-${index}`
    );
    const sidecarWorkspaces: Record<string, unknown> = {};
    const recency = new Map<string, number>();

    for (const id of debouncedIds) {
      await fixture.addWorkspace(id);
      sidecarWorkspaces[id] = {
        lastRunAt: recentRunAt,
        trigger: "manual",
        summary: "recent run",
        ops: [],
      };
      await fixture.metaService.recordAccess(
        memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId: id }),
        { write: true }
      );
      recency.set(id, dayAgo);
    }
    await fixture.addWorkspace("ws-eligible");
    await fixture.metaService.recordAccess(
      memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId: "ws-eligible" }),
      { write: true }
    );
    recency.set("ws-eligible", dayAgo);
    await fsPromises.writeFile(
      path.join(fixture.xumHome, "memory-consolidation.json"),
      JSON.stringify({ workspaces: sidecarWorkspaces })
    );

    await fixture.service.runLaunchSweep(recency);

    expect(fixture.modelCalls).toHaveLength(1);
    expect((await fixture.service.getRecord("ws-eligible"))?.trigger).toBe("launch");
  });

  it("a global-only write qualifies a single covering run per sweep, not one per workspace", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });

    // Both workspaces are idle with no workspace-scope writes; the shared
    // global write needs exactly one covering pass, not duplicate provider
    // calls up to the sweep cap.
    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-dream", dayAgo],
        ["ws-other", dayAgo],
      ])
    );
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("launch sweep does not re-qualify other workspaces from a global write already covered by a newer run", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });

    // First sweep consolidates ws-dream — every run covers global scope.
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(1);

    // The same (now covered) global write must not qualify ws-other later;
    // otherwise each run's own global writes re-qualify every other idle
    // workspace in an endless multi-launch feedback loop.
    await fixture.service.runLaunchSweep(new Map([["ws-other", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("resolves headless effort independently from model with workspace, global, definition, and off precedence", async () => {
    using fixture = await createFixture();
    const resolve = (definitionAiDefaults?: { thinkingLevel: "low" }) =>
      resolveHeadlessAgentSettings(
        fixture.config,
        "ws-dream",
        "dream",
        "coder:private-route",
        definitionAiDefaults
      );
    expect(resolve().thinkingLevel).toBe("off");
    expect(resolve({ thinkingLevel: "low" }).thinkingLevel).toBe("low");
    await fixture.config.editConfig((cfg) => {
      cfg.agentAiDefaults = { dream: { thinkingLevel: "high" } };
      return cfg;
    });
    expect(resolve({ thinkingLevel: "low" })).toMatchObject({
      model: "coder:private-route",
      thinkingLevel: "high",
    });
    await fixture.config.editConfig((cfg) => {
      cfg.projects.get("/projects/demo")!.workspaces[0].aiSettingsByAgent = {
        dream: { model: "coder:workspace-recall", thinkingLevel: "off" },
      };
      return cfg;
    });
    expect(resolve({ thinkingLevel: "low" })).toMatchObject({
      model: "coder:workspace-recall",
      thinkingLevel: "off",
    });
  });

  it.each([false, true])(
    "pins the resolved selected agent route ahead of stale buckets (Plan bucket: %s)",
    async (stalePlan) => {
      using fixture = await createFixture();
      const selected = "private:exec-global";
      await fixture.config.editConfig((cfg) => {
        const workspace = cfg.projects.get("/projects/demo")!.workspaces[0];
        workspace.agentId = "exec";
        workspace.aiSettingsByAgent = stalePlan
          ? { plan: { model: "openai:stale-plan", thinkingLevel: "off" } }
          : {};
        delete workspace.aiSettings;
        cfg.agentAiDefaults = { exec: { modelString: selected } };
        return cfg;
      });
      const resolve = () =>
        resolveHeadlessAgentModelString(fixture.config, "ws-dream", "dream", selected);
      expect(resolve()).toBe(selected);
      await fixture.config.editConfig((cfg) => {
        cfg.agentAiDefaults!.dream = { modelString: "openai:dream-global" };
        return cfg;
      });
      expect(resolve()).toBe("openai:dream-global");
      await fixture.config.editConfig((cfg) => {
        cfg.projects.get("/projects/demo")!.workspaces[0].aiSettingsByAgent!.dream = {
          model: "private:dream-workspace",
          thinkingLevel: "off",
        };
        return cfg;
      });
      expect(resolve()).toBe("private:dream-workspace");
    }
  );

  it.each([true, false])(
    "resolves headless self-inheritance with append=%s without reading project overrides",
    async (append) => {
      using fixture = await createFixture();
      const builtin = await resolveHeadlessAgentDefinition(
        fixture.xumHome,
        "dream",
        runtimeFactory
      );
      if (!builtin) throw new Error("Expected built-in dream");
      const globals = path.join(fixture.xumHome, "agents");
      const projects = path.join(fixture.xumHome, ".xum", "agents");
      await fsPromises.mkdir(globals, { recursive: true });
      await fsPromises.mkdir(projects, { recursive: true });
      await fsPromises.writeFile(
        path.join(projects, "dream.md"),
        "---\nname: Untrusted\nai:\n  model: public:wrong-route\n---\nProject prompt must not load."
      );
      await fsPromises.writeFile(
        path.join(globals, "dream.md"),
        `---\nname: Dream\nbase: dream\ndisabled: true\nprompt:\n  append: ${append}\nai:\n  model: private:dream\n---\nLocal memory guidance.`
      );
      const resolved = await resolveHeadlessAgentDefinition(
        fixture.xumHome,
        "dream",
        runtimeFactory
      );
      expect(resolved?.body).toBe(
        append ? `${builtin.body}\n\nLocal memory guidance.` : "Local memory guidance."
      );
      expect(resolved?.frontmatter).toMatchObject({
        disabled: true,
        ai: { model: "private:dream" },
      });
      expect(
        resolveHeadlessAgentModelString(
          fixture.config,
          "ws-dream",
          "dream",
          "openai:parent",
          resolved?.frontmatter.ai
        )
      ).toBe("private:dream");
    }
  );

  it("resolves headless inherited AI and enablement with workspace/config/definition/parent precedence", async () => {
    using fixture = await createFixture();
    const globals = path.join(fixture.xumHome, "agents");
    await fsPromises.mkdir(globals, { recursive: true });
    await fsPromises.writeFile(
      path.join(globals, "private-base.md"),
      "---\nname: Private base\ndisabled: true\nai:\n  model: private:inherited\n---\nInherited protocol."
    );
    await fsPromises.writeFile(
      path.join(globals, "dream.md"),
      "---\nname: Dream\nbase: private-base\n---\nLocal guidance."
    );
    const resolved = await resolveHeadlessAgentDefinition(fixture.xumHome, "dream", runtimeFactory);
    expect(resolved?.body).toBe("Inherited protocol.\n\nLocal guidance.");
    expect(resolved?.frontmatter.disabled).toBe(true);
    const resolveModel = () =>
      resolveHeadlessAgentModelString(
        fixture.config,
        "ws-dream",
        "dream",
        "openai:parent",
        resolved?.frontmatter.ai
      );
    expect(resolveModel()).toBe("private:inherited");
    await fixture.config.editConfig((cfg) => {
      cfg.agentAiDefaults = { dream: { modelString: "private:configured", enabled: true } };
      return cfg;
    });
    expect(resolveModel()).toBe("private:configured");
    await fixture.config.editConfig((cfg) => {
      cfg.projects.get("/projects/demo")!.workspaces[0].aiSettingsByAgent = {
        dream: { model: "private:workspace", thinkingLevel: "off" },
      };
      return cfg;
    });
    expect(resolveModel()).toBe("private:workspace");
  });

  it("fails closed on headless inheritance cycles rather than falling back to another model", async () => {
    using fixture = await createFixture();
    const globals = path.join(fixture.xumHome, "agents");
    await fsPromises.mkdir(globals, { recursive: true });
    await fsPromises.writeFile(
      path.join(globals, "dream.md"),
      "---\nname: Dream\nbase: loop\n---\nChild."
    );
    await fsPromises.writeFile(
      path.join(globals, "loop.md"),
      "---\nname: Loop\nbase: dream\nai:\n  model: private:cycle\n---\nBase."
    );
    expect(
      await resolveHeadlessAgentDefinition(fixture.xumHome, "dream", runtimeFactory)
    ).toBeNull();
    expect(await resolveHeadlessAgentBody(fixture.xumHome, "dream")).toBeNull();
  });

  it("falls back from an empty headless body override and rejects traversal", async () => {
    using fixture = await createFixture();
    const builtin = await resolveHeadlessAgentBody(fixture.xumHome, "dream");
    expect(builtin).not.toBeNull();
    const agents = path.join(fixture.xumHome, "agents");
    await fsPromises.mkdir(agents, { recursive: true });
    await fsPromises.writeFile(path.join(agents, "dream.md"), "---\nname: Empty\n---\n");
    expect(await resolveHeadlessAgentBody(fixture.xumHome, "dream")).toBe(builtin);
    expect(resolveHeadlessAgentBody(fixture.xumHome, "../outside")).rejects.toThrow();
  });

  it("resolves the dream model via the inherit cascade", async () => {
    using fixture = await createFixture();
    // No overrides anywhere => app default.
    const fallback = resolveDreamModelString(fixture.config, "ws-dream");
    expect(fallback.length).toBeGreaterThan(0);

    // Global dream default wins over the app default.
    await fixture.config.editConfig((cfg) => {
      cfg.agentAiDefaults = { dream: { modelString: "anthropic:claude-test-dream" } };
      return cfg;
    });
    expect(resolveDreamModelString(fixture.config, "ws-dream")).toBe("anthropic:claude-test-dream");
  });

  it("keeps the dream fallback on the workspace's selected route (r31 security)", async () => {
    using fixture = await createFixture();
    // The workspace's CURRENT model lives in the selected agent's per-agent
    // bucket; legacy aiSettings is stale (updateAgentAISettings never rewrites
    // it). Without a dream override the fallback must follow the selected
    // route, not the stale legacy model or the built-in default.
    await fixture.config.editConfig((cfg) => {
      cfg.agentAiDefaults = {};
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((entry) => entry.id === "ws-dream");
        if (workspace) {
          workspace.agentId = "exec";
          workspace.aiSettingsByAgent = {
            exec: { model: "coder:private-gw/claude-sonnet", thinkingLevel: "off" },
          };
          workspace.aiSettings = { model: "anthropic:stale-legacy", thinkingLevel: "off" };
        }
      }
      return cfg;
    });
    expect(resolveDreamModelString(fixture.config, "ws-dream")).toBe(
      "coder:private-gw/claude-sonnet"
    );

    // An explicit per-workspace dream override remains higher-precedence
    // consent for a different route.
    await fixture.config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((entry) => entry.id === "ws-dream");
        if (workspace?.aiSettingsByAgent) {
          workspace.aiSettingsByAgent.dream = {
            model: "anthropic:explicit-dream",
            thinkingLevel: "off",
          };
        }
      }
      return cfg;
    });
    expect(resolveDreamModelString(fixture.config, "ws-dream")).toBe("anthropic:explicit-dream");
  });
});

describe("staleExhaustedHarvestFailure", () => {
  const pendingRecord = (overrides: Partial<MemoryHarvestRecordPayload> = {}) =>
    ({
      status: "pending",
      startedAt: Date.now() - 10 * 60 * 1000,
      attemptCount: HARVEST_MAX_ATTEMPTS,
      boundaryKey: "summary-1",
      compactionEpoch: 1,
      acceptedCandidates: 2,
      skippedCandidates: 1,
      nextChunk: 3,
      ...overrides,
    }) satisfies MemoryHarvestRecordPayload;

  it("fails a stale pending record that used its last attempt, keeping what it had read", () => {
    const before = Date.now();
    const failed = staleExhaustedHarvestFailure(pendingRecord());

    expect(failed).toMatchObject({
      status: "failed",
      attemptCount: HARVEST_MAX_ATTEMPTS,
      acceptedCandidates: 2,
      skippedCandidates: 1,
      nextChunk: 3,
      error: "stale pending harvest exceeded retry attempts",
    });
    expect(failed?.completedAt).toBeGreaterThanOrEqual(before);
  });

  it("keeps the error an earlier attempt already recorded", () => {
    expect(staleExhaustedHarvestFailure(pendingRecord({ error: "stream timed out" }))?.error).toBe(
      "stream timed out"
    );
  });

  it("leaves a record that a retry or a live run still owns", () => {
    expect(staleExhaustedHarvestFailure(undefined)).toBeUndefined();
    // Alive: its last sign of life is inside the timeout.
    expect(
      staleExhaustedHarvestFailure(pendingRecord({ progressAt: Date.now() - 1000 }))
    ).toBeUndefined();
    // Stale, but an attempt is left.
    expect(
      staleExhaustedHarvestFailure(pendingRecord({ attemptCount: HARVEST_MAX_ATTEMPTS - 1 }))
    ).toBeUndefined();
    for (const status of ["completed", "failed"] as const) {
      expect(staleExhaustedHarvestFailure(pendingRecord({ status }))).toBeUndefined();
    }
  });
});

describe("harvestResumeState", () => {
  it("starts a first attempt at the first chunk with nothing read and no floor", () => {
    const { progress, attemptState } = harvestResumeState(undefined);

    expect(progress).toEqual({
      nextChunk: 0,
      ops: [],
      budgetUsed: undefined,
      nextChunkOps: undefined,
      readThroughRowId: undefined,
      usage: undefined,
    });
    expect(attemptState.analyzedFloorRowId).toBeUndefined();
  });

  it("resumes a retry from the cursor, budget, read-through row and floor of the record", () => {
    const ops = [{ command: "create" as const, path: "/memory/a.md", applied: true }];
    const usage = { inputTokens: 10, outputTokens: 4 };
    const { progress, attemptState } = harvestResumeState({
      status: "failed",
      startedAt: 1,
      attemptCount: 1,
      boundaryKey: "summary-1",
      compactionEpoch: 1,
      acceptedCandidates: 1,
      skippedCandidates: 0,
      nextChunk: 2,
      ops,
      budgetUsed: 5,
      nextChunkOps: 1,
      readThroughRowId: "row-9",
      usage,
      analyzedFloorRowId: "row-3",
    });

    expect(progress).toEqual({
      nextChunk: 2,
      ops,
      budgetUsed: 5,
      nextChunkOps: 1,
      readThroughRowId: "row-9",
      usage,
    });
    expect(attemptState.analyzedFloorRowId).toBe("row-3");
  });

  it("starts a retry whose record has a cursor but no floor at the first chunk", () => {
    // Its floor is recomputed and may be newer than the one the cursor counted from: resuming at
    // the old chunk would skip rows no run read.
    const { progress } = harvestResumeState({
      status: "failed",
      startedAt: 1,
      attemptCount: 1,
      boundaryKey: "summary-1",
      compactionEpoch: 1,
      acceptedCandidates: 1,
      skippedCandidates: 0,
      nextChunk: 2,
      nextChunkOps: 1,
      budgetUsed: 5,
    });

    expect(progress).toMatchObject({ nextChunk: 0, nextChunkOps: undefined, budgetUsed: 5 });
  });

  it("keeps a null floor (an attempt that found no earlier run) apart from an absent one", () => {
    const record = {
      status: "failed",
      startedAt: 1,
      attemptCount: 1,
      boundaryKey: "summary-1",
      compactionEpoch: 1,
      acceptedCandidates: 0,
      skippedCandidates: 0,
    } satisfies MemoryHarvestRecordPayload;

    expect(
      harvestResumeState({ ...record, analyzedFloorRowId: null }).attemptState.analyzedFloorRowId
    ).toBeNull();
    expect(harvestResumeState(record).attemptState.analyzedFloorRowId).toBeUndefined();
  });
});
