import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ai from "ai";
import * as atomicWrite from "write-file-atomic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { readFile, writeFile } from "node:fs/promises";
import assert from "@/common/utils/assert";
import { createMuxMessage } from "@/common/types/message";
import {
  ContinuousCompactionJournalSchema,
  type ContinuousCompactionJournal,
} from "@/common/orpc/schemas/continuousCompaction";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import {
  exactJson,
  rebuildContinuousPrefix,
  type ContinuousPrefixSwap,
} from "./continuousCompactionJournal";

const workspaceId = "swap-tests";
const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };
const originalMessages: ai.ModelMessage[] = [
  { role: "system", content: "system", providerOptions: cache },
  { role: "user", content: "old prompt" },
  { role: "assistant", content: [{ type: "text", text: "old output" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "keep",
        toolName: "bash",
        input: {},
        providerOptions: cache,
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "keep",
        toolName: "bash",
        output: { type: "text", value: "kept output" },
        providerOptions: cache,
      },
    ],
  },
];

function journalFixture(): ContinuousCompactionJournal {
  const boundary = createMuxMessage("summary", "assistant", "summary", {
    compactionBoundary: true,
    compactionEpoch: 1,
    compacted: "user",
    muxMetadata: { type: "compaction-summary", strategy: "continuous" },
  });
  return {
    version: 1,
    boundary,
    staticCopies: [],
    liveTailCopySpec: {
      sourceMessageId: "live",
      sourceHistorySequence: 1,
      copyId: "copy",
      partIndex: 1,
      metadataTemplate: { synthetic: true, rlmPreservedTailCopy: true },
    },
    postCompactionAttachments: [],
    prefixSourceRows: [boundary, createMuxMessage("user-copy", "user", "current prompt")],
    systemPrefix: [{ role: "system", content: "system", providerOptions: cache }],
    cacheEnabled: true,
    preparation: {
      modelString: "anthropic:claude-sonnet-4-5",
      providerForMessages: "anthropic",
      effectiveThinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
    },
    providerFamily: "anthropic",
    parentModel: "anthropic:claude-sonnet-4-5",
    summaryModel: "anthropic:claude-sonnet-4-5",
    headFingerprint: "head",
    sourceFingerprint: "source",
    headEnd: { id: "head", sequence: 0 },
    epoch: 0,
    streamMessageId: "live",
    streamHistorySequence: 1,
    stepNumber: 0,
    firstTailToolCallId: "keep",
  };
}

interface Tracker {
  workspaceId: string;
  pendingPrefixSwap?: ContinuousPrefixSwap;
  consumedPrefixSwap?: ContinuousPrefixSwap;
  prefixSwapInvalidated?: boolean;
  latestMessages?: ai.ModelMessage[];
}
type Prepare = NonNullable<Parameters<typeof ai.streamText>[0]["prepareStep"]>;

function prepareHarness(manager: StreamManager, tracker: Tracker) {
  const spy = spyOn(ai, "streamText").mockReturnValue({} as ReturnType<typeof ai.streamText>);
  const create = Reflect.get(manager, "createStreamResult") as (
    request: { model: ai.LanguageModel; messages: ai.ModelMessage[] },
    controller: AbortController,
    tracker: Tracker
  ) => unknown;
  const controller = new AbortController();
  create.call(manager, { model, messages: originalMessages }, controller, tracker);
  const prepare: Prepare | undefined = spy.mock.calls.at(-1)?.[0].prepareStep;
  assert(prepare, "Expected prepareStep callback");
  return {
    controller,
    run: (messages = originalMessages, stepNumber = 1) =>
      Promise.resolve(
        prepare({
          messages,
          stepNumber,
          model,
          steps: [],
          initialMessages: originalMessages,
          responseMessages: [],
          instructions: undefined,
          initialInstructions: undefined,
          toolsContext: {},
          runtimeContext: {},
        })
      ),
  };
}

