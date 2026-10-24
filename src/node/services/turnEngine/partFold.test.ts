import { describe, expect, test } from "bun:test";

import type { CompletedMessagePart } from "@/common/types/stream";
import type { ReasoningProviderMetadata } from "@/node/utils/messages/reasoningProviderOptions";

import { partFold, type FoldablePart, type FoldIntent, type FoldStep } from "./partFold";

const WORKSPACE_ID = "ws-1";
const MESSAGE_ID = "msg-1";

/**
 * In-memory stand-in for StreamManager.applyStep: it applies only the intents
 * that change the fold's view (parts, reasoning block, timestamp cursor), so a
 * sequence of parts can be replayed with no disk and no provider.
 */
interface ReplayState {
  parts: CompletedMessagePart[];
  block: { lastPart?: CompletedMessagePart } | undefined;
  lastPartTimestamp: number;
}

function applyToState(state: ReplayState, step: FoldStep): void {
  state.lastPartTimestamp = step.lastPartTimestamp;
  for (const intent of step.intents) {
    if (intent._tag === "OpenReasoningBlock") {
      state.block = {};
    } else if (intent._tag === "Append") {
      state.parts.push(intent.part);
      if (intent.trackInBlock && state.block) state.block.lastPart = intent.part;
    } else if (intent._tag === "UpdateReasoningPart") {
      const target = state.parts[intent.index];
      if (target?.type !== "reasoning") throw new Error("update of a non-reasoning part");
      if (intent.signature) target.signature = intent.signature;
      target.providerOptions = intent.providerOptions;
      if (intent.trackInBlock && state.block) state.block.lastPart = target;
    }
  }
}

/** Folds each [part, now] in order; returns every step and the final state. */
function replay(
  sequence: Array<[FoldablePart, number]>,
  initial: Partial<ReplayState> = {}
): { steps: FoldStep[]; state: ReplayState } {
  const state: ReplayState = {
    parts: [],
    block: undefined,
    lastPartTimestamp: 0,
    ...initial,
  };
  const steps = sequence.map(([part, now]) => {
    const before = JSON.stringify(state);
    const step = partFold(
      {
        workspaceId: WORKSPACE_ID,
        messageId: MESSAGE_ID,
        parts: state.parts,
        currentReasoningBlock: state.block,
        lastPartTimestamp: state.lastPartTimestamp,
      },
      part,
      now
    );
    // partFold must not mutate what it reads.
    expect(JSON.stringify(state)).toBe(before);
    applyToState(state, step);
    return step;
  });
  return { steps, state };
}

const tags = (step: FoldStep) => step.intents.map((intent: FoldIntent) => intent._tag);

const reasoningStart = (providerMetadata?: ReasoningProviderMetadata): FoldablePart => ({
  type: "reasoning-start",
  providerMetadata,
});
const reasoningDelta = (
  text: string,
  providerMetadata?: ReasoningProviderMetadata
): FoldablePart => ({ type: "reasoning-delta", text, providerMetadata });
const reasoningEnd = (providerMetadata?: ReasoningProviderMetadata): FoldablePart => ({
  type: "reasoning-end",
  providerMetadata,
});

