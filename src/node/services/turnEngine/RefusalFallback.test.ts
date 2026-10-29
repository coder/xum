import { describe, expect, test } from "bun:test";
import { tool, type ModelMessage, type Tool } from "ai";
import { z } from "zod";

import type { ContinuousCompactionJournal } from "@/common/orpc/schemas/continuousCompaction";
import type { ThinkingLevel } from "@/common/types/thinking";
import { createMuxMessage } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";
import type { ContinuousPrefixSwap } from "@/node/services/continuousCompactionJournal";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";

import {
  buildFallbackPrefix,
  buildFallbackPrepareOptions,
  canReuseFallbackPrefix,
  foldThinkingOverrideForFallback,
  resolveNextFallbackModel,
  withModelFallbackRecord,
} from "./RefusalFallback";

const MODEL = "anthropic:claude-sonnet-4-5";

function chainState(refusedModels: string[]) {
  return {
    requestedModel: "anthropic:claude-opus-4-1",
    refusedModels,
    options: {
      chain: ["openai:gpt-5", "google:gemini-2.5-pro"],
      prepare: () => Promise.reject(new Error("not called")),
    },
  };
}

const incompleteToolPart: CompletedMessagePart = {
  type: "dynamic-tool",
  toolCallId: "call-1",
  toolName: "bash",
  state: "input-available",
  input: {},
};
const textPart: CompletedMessagePart = { type: "text", text: "partial" };

describe("withModelFallbackRecord", () => {
  test("keeps other metadata and snapshots the refused models", () => {
    const state = chainState(["anthropic:claude-opus-4-1"]);
    const metadata = withModelFallbackRecord({ historySequence: 3 }, state);
    state.refusedModels.push("openai:gpt-5");
    expect(metadata).toEqual({
      historySequence: 3,
      modelFallback: {
        requestedModel: "anthropic:claude-opus-4-1",
        refusedModels: ["anthropic:claude-opus-4-1"],
      },
    });
  });
});

describe("resolveNextFallbackModel", () => {
  test("picks the chain entry after the refusals so far", () => {
    expect(resolveNextFallbackModel(chainState(["a"]), false, [])).toEqual({
      kind: "next",
      modelString: "openai:gpt-5",
    });
    expect(resolveNextFallbackModel(chainState(["a", "b"]), false, [])).toEqual({
      kind: "next",
      modelString: "google:gemini-2.5-pro",
    });
  });

  test("ends the chain with the refused models once every entry refused", () => {
    expect(resolveNextFallbackModel(chainState(["a", "b", "c"]), true, [textPart])).toEqual({
      kind: "terminal",
      terminalNote: "Model fallback chain exhausted; refused models: a, b, c.",
    });
  });

  test("skips the fallback for an incomplete tool call only when parts are preserved", () => {
    expect(resolveNextFallbackModel(chainState(["a"]), true, [incompleteToolPart])).toMatchObject({
      kind: "terminal",
    });
    expect(resolveNextFallbackModel(chainState(["a"]), true, [textPart])).toMatchObject({
      kind: "next",
    });
    expect(resolveNextFallbackModel(chainState(["a"]), false, [incompleteToolPart])).toMatchObject({
      kind: "next",
    });
  });
});

describe("foldThinkingOverrideForFallback", () => {
  test("returns undefined without a holder", () => {
    expect(foldThinkingOverrideForFallback(undefined)).toBeUndefined();
  });

  test("consumes a pending level and records it as applied", () => {
    const holder: ActiveTurnThinkingOverride = { pending: "high", applied: "low" };
    expect(foldThinkingOverrideForFallback(holder)).toBe("high");
    expect(holder).toEqual({ pending: undefined, applied: "high" });
  });

  test("carries an applied level to the next hop", () => {
    const holder: ActiveTurnThinkingOverride = { applied: "medium", manual: true };
    expect(foldThinkingOverrideForFallback(holder)).toBe("medium");
    expect(holder).toEqual({ applied: "medium", manual: true });
  });

  test("leaves a holder without a level unchanged", () => {
    const holder: ActiveTurnThinkingOverride = { manual: true };
    expect(foldThinkingOverrideForFallback(holder)).toBeUndefined();
    expect(holder).toEqual({ manual: true });
  });
});

