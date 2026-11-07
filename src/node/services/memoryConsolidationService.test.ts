import { describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { Effect } from "effect";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { ServiceTier } from "@/common/config/schemas/providersConfig";
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
  MEMORY_MAX_FILE_BYTES,
} from "@/common/constants/memory";
import { Err, Ok, type Result } from "@/common/types/result";
import { Config } from "@/node/config";
import {
  HARVEST_MAX_ATTEMPTS,
  MemoryConsolidationService,
  resolveDreamAgentBody,
  resolveDreamModelString,
  resolveHeadlessAgentModelString,
  resolveHeadlessAgentSettings,
  resolveHeadlessAgentBody,
  resolveHeadlessAgentDefinition,
} from "./memoryConsolidationService";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MEMORY_ANALYZER_SYSTEM_PROMPT } from "./memoryHarvest";
import { HistoryService } from "./historyService";
import { MemoryService } from "./memoryService";
import { SessionUsageService } from "./sessionUsageService";
import { TestTempDir } from "./tools/testHelpers";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";
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

interface Fixture extends Disposable {
  xumHome: string;
  config: Config;
  service: MemoryConsolidationService;
  historyService: HistoryService;
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  modelCalls: number[];
  modelPrompts: string[];
  setEnabled: (enabled: boolean) => void;
  /** When true, scripted runs emit a fatal stream error instead of finishing. */
  setStreamFailing: (failing: boolean) => void;
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
  /** Wire a real SessionUsageService (headless cost telemetry tests). */
  withSessionUsage?: boolean;
  /** The pricing identity every created model reports; default: the requested model string. */
  metadataModel?: string;
  /** The service tier every created model pins into its requests; default: none. */
  serviceTier?: ServiceTier;
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
        return Ok({
          model:
            options?.modelFactory?.() ??
            (streamFailing ? failingScriptedModel(capturePrompt) : scriptedModel(capturePrompt)),
          metadataModel: options?.metadataModel ?? modelString,
          ...(options?.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        });
      },
    },
    {
      isExperimentEnabled: (id) =>
        enabled && (id === EXPERIMENT_IDS.MEMORY || id === EXPERIMENT_IDS.MEMORY_CONSOLIDATION),
    },
    options?.withSessionUsage ? new SessionUsageService(config, historyService) : undefined
  );

  return {
    xumHome,
    config,
    service,
    historyService,
    memoryService,
    metaService,
    modelCalls,
    modelPrompts,
    setEnabled: (value) => {
      enabled = value;
    },
    setStreamFailing: (value) => {
      streamFailing = value;
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

  it("runs dream streams one at a time across workspaces", async () => {
    // Two workspaces share global memory (and often a project), so their organizer
    // streams must not overlap. The first stream stays open until a second one starts,
    // or for 150 ms: an unserialized second stream starts inside that window and shows
    // up in the log before the first one ends.
    const events: string[] = [];
    let streamCount = 0;
    let markOtherStarted!: () => void;
    const otherStarted = new Promise<void>((resolve) => {
      markOtherStarted = resolve;
    });
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    let timeoutCount = 0;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      events.push(`timeout-${++timeoutCount}`);
      return realTimeout(ms);
    });
    try {
      using fixture = await createFixture({
        modelFactory: () => {
          const inner = scriptedModel();
          return new MockLanguageModelV3({
            doStream: async (options) => {
              const n = ++streamCount;
              events.push(`start-${n}`);
              if (n === 1) {
                await Promise.race([
                  otherStarted,
                  new Promise((resolve) => setTimeout(resolve, 150)),
                ]);
              } else {
                markOtherStarted();
              }
              events.push(`end-${n}`);
              return inner.doStream(options);
            },
          });
        },
      });
      await fixture.addWorkspace("ws-other");

      const runs = await Promise.all([
        fixture.service.maybeRun("ws-dream", "manual"),
        fixture.service.maybeRun("ws-other", "manual"),
      ]);
      expect(runs.every((run) => run.success)).toBe(true);
      // The 5 min timeout covers a stream, not the wait for its turn.
      expect(events).toEqual(["timeout-1", "start-1", "end-1", "timeout-2", "start-2", "end-2"]);
    } finally {
      timeoutSpy.mockRestore();
    }
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

    /** Past model creation, a run is only waiting for its turn in the queue. */
    async function waitingForTurn(fixture: Fixture, runs: number): Promise<void> {
      await until(() => fixture.modelCalls.length >= runs);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

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

      /** Closes the epoch the way a compaction does, without a row of its own to analyze. */
      async function closeEpochWithoutNewRows(
        fixture: Fixture
      ): Promise<CompactionCompletionMetadata> {
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

      it("keeps a retry of the closing compaction on the rows its first attempt read, even if an archive completes meanwhile", async () => {
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

        expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

        expect(chunkLabels).toEqual(["1/3", "2/3", "2/3", "3/3"]);
        expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
          status: "completed",
          nextChunk: 3,
        });
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

      it("starts the compaction that closes the epoch after the rows an archive that ran out of edits read, not after its newest row", async () => {
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

        const closing = analyzerPrompts
          .filter((run) => run.closing)
          .map((run) => run.prompt)
          .join("\n");
        // The rows no archive chunk read are read now, and the ones it read are not.
        for (let index = 0; index < 12; index++) {
          const row = `preference ${index} x`;
          if (index < 5) expect(closing).not.toContain(row);
          else expect(closing).toContain(row);
        }
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

        it("keeps what its chunks read when its retry is refused by the cost ceiling", async () => {
          const scripted = archiveFailingAtItsSecondChunk();
          using fixture = await createFixture({ modelFactory: scripted.factory });
          await failFirstArchive(fixture);
          await fixture.config.updateUserPreferences([{ memory: { dreamCostCeilingUsd: 0.01 } }]);

          await fixture.service.maybeRunArchivePass("ws-dream");

          // The refusal rewrote the failed record: it must still name the rows already read.
          expect((await harvestRecords(fixture))["open:bulk-11"]).toMatchObject({
            status: "failed",
            nextChunk: 1,
            readThroughRowId: "bulk-4",
          });
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

        it.each([
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
    /** The smallest ceiling a user can set: below every run's estimate. */
    const TIGHT_CEILING_USD = 0.01;
    const LOOSE_CEILING_USD = 1_000;

    function setCeiling(fixture: Fixture, usd: number | null): Promise<void> {
      return fixture.config.updateUserPreferences([{ memory: { dreamCostCeilingUsd: usd } }]);
    }

    function expectOverCeiling(result: Result<unknown, string>): void {
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("over the 0.01 USD ceiling");
    }

    it("runs both passes as before when no ceiling is set, and records each run's estimate", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await appendRows(fixture, openRowTexts);

      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
      const harvest = (await harvestRecords(fixture))["open:open-2"];
      expect(harvest?.status).toBe("completed");
      expect(harvest?.estimatedUsd).toBeGreaterThan(0);
      expect((await fixture.service.getRecord("ws-dream"))?.estimatedUsd).toBeGreaterThan(0);
    });

    it("starts no analyzer stream over the ceiling, and records the reason and the estimate", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await setCeiling(fixture, TIGHT_CEILING_USD);
      const metadata = await seedCompactionEpoch(fixture);

      expectOverCeiling(await fixture.service.maybeHarvestThenSweep(metadata));

      expect(models.runs).toEqual([]);
      const record = (await harvestRecords(fixture))["summary-1"];
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("over the 0.01 USD ceiling");
      expect(record?.estimatedUsd).toBeGreaterThan(TIGHT_CEILING_USD);
      expect(record?.acceptedCandidates).toBe(0);
    });

    it("lets a raised ceiling run a refused job on the next trigger, however many refusals came first", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await setCeiling(fixture, TIGHT_CEILING_USD);
      const metadata = await seedCompactionEpoch(fixture);

      // A refused attempt spends nothing, so it must not burn the attempts that guard a run
      // failing after it spent: more refusals than HARVEST_MAX_ATTEMPTS leave the job retryable.
      for (let refusal = 0; refusal <= HARVEST_MAX_ATTEMPTS; refusal++) {
        expectOverCeiling(await fixture.service.maybeHarvestThenSweep(metadata));
      }
      expect(models.runs).toEqual([]);
      expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
        status: "failed",
        attemptCount: 0,
      });

      await setCeiling(fixture, LOOSE_CEILING_USD);
      // Any owner run is a trigger: its recovery pass retries the refused job, after the run.
      expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

      expect(models.runs.map((run) => run.kind)).toEqual(["dream", "analyzer"]);
      expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
        status: "completed",
        attemptCount: 1,
      });
    });

    it("prices a retry on the chunks still to analyze, not on the whole epoch again", async () => {
      let failedOnce = false;
      using fixture = await createFixture({
        modelFactory: () =>
          new MockLanguageModelV3({
            doStream: (options) => {
              const prompt = userPromptText(options);
              const label = /Transcript chunk (\d+\/\d+)/.exec(prompt)?.[1] ?? "";
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
      const failed = (await harvestRecords(fixture))["summary-1"];
      expect(failed).toMatchObject({ status: "failed", nextChunk: 1 });
      expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

      // Chunk 1 is paid for: the retry's estimate covers chunks 2 and 3 only.
      const retried = (await harvestRecords(fixture))["summary-1"];
      expect(retried).toMatchObject({ status: "completed", nextChunk: 3 });
      expect(retried?.estimatedUsd).toBeGreaterThan(0);
      expect(retried?.estimatedUsd).toBeLessThan((failed?.estimatedUsd ?? 0) * 0.9);
    });

    it("never refuses a retry whose budget is spent: it skips every chunk, so it costs nothing", async () => {
      let failedOnce = false;
      using fixture = await createFixture({
        modelFactory: () =>
          new MockLanguageModelV3({
            doStream: (options) => {
              const afterToolResult = options.prompt.some((message) => message.role === "tool");
              if (systemPromptText(options) !== MEMORY_ANALYZER_SYSTEM_PROMPT) {
                return Promise.resolve({ stream: noChangesStream() });
              }
              // Chunk 1 spends every edit, then its stream dies: the failed record keeps the spent
              // budget, and a retry starts at chunk 1 again.
              if (afterToolResult) {
                failedOnce = true;
                return Promise.resolve({ stream: failingStream() });
              }
              return Promise.resolve({
                stream: spendEveryEditStream(),
              });
            },
          }),
      });
      await appendBulkRows(fixture);
      const metadata = await seedCompactionEpoch(fixture);
      expect((await fixture.service.maybeHarvestThenSweep(metadata)).success).toBe(true);
      expect(failedOnce).toBe(true);
      expect((await harvestRecords(fixture))["summary-1"]).toMatchObject({
        status: "failed",
        nextChunk: 0,
        budgetUsed: MEMORY_ANALYZER_OP_BUDGET,
      });

      // The ceiling the user lowers meanwhile is under the estimate of all three chunks.
      await setCeiling(fixture, TIGHT_CEILING_USD);
      expectDebounced(await fixture.service.maybeHarvestThenSweep(metadata));

      const retried = (await harvestRecords(fixture))["summary-1"];
      expect(retried).toMatchObject({ status: "completed", estimatedUsd: 0 });
      expect(retried?.note).toContain("chunks 1-3 of 3");
    });

    it("refuses the organizer over the ceiling without a stream or a record, and runs once it is raised", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await setCeiling(fixture, TIGHT_CEILING_USD);

      expectOverCeiling(await fixture.service.maybeRun("ws-dream", "manual"));

      expect(models.runs).toEqual([]);
      expect(await fixture.service.getRecord("ws-dream")).toBeNull();

      await setCeiling(fixture, LOOSE_CEILING_USD);
      expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
      expect(await fixture.service.getRecord("ws-dream")).not.toBeNull();
    });

    it("holds an archive pass's open-epoch analysis and its dream, then runs both once the ceiling is raised", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({ modelFactory: models.factory });
      await setCeiling(fixture, TIGHT_CEILING_USD);
      await appendRows(fixture, openRowTexts);

      expectOverCeiling(await fixture.service.maybeRunArchivePass("ws-dream"));

      expect(models.runs).toEqual([]);
      expect((await harvestRecords(fixture))["open:open-2"]).toMatchObject({
        status: "failed",
        attemptCount: 0,
      });

      await setCeiling(fixture, null);
      expect((await fixture.service.maybeRunArchivePass("ws-dream")).success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["analyzer", "dream"]);
      expect((await harvestRecords(fixture))["open:open-2"]?.status).toBe("completed");
    });

    describe("the latest refusal", () => {
      it("is kept in the status with its reason and estimate, replaced by the next refusal, and cleared by a run that completes", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await setCeiling(fixture, TIGHT_CEILING_USD);
        expect((await fixture.service.getStatus("ws-dream")).latestRefusal).toBeNull();

        // An automatic trigger: nothing but the status shows that the dream was stopped.
        expectOverCeiling(await fixture.service.maybeRun("ws-dream", "compaction"));
        const first = (await fixture.service.getStatus("ws-dream")).latestRefusal;
        expect(first?.reason).toContain("over the 0.01 USD ceiling");
        expect(first?.estimatedUsd).toBeGreaterThan(TIGHT_CEILING_USD);

        // A refusal under another ceiling replaces the first: the status keeps the latest only.
        await setCeiling(fixture, 0.02);
        const refused = await fixture.service.maybeRun("ws-dream", "launch");
        expect(refused.success).toBe(false);
        expect((await fixture.service.getStatus("ws-dream")).latestRefusal?.reason).toContain(
          "over the 0.02 USD ceiling"
        );

        await setCeiling(fixture, LOOSE_CEILING_USD);
        expect((await fixture.service.maybeRun("ws-dream", "launch")).success).toBe(true);
        expect((await fixture.service.getStatus("ws-dream")).latestRefusal).toBeNull();
      });

      it("keeps a refusal across a reload of the sidecar and tells a sub-agent its owner's", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-sub", { parentWorkspaceId: "ws-dream" });
        await setCeiling(fixture, TIGHT_CEILING_USD);

        // A child's trigger runs the owner's dream, so the owner's store carries the refusal.
        expectOverCeiling(await fixture.service.maybeRun("ws-sub", "compaction"));

        const sidecar = JSON.parse(
          await fsPromises.readFile(
            path.join(fixture.xumHome, "memory-consolidation.json"),
            "utf-8"
          )
        ) as { refusalsByWorkspace: Record<string, { reason: string }> };
        expect(Object.keys(sidecar.refusalsByWorkspace)).toEqual(["ws-dream"]);
        for (const workspaceId of ["ws-dream", "ws-sub"]) {
          expect((await fixture.service.getStatus(workspaceId)).latestRefusal?.reason).toContain(
            "over the 0.01 USD ceiling"
          );
        }
      });

      it("drops the refusal of a workspace that is removed, and no other", async () => {
        const models = archivePassModels();
        using fixture = await createFixture({ modelFactory: models.factory });
        await fixture.addWorkspace("ws-other");
        await setCeiling(fixture, TIGHT_CEILING_USD);
        expectOverCeiling(await fixture.service.maybeRun("ws-dream", "compaction"));
        expectOverCeiling(await fixture.service.maybeRun("ws-other", "compaction"));
        const refusedWorkspaces = async () => {
          const sidecar = JSON.parse(
            await fsPromises.readFile(
              path.join(fixture.xumHome, "memory-consolidation.json"),
              "utf-8"
            )
          ) as { refusalsByWorkspace: Record<string, unknown> };
          return Object.keys(sidecar.refusalsByWorkspace).sort();
        };
        expect(await refusedWorkspaces()).toEqual(["ws-dream", "ws-other"]);

        // The workspace has no harvest records: its refusal alone must still go.
        await fixture.service.finalizeHarvestsForRemoval("ws-dream");

        expect(await refusedWorkspaces()).toEqual(["ws-other"]);
      });

      it("drops a malformed refusal instead of failing the sidecar load", async () => {
        using fixture = await createFixture();
        await fsPromises.writeFile(
          path.join(fixture.xumHome, "memory-consolidation.json"),
          JSON.stringify({
            workspaces: {},
            projects: {},
            refusalsByWorkspace: { "ws-dream": { at: "yesterday", reason: 7 } },
          })
        );

        expect((await fixture.service.getStatus("ws-dream")).latestRefusal).toBeNull();
      });
    });

    describe("service tier of the created model", () => {
      // gpt-6.1-sol bills the priority tier at twice its Standard rates.
      const PRICED_MODEL = "openai:gpt-6.1-sol";
      const PRIORITY_FACTOR = 2;

      /** What each pass records when the tight ceiling refuses it. */
      async function refusedEstimates(
        serviceTier?: ServiceTier
      ): Promise<{ analyzerUsd: number; organizerUsd: number }> {
        using fixture = await createFixture({ metadataModel: PRICED_MODEL, serviceTier });
        await setCeiling(fixture, TIGHT_CEILING_USD);
        expectOverCeiling(
          await fixture.service.maybeHarvestThenSweep(await seedCompactionEpoch(fixture))
        );
        const analyzerUsd = (await harvestRecords(fixture))["summary-1"]?.estimatedUsd;
        expectOverCeiling(await fixture.service.maybeRun("ws-dream", "manual"));
        const organizerUsd = (await fixture.service.getStatus("ws-dream")).latestRefusal
          ?.estimatedUsd;
        expect(analyzerUsd).toBeGreaterThan(0);
        expect(organizerUsd).toBeGreaterThan(0);
        return { analyzerUsd: analyzerUsd ?? 0, organizerUsd: organizerUsd ?? 0 };
      }

      it("prices the analyzer job and the organizer run at the tier the model carries", async () => {
        const standard = await refusedEstimates();
        const priority = await refusedEstimates("priority");

        expect(priority.analyzerUsd).toBeCloseTo(PRIORITY_FACTOR * standard.analyzerUsd, 9);
        expect(priority.organizerUsd).toBeCloseTo(PRIORITY_FACTOR * standard.organizerUsd, 9);
      });

      it("refuses a priority-tier run under a ceiling its Standard run fits", async () => {
        const ceilingUsd = (await refusedEstimates()).organizerUsd * 1.5;

        for (const [serviceTier, allowed] of [
          [undefined, true],
          ["priority", false],
        ] as const) {
          const models = archivePassModels();
          using fixture = await createFixture({
            modelFactory: models.factory,
            metadataModel: PRICED_MODEL,
            serviceTier,
          });
          await setCeiling(fixture, ceilingUsd);

          const result = await fixture.service.maybeRun("ws-dream", "manual");

          expect(result.success).toBe(allowed);
          expect(models.runs.map((run) => run.kind)).toEqual(allowed ? ["dream"] : []);
        }
      });
    });

    it("refuses a model with no known price only while a ceiling is set", async () => {
      const models = archivePassModels();
      using fixture = await createFixture({
        modelFactory: models.factory,
        metadataModel: "ollama:no-such-model",
      });
      await setCeiling(fixture, LOOSE_CEILING_USD);

      const refused = await fixture.service.maybeRun("ws-dream", "manual");
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("ollama:no-such-model");
      expect(models.runs).toEqual([]);

      await setCeiling(fixture, null);
      expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
      expect(models.runs.map((run) => run.kind)).toEqual(["dream"]);
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

  describe("launch sweep under a cost ceiling", () => {
    it("does not count a workspace the ceiling refused against the cap, so the next one runs", async () => {
      const calibration = archivePassModels();
      using fixture = await createFixture({ modelFactory: calibration.factory });
      const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
      const writeFor = (workspaceId: string) =>
        fixture.metaService.recordAccess(
          memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId }),
          { write: true }
        );
      // A small run's estimate, recorded by a manual run of a workspace the sweep never visits.
      await fixture.addWorkspace("ws-calibration");
      const calibrationRun = await fixture.service.maybeRun("ws-calibration", "manual");
      expect(calibrationRun.success && calibrationRun.data.estimatedUsd).toBeGreaterThan(0);
      const smallUsd = calibrationRun.success ? (calibrationRun.data.estimatedUsd ?? 0) : 0;
      // Big workspaces read 400 KB of memory, which prices far over the ceiling; small ones fit.
      const bigIds = Array.from(
        { length: MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP },
        (_, i) => `big-${i}`
      );
      const smallIds = ["small-0", "small-1"];
      const ctxFor = (workspaceId: string) => ({
        runtime: null,
        checkoutCwd: "",
        workspaceId,
        projectPath: "/projects/demo",
      });
      for (const id of [...bigIds, ...smallIds]) {
        await fixture.addWorkspace(id);
        await writeFor(id);
      }
      for (const id of bigIds) {
        for (let file = 0; file < 4; file++) {
          const saved = await fixture.memoryService.saveFile(
            ctxFor(id),
            `/memories/workspace/big-${file}.md`,
            "x".repeat(MEMORY_MAX_FILE_BYTES - 1_000),
            null,
            "agent"
          );
          expect(saved.success).toBe(true);
        }
      }
      await fixture.config.updateUserPreferences([
        { memory: { dreamCostCeilingUsd: smallUsd * 1.2 } },
      ]);

      // The refused ones come first in sweep order, ahead of the ones that fit.
      await fixture.service.runLaunchSweep(
        new Map([...bigIds, ...smallIds].map((id): [string, number] => [id, dayAgo]))
      );

      for (const id of bigIds) expect(await fixture.service.getRecord(id)).toBeNull();
      for (const id of smallIds) expect(await fixture.service.getRecord(id)).not.toBeNull();
    });
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