describe("partFold", () => {
  test("start-step starts a step and stamps nothing", () => {
    const { steps } = replay([[{ type: "start-step" }, 500]], { lastPartTimestamp: 7 });
    expect(steps).toEqual([{ intents: [{ _tag: "StartStep" }], lastPartTimestamp: 7 }]);
  });

  test("text deltas append one part each, read from text, delta or textDelta", () => {
    const { steps, state } = replay([
      [{ type: "text-delta", text: "Hel" }, 100],
      [{ type: "text-delta", delta: "lo" }, 100],
      [{ type: "text-delta", textDelta: " wor" }, 120],
      // A non-string `text` falls through to the next key.
      [{ type: "text-delta", text: 5, delta: "ld" }, 130],
    ]);
    expect(steps.map(tags)).toEqual([["Append"], ["Append"], ["Append"], ["Append"]]);
    expect(
      steps.every((step) => step.intents.every((i) => i._tag !== "Append" || !i.trackInBlock))
    ).toBe(true);
    expect(state.parts).toEqual([
      { type: "text", text: "Hel", timestamp: 100 },
      { type: "text", text: "lo", timestamp: 101 },
      { type: "text", text: " wor", timestamp: 120 },
      { type: "text", text: "ld", timestamp: 130 },
    ]);
  });

  test("a text delta without string text is dropped and reported for the debug log", () => {
    const { steps, state } = replay(
      [
        [{ type: "text-delta", text: 42 }, 100],
        [{ type: "text-delta", text: "" }, 100],
        // No payload key at all: dropped without a report.
        [{ type: "text-delta", id: "t1" }, 100],
      ],
      { lastPartTimestamp: 9 }
    );
    expect(steps).toEqual([
      {
        intents: [],
        lastPartTimestamp: 9,
        ignoredTextDelta: {
          textType: "number",
          deltaType: "undefined",
          textDeltaType: "undefined",
        },
      },
      {
        intents: [],
        lastPartTimestamp: 9,
        ignoredTextDelta: {
          textType: "string",
          deltaType: "undefined",
          textDeltaType: "undefined",
        },
      },
      { intents: [], lastPartTimestamp: 9 },
    ]);
    expect(state.parts).toEqual([]);
  });

  test("redacted_thinking at reasoning-start is its own part, never merged", () => {
    const redacted = { anthropic: { redactedData: "opaque" } };
    const { steps, state } = replay([
      [reasoningStart(), 10],
      [reasoningDelta("thinking"), 11],
      [reasoningEnd(), 12],
      [reasoningStart(redacted), 13],
    ]);
    expect(tags(steps[3])).toEqual(["OpenReasoningBlock", "Append"]);
    expect(state.parts).toEqual([
      { type: "reasoning", text: "thinking", timestamp: 11, signature: undefined },
      { type: "reasoning", text: "", timestamp: 13, providerOptions: redacted },
    ]);
    expect(state.block?.lastPart).toBe(state.parts[1]);
  });

  test("start options merge into a trailing reasoning part instead of opening a new one", () => {
    const { steps, state } = replay([
      [reasoningDelta("a", { openai: { itemId: "rs_1" } }), 10],
      [reasoningStart({ openai: { reasoningEncryptedContent: "enc" } }), 11],
    ]);
    expect(steps[1]).toEqual({
      intents: [
        { _tag: "OpenReasoningBlock" },
        {
          _tag: "UpdateReasoningPart",
          index: 0,
          signature: undefined,
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
          trackInBlock: true,
        },
        { _tag: "SchedulePartialWrite" },
      ],
      lastPartTimestamp: 10,
    });
    expect(state.parts).toHaveLength(1);
    expect(state.block?.lastPart).toBe(state.parts[0]);
  });

  test("start options open an empty reasoning part when the last part is not reasoning", () => {
    const options = { openai: { itemId: "rs_1" } };
    const { steps, state } = replay([
      [{ type: "text-delta", text: "answer" }, 10],
      [reasoningStart(options), 10],
      // Without options the block opens with no part.
      [reasoningStart(), 10],
    ]);
    expect(steps.slice(1).map(tags)).toEqual([
      ["OpenReasoningBlock", "Append"],
      ["OpenReasoningBlock"],
    ]);
    expect(state.parts[1]).toEqual({
      type: "reasoning",
      text: "",
      timestamp: 11,
      providerOptions: options,
    });
    expect(state.block).toEqual({});
  });

  test("a signature-only delta attaches to the block's last part and emits the signature", () => {
    const { steps, state } = replay([
      [reasoningStart(), 10],
      [reasoningDelta("thinking"), 10],
      [reasoningDelta("", { anthropic: { signature: "sig" } }), 10],
    ]);
    expect(steps[2]).toEqual({
      intents: [
        {
          _tag: "UpdateReasoningPart",
          index: 0,
          signature: "sig",
          providerOptions: { anthropic: { signature: "sig" } },
          trackInBlock: false,
        },
        {
          _tag: "Emit",
          event: {
            type: "reasoning-delta",
            workspaceId: WORKSPACE_ID,
            messageId: MESSAGE_ID,
            delta: "",
            tokens: 0,
            timestamp: 11,
            signature: "sig",
          },
        },
        { _tag: "SchedulePartialWrite" },
      ],
      lastPartTimestamp: 11,
    });
    expect(state.parts).toEqual([
      {
        type: "reasoning",
        text: "thinking",
        timestamp: 10,
        signature: "sig",
        providerOptions: { anthropic: { signature: "sig" } },
      },
    ]);
  });

  test("a signature for a block with no part yet opens its own part and keeps the earlier signature", () => {
    const { steps, state } = replay([
      [reasoningStart(), 10],
      [reasoningDelta("first"), 10],
      [reasoningDelta("", { anthropic: { signature: "sig1" } }), 10],
      [reasoningEnd(), 10],
      // Empty thinking block: only a signature arrives.
      [reasoningStart(), 10],
      [reasoningDelta("", { anthropic: { signature: "sig2" } }), 10],
    ]);
    expect(tags(steps[5])).toEqual(["Append"]);
    expect(state.parts.map((part) => (part.type === "reasoning" ? part.signature : null))).toEqual([
      "sig1",
      "sig2",
    ]);
    expect(state.parts[1]).toEqual({
      type: "reasoning",
      text: "",
      timestamp: 12,
      signature: "sig2",
      providerOptions: { anthropic: { signature: "sig2" } },
    });
    expect(state.block?.lastPart).toBe(state.parts[1]);
  });

  test("without a reasoning-start, a signature attaches to the trailing reasoning part", () => {
    const { steps, state } = replay([
      [reasoningDelta("thinking"), 10],
      [reasoningDelta("", { anthropic: { signature: "sig" } }), 10],
    ]);
    expect(tags(steps[1])).toEqual(["UpdateReasoningPart", "Emit", "SchedulePartialWrite"]);
    expect(state.parts).toHaveLength(1);
  });

  test("an itemId-only delta updates the trailing reasoning part without a signature event", () => {
    const { steps, state } = replay([
      [reasoningDelta("thinking"), 10],
      [reasoningDelta("", { openai: { itemId: "rs_1" } }), 10],
    ]);
    expect(steps[1]).toEqual({
      intents: [
        {
          _tag: "UpdateReasoningPart",
          index: 0,
          signature: undefined,
          providerOptions: { openai: { itemId: "rs_1" } },
          trackInBlock: false,
        },
        { _tag: "SchedulePartialWrite" },
      ],
      lastPartTimestamp: 10,
    });
    expect(state.parts).toHaveLength(1);
  });

  test("metadata-only deltas without a signature are dropped when no reasoning part trails", () => {
    const { steps, state } = replay([
      [{ type: "text-delta", text: "answer" }, 10],
      [reasoningDelta("", { openai: { itemId: "rs_1" } }), 10],
    ]);
    expect(steps[1]).toEqual({ intents: [], lastPartTimestamp: 10 });
    expect(state.parts).toHaveLength(1);
  });

  test("reasoning-end attaches its options to the first part of the trailing reasoning run", () => {
    const endOptions = { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } };
    const { steps, state } = replay([
      [reasoningDelta("old"), 10],
      [{ type: "text-delta", text: "answer" }, 10],
      [reasoningDelta("a"), 10],
      [reasoningDelta("b"), 10],
      [reasoningEnd(endOptions), 10],
    ]);
    expect(steps[4]).toEqual({
      intents: [
        {
          _tag: "UpdateReasoningPart",
          index: 2,
          signature: undefined,
          providerOptions: endOptions,
          trackInBlock: false,
        },
        { _tag: "SchedulePartialWrite" },
        {
          _tag: "Emit",
          event: { type: "reasoning-end", workspaceId: WORKSPACE_ID, messageId: MESSAGE_ID },
        },
        { _tag: "CheckSoftCancel" },
      ],
      lastPartTimestamp: 13,
    });
    expect(
      state.parts.map((part) => (part.type === "reasoning" ? part.providerOptions : null))
    ).toEqual([undefined, null, endOptions, undefined]);
  });

  test("reasoning-end with no trailing reasoning only ends the block", () => {
    const { steps } = replay([
      [{ type: "text-delta", text: "answer" }, 10],
      [reasoningEnd({ openai: { itemId: "rs_1" } }), 10],
    ]);
    expect(tags(steps[1])).toEqual(["Emit", "CheckSoftCancel"]);
  });

  test("part timestamps stay strictly increasing when the clock stalls or goes back", () => {
    const { steps, state } = replay(
      [
        [{ type: "text-delta", text: "a" }, 50],
        [reasoningStart({ openai: { itemId: "rs_1" } }), 50],
        [reasoningDelta("b"), 40],
        [reasoningDelta("", { anthropic: { signature: "sig" } }), 50],
        [{ type: "text-delta", text: "c" }, 50],
      ],
      { lastPartTimestamp: 50 }
    );
    const emitted = steps[3].intents.find((intent) => intent._tag === "Emit");
    expect(
      emitted?._tag === "Emit" && emitted.event.type === "reasoning-delta"
        ? emitted.event.timestamp
        : null
    ).toBe(54);
    expect(state.parts.map((part) => part.timestamp)).toEqual([51, 52, 53, 55]);
    expect(state.lastPartTimestamp).toBe(55);
  });
});