describe("continuous prefix prepareStep and journal", () => {
  let history: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    history = await createTestHistoryService();
    await history.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("live", "assistant", "placeholder")
    );
  });
  afterEach(async () => {
    mock.restore();
    await history.cleanup();
  });

  async function setup() {
    const journal = journalFixture();
    const prefix = await rebuildContinuousPrefix(journal, workspaceId);
    const swap = { journal, prefix, firstTailToolCallId: "keep" };
    const tracker: Tracker = { workspaceId, pendingPrefixSwap: swap };
    const manager = new StreamManager(history.historyService);
    const harness = prepareHarness(manager, tracker);
    const store = history.historyService.getContinuousCompactionJournal(workspaceId);
    return { ...harness, store, tracker, swap, manager };
  }

  it("journals before returning, swaps once by content identity, and strips retained cache markers", async () => {
    const { run, tracker, store, swap } = await setup();
    const result = await run();
    assert(result?.messages, "Expected swapped messages");
    const persisted = ContinuousCompactionJournalSchema.parse(
      JSON.parse(await readFile(store.path, "utf8"))
    );
    expect(persisted.stepNumber).toBe(1);
    expect(persisted.prefix).toEqual(swap.prefix.map(exactJson));
    expect(result.messages.slice(0, swap.prefix.length)).toEqual(swap.prefix);
    expect(JSON.stringify(result.messages)).not.toContain("old output");
    expect(JSON.stringify(result.messages)).toContain("kept output");
    // System + prefix are the two message breakpoints; tools supply the third.
    expect(JSON.stringify(result.messages).match(/cacheControl/g)?.length).toBe(2);
    expect(tracker.latestMessages).toBe(result.messages);
    expect(tracker.pendingPrefixSwap).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBe(swap);
    const write = spyOn(store, "write");
    expect(await run(result.messages, 2)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(tracker.latestMessages).toEqual(result.messages);
  });

  for (const tail of [[], originalMessages.slice(4)]) {
    it("drops a missing/non-assistant locator without slicing or writing", async () => {
      const { run, tracker, store } = await setup();
      expect(await run(tail)).toBeUndefined();
      expect(tracker.latestMessages).toBe(tail);
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(tracker.consumedPrefixSwap).toBeUndefined();
      expect(await store.read()).toBeNull();
    });
  }

  it("does not return a swap when atomic journal persistence fails", async () => {
    const { run, tracker, store } = await setup();
    spyOn(atomicWrite, "default").mockImplementationOnce(
      Object.assign(() => Promise.reject(new Error("disk full")), {
        sync: atomicWrite.default.sync,
      })
    );
    expect(await run()).toBeUndefined();
    expect(tracker.latestMessages).toBe(originalMessages);
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it("reset racing a journal write fences the return and deletes the stale record", async () => {
    const { run, tracker, store } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = atomicWrite.default;
    spyOn(atomicWrite, "default").mockImplementationOnce(
      Object.assign(
        async (filename: string, data: string | Buffer) => {
          entered();
          await gate;
          return original(filename, data);
        },
        { sync: original.sync }
      )
    );
    const preparing = run();
    await started;
    tracker.pendingPrefixSwap = undefined;
    const cleared = store.clear();
    release();
    expect(await preparing).toBeUndefined();
    await cleared;
    expect(await store.read()).toBeNull();
    expect(tracker.consumedPrefixSwap).toBeUndefined();
  });

  it("rejects lossy options rather than silently JSON-dropping them", async () => {
    const { run, tracker, swap, store } = await setup();
    // A request-affecting function is intentionally outside the SDK's JSON option contract.
    Reflect.set(swap.prefix[0], "unknownRequestField", () => "must not disappear");
    expect(await run()).toBeUndefined();
    expect(tracker.consumedPrefixSwap).toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it("rebuilds unrepresentable wire from pinned source rows and actual attachments", async () => {
    const journal = journalFixture();
    journal.prefixSourceRows.push({
      id: "file",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: "https://example.com/image.png" }],
    });
    const prefix = await rebuildContinuousPrefix(journal, workspaceId);
    const store = history.historyService.getContinuousCompactionJournal(workspaceId);
    const persisted = await store.write(journal, prefix, () => true);
    assert(persisted, "Source pipeline must reproduce its own prefix");
    expect(persisted.prefix).toBeUndefined();
    expect(await rebuildContinuousPrefix(persisted, workspaceId)).toEqual(prefix);
    expect(await store.read()).toEqual(persisted);
  });

  for (const consumed of [false, true]) {
    it(`step-boundary retry ${consumed ? "retains the consumed view" : "discards a pending swap"}`, async () => {
      const { tracker, manager, swap, run, store } = await setup();
      if (consumed) await run();
      const before = tracker.latestMessages;
      const stream = {
        stepTracker: tracker,
        parts: [{ type: "text", text: "completed" }],
        stepStartIndices: [0],
        currentStepStartIndex: 1,
        partialWritePromise: undefined,
      };
      const reset = Reflect.get(manager, "resetStreamStateForRetry") as (
        id: string,
        info: unknown,
        options: { preserveParts: boolean }
      ) => Promise<void>;
      await reset.call(manager, workspaceId, stream, { preserveParts: true });
      expect(tracker.pendingPrefixSwap).toBeUndefined();
      expect(tracker.consumedPrefixSwap).toBe(consumed ? swap : undefined);
      expect(tracker.latestMessages).toBe(before);
      expect((await store.read()) !== null).toBe(consumed);
    });
  }

  for (const family of ["anthropic", "openai"]) {
    for (const consumed of [false, true]) {
      it(`${family} fallback ${consumed ? "after" : "before"} consumption preserves the correct view and emits only after reset`, async () => {
        const { tracker, manager, run, swap } = await setup();
        if (consumed) await run();
        const controller = new AbortController();
        const nextModel = `${family}:fallback-model`;
        let resetFinished = false;
        const events: string[] = [];
        manager.setEventSink((event) => {
          expect(resetFinished).toBe(true);
          events.push(event.type);
          controller.abort();
        });
        const preparedMessages = structuredClone(originalMessages);
        const stream = {
          model: swap.journal.parentModel,
          metadataModel: swap.journal.parentModel,
          streamResult: {
            usage: Promise.resolve(undefined),
            steps: Promise.resolve([]),
            providerMetadata: Promise.resolve(undefined),
          },
          startTime: Date.now(),
          messageId: "live",
          historySequence: 1,
          parts: [{ type: "text", text: "refused response" }],
          stepStartIndices: [0],
          currentStepStartIndex: 1,
          stepTracker: tracker,
          softInterrupt: { pending: false },
          abortController: controller,
          request: { model, messages: originalMessages },
          toolModelUsages: [],
          cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          modelFallback: {
            requestedModel: swap.journal.parentModel,
            refusedModels: [],
            original: {},
            options: {
              chain: [nextModel],
              prepare: () => {
                expect(tracker.pendingPrefixSwap).toBeUndefined();
                return Promise.resolve({
                  success: true,
                  data: { model, modelString: nextModel, messages: preparedMessages },
                });
              },
            },
          },
        };
        const reset = Reflect.get(manager, "resetStreamStateForRetry") as (
          id: string,
          info: unknown,
          options: unknown
        ) => Promise<void>;
        Reflect.set(
          manager,
          "resetStreamStateForRetry",
          async (...args: Parameters<typeof reset>) => {
            await reset.call(manager, ...args);
            expect(events).toEqual([]);
            resetFinished = true;
          }
        );
        const fallback = Reflect.get(manager, "tryModelFallbackAfterRefusal") as (
          id: string,
          stream: unknown,
          reason: string,
          options: { preserveParts: boolean }
        ) => Promise<{ kind: string }>;
        expect(
          await fallback.call(manager, workspaceId, stream, "content-filter", {
            preserveParts: true,
          })
        ).toEqual({ kind: "swapped" });
        expect(events).toEqual(consumed && family === "openai" ? ["prefix-swap-invalidated"] : []);
        if (consumed && family === "anthropic") {
          expect(JSON.stringify(stream.request.messages)).not.toContain("old output");
          expect(stream.request.messages.slice(0, swap.prefix.length)).toEqual(swap.prefix);
        } else {
          expect(stream.request.messages).toEqual(preparedMessages);
        }
        if (consumed && family === "openai") {
          const blocked = prepareHarness(manager, tracker);
          const result = blocked.run().catch((error: unknown) => error);
          blocked.controller.abort(new Error("stop for durable fold"));
          expect(await result).toBeInstanceOf(Error);
        }
      });
    }
  }

  it("schema validates and self-heals corrupt journal files", async () => {
    const { store, swap } = await setup();
    expect(await store.write(swap.journal, swap.prefix, () => true)).not.toBeNull();
    await writeFile(store.path, JSON.stringify({ version: 9 }));
    expect(await store.read()).toBeNull();
    expect(await store.read()).toBeNull();
  });
});