describe("buildFallbackPrepareOptions", () => {
  const message = createMuxMessage("partial", "assistant", "partial");

  test("returns undefined when there is nothing to pass", () => {
    expect(buildFallbackPrepareOptions(undefined, undefined)).toBeUndefined();
  });

  test("passes the continuation and the override independently", () => {
    expect(buildFallbackPrepareOptions(message, undefined)).toEqual({
      continuation: { assistantMessage: message },
    });
    expect(buildFallbackPrepareOptions(undefined, "low")).toEqual({ thinkingLevelOverride: "low" });
    expect(buildFallbackPrepareOptions(message, "low")).toEqual({
      continuation: { assistantMessage: message },
      thinkingLevelOverride: "low",
    });
  });
});

const boundary = createMuxMessage("summary", "assistant", "summary", { compactionBoundary: true });
function journalFixture(
  overrides: {
    partIndex?: number;
    effectiveThinkingLevel?: ThinkingLevel;
    deferLoadingToolNames?: string[];
  } = {}
): ContinuousCompactionJournal {
  return {
    version: 1,
    boundary,
    staticCopies: [],
    liveTailCopySpec: {
      sourceMessageId: "live",
      sourceHistorySequence: 1,
      copyId: "copy",
      partIndex: overrides.partIndex ?? 0,
      metadataTemplate: {},
    },
    prefixSourceRows: [boundary],
    systemPrefix: [],
    cacheEnabled: true,
    preparation: {
      modelString: MODEL,
      providerForMessages: "anthropic",
      effectiveThinkingLevel: overrides.effectiveThinkingLevel ?? "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
      ...(overrides.deferLoadingToolNames && {
        deferLoadingToolNames: overrides.deferLoadingToolNames,
      }),
    },
    providerFamily: "anthropic",
    parentModel: MODEL,
    summaryModel: MODEL,
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

function swapFixture(
  journal: ContinuousCompactionJournal,
  prefix: ModelMessage[] = []
): ContinuousPrefixSwap {
  return { journal, prefix, firstTailToolCallId: "keep" };
}

function testTool(deferLoading: boolean): Tool {
  return tool({
    inputSchema: z.object({}),
    ...(deferLoading && { providerOptions: { anthropic: { deferLoading: true } } }),
  });
}

describe("canReuseFallbackPrefix", () => {
  test("accepts a fallback that matches the journal's family, cut and thinking", () => {
    const swap = swapFixture(journalFixture());
    expect(canReuseFallbackPrefix("anthropic", swap, undefined, { tools: undefined })).toBe(true);
  });

  test("rejects another provider family, an internal cut or another thinking level", () => {
    const request = { tools: undefined };
    expect(canReuseFallbackPrefix("openai", swapFixture(journalFixture()), "off", request)).toBe(
      false
    );
    expect(
      canReuseFallbackPrefix(
        "anthropic",
        swapFixture(journalFixture({ partIndex: 2 })),
        "off",
        request
      )
    ).toBe(false);
    expect(
      canReuseFallbackPrefix("anthropic", swapFixture(journalFixture()), "high", request)
    ).toBe(false);
    expect(
      canReuseFallbackPrefix(
        "anthropic",
        swapFixture(journalFixture({ effectiveThinkingLevel: "high" })),
        "high",
        request
      )
    ).toBe(true);
  });

  test("compares the deferred tool names as sets", () => {
    const swap = swapFixture(journalFixture({ deferLoadingToolNames: ["b", "a"] }));
    const tools = { a: testTool(true), b: testTool(true), c: testTool(false) };
    expect(canReuseFallbackPrefix("anthropic", swap, undefined, { tools })).toBe(true);
    expect(
      canReuseFallbackPrefix("anthropic", swap, undefined, { tools: { a: testTool(true) } })
    ).toBe(false);
  });
});

describe("buildFallbackPrefix", () => {
  const cachedUser: ModelMessage = {
    role: "user",
    content: "compacted prefix",
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
  const swap = swapFixture(journalFixture(), [
    { role: "system", content: "parent system" },
    cachedUser,
  ]);
  const messages: ModelMessage[] = [
    { role: "system", content: "fallback system" },
    { role: "user", content: "live tail" },
  ];

  test("uses the fallback's system messages and strips the parent's cache marks", () => {
    expect(buildFallbackPrefix(swap, { messages, cacheEnabled: false })).toEqual([
      { role: "system", content: "fallback system" },
      { role: "user", content: "compacted prefix", providerOptions: { anthropic: {} } },
    ]);
  });

  test("adds the fallback's own cache breakpoint when caching is on", () => {
    const prefix = buildFallbackPrefix(swap, { messages, cacheEnabled: true });
    expect(prefix).toHaveLength(2);
    expect(prefix[0]).toEqual({ role: "system", content: "fallback system" });
    expect(JSON.stringify(prefix[1])).toContain("cacheControl");
  });
});
