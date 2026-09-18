import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { buildEditingStateFromDisplayed } from "@/browser/utils/chatEditing";
import {
  hasInterruptedStream,
  isEligibleForAutoRetry,
  isPreTokenInterruptedUserTurn,
} from "@/common/utils/messages/retryEligibility";
import { describe, expect, test } from "bun:test";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { createMuxMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

// Enable the "show synthetic messages" debug flag for the duration of fn.
function withDebugLlmRequestEnabled<T>(fn: () => T): T {
  const globalWithWindow = globalThis as unknown as { window?: { api?: WindowApi } };
  const previousWindow = globalWithWindow.window;
  globalWithWindow.window = {
    ...previousWindow,
    api: { ...(previousWindow?.api ?? { platform: process.platform, versions: {} }) },
  };
  globalWithWindow.window.api!.debugLlmRequest = true;
  try {
    return fn();
  } finally {
    if (previousWindow) globalWithWindow.window = previousWindow;
    else delete globalWithWindow.window;
  }
}

describe("token-budget replay", () => {
  test("retains old windows and machine warnings while hiding the provider lead-in", () => {
    const messages = [
      createMuxMessage("user", "user", "Investigate the failing test", { historySequence: 1 }),
      createMuxMessage("warning", "user", "Write the next steps to workspace notes.", {
        historySequence: 2,
        synthetic: true,
        uiVisible: true,
        muxMetadata: {
          type: "context-budget-warning",
          contextTokens: 800,
          maxTokens: 1000,
          budgetTokens: 991,
          handoffTokens: 900,
        },
      }),
      createMuxMessage(
        "handoff",
        "user",
        "Finish the current unit, checkpoint, then new_context.",
        {
          historySequence: 3,
          synthetic: true,
          uiVisible: true,
          muxMetadata: {
            type: "context-budget-warning",
            contextTokens: 900,
            maxTokens: 1000,
            budgetTokens: 991,
            handoff: true,
            handoffTokens: 900,
          },
        }
      ),
      // Legacy final-flush row: no longer produced, but persisted histories still replay it.
      createMuxMessage("final-flush", "user", "Write workspace notes now; the window is ending.", {
        historySequence: 4,
        synthetic: true,
        uiVisible: true,
        muxMetadata: {
          type: "context-budget-warning",
          contextTokens: 850,
          maxTokens: 1000,
          budgetTokens: 750,
          final: true,
        },
      }),
      createMuxMessage("reset", "assistant", "", {
        historySequence: 5,
        contextBoundaryKind: "reset",
        muxMetadata: {
          type: "context-window-rollover",
          rolloverId: "reset",
          reason: "on-send",
          previousWindowId: "initial",
          flushOpportunity: true,
          contextTokens: 900,
          maxTokens: 1000,
        },
      }),
      createMuxMessage("lead-in", "user", "Model-only retrieval instructions", {
        historySequence: 6,
        synthetic: true,
        muxMetadata: { type: "context-window-lead-in", rolloverId: "reset" },
      }),
      createMuxMessage("next", "user", "Continue with the fix", { historySequence: 7 }),
      createMuxMessage("manual-reset", "assistant", "", {
        historySequence: 8,
        contextBoundaryKind: "reset",
      }),
      createMuxMessage("budget-continue", "user", "Continue", {
        historySequence: 9,
        synthetic: true,
        uiVisible: false,
        muxMetadata: { type: "normal", contextBudgetContinuation: true },
      }),
    ];
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages(
      messages.map((message) => MuxMessageSchema.parse(message)),
      false
    );
    const displayed = aggregator.getDisplayedMessages();
    expect(displayed.map((message) => message.type)).toEqual([
      "user",
      "user",
      "user",
      "user",
      "compaction-boundary",
      "user",
      "compaction-boundary",
    ]);
    expect(displayed[1]).toMatchObject({
      contextBudgetWarning: { contextTokens: 800, maxTokens: 1000, final: false, handoff: false },
    });
    expect(displayed[2]).toMatchObject({
      contextBudgetWarning: { contextTokens: 900, maxTokens: 1000, final: false, handoff: true },
    });
    expect(displayed[3]).toMatchObject({
      contextBudgetWarning: { contextTokens: 850, maxTokens: 1000, final: true, handoff: false },
    });
    expect(displayed[4]).toMatchObject({ boundaryKind: "reset", contextWindowRollover: true });
    expect(displayed[6]).toMatchObject({ boundaryKind: "reset", contextWindowRollover: undefined });
    expect(aggregator.getActiveStreamMessageId()).toBeUndefined();
  });

  test("legacy warnings without a rollover budget still collapse on replay", () => {
    const warning = MuxMessageSchema.parse({
      id: "legacy-warning",
      role: "user",
      parts: [{ type: "text", text: "Save context notes." }],
      metadata: {
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "context-budget-warning", contextTokens: 800, maxTokens: 1000 },
      },
    });
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages([warning], false);
    expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
      type: "user",
      contextBudgetWarning: { contextTokens: 800, maxTokens: 1000 },
    });
  });

  test.each([false, true])(
    "rejected replay tails are visible terminal barriers (capsule=%s)",
    (capsule) => {
      const aggregator = new StreamingMessageAggregator(CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("completed-user", "user", "Already handled", { historySequence: 1 }),
          createMuxMessage("completed-answer", "assistant", "Completed response", {
            historySequence: 2,
          }),
          createMuxMessage("rejected-user", "user", "Rejected request", {
            historySequence: 3,
            contextBudgetRejected: true,
          }),
        ].map((message) =>
          MuxMessageSchema.parse(
            capsule && message.metadata?.contextBudgetRejected
              ? createContextBudgetRejectedMessage(message)
              : message
          )
        ),
        false
      );
      const displayed = aggregator.getDisplayedMessages();
      const tail = displayed.at(-1);
      expect(tail).toMatchObject({ type: "user", content: "Rejected request" });
      if (tail?.type !== "user") throw new Error("Expected visible rejected user input");
      expect(buildEditingStateFromDisplayed(tail)).toMatchObject({
        id: "rejected-user",
        pending: { content: "Rejected request" },
      });
      if (capsule)
        expect(aggregator.getAllMessages().at(-1)).toMatchObject({ role: "assistant", parts: [] });
      expect(hasInterruptedStream(displayed)).toBe(false);
      expect(isEligibleForAutoRetry(displayed)).toBe(false);
      expect(isPreTokenInterruptedUserTurn(tail, { reason: "startup", at: 1 })).toBe(false);
      aggregator.loadHistoricalMessages(
        [
          MuxMessageSchema.parse(
            createMuxMessage("next", "user", "New request", { historySequence: 4 })
          ),
        ],
        false
      );
      expect(hasInterruptedStream(aggregator.getDisplayedMessages())).toBe(true);
    }
  );

  test.each(["live", "append"])("capsules replace richer original rows on %s updates", (mode) => {
    const original = createMuxMessage(
      "rejected",
      "user",
      "Editable input",
      { historySequence: 1 },
      [
        {
          type: "file",
          url: "data:image/png;base64,abc",
          mediaType: "image/png",
          filename: "image.png",
        },
      ]
    );
    const hidden = createMuxMessage("snapshot", "user", "Model-only file contents", {
      historySequence: 0,
      synthetic: true,
      fileAtMentionSnapshot: ["@file.txt"],
    });
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages([hidden, original], false);
    expect(aggregator.getDisplayedMessages()).toHaveLength(1);
    const capsules = [hidden, original].map(createContextBudgetRejectedMessage);
    if (mode === "live") capsules.forEach((capsule) => aggregator.addMessage(capsule));
    else aggregator.loadHistoricalMessages(capsules, false, { mode: "append" });
    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(1);
    const user = displayed[0];
    if (user.type !== "user") throw new Error("Expected rejected input to remain editable");
    expect(buildEditingStateFromDisplayed(user)).toMatchObject({
      id: original.id,
      pending: { content: "Editable input", fileParts: [{ filename: "image.png" }] },
    });
    expect(hasInterruptedStream(displayed)).toBe(false);
    expect(aggregator.getAllMessages().every((message) => message.parts.length === 0)).toBe(true);
    // An older duplicate cannot undo the authoritative quarantine.
    aggregator.addMessage(original);
    expect(hasInterruptedStream(aggregator.getDisplayedMessages())).toBe(false);
    expect(aggregator.getAllMessages().at(-1)?.parts).toEqual([]);
  });

  test.each([false, true])(
    "final flush turn rows stay out of the transcript (debug=%s)",
    (debug) => {
      const flushTurn = {
        type: "normal",
        contextBudgetContinuation: true,
        contextBudgetFlush: true,
      } as const;
      const messages = [
        createMuxMessage("user", "user", "Investigate the failing test", { historySequence: 1 }),
        createMuxMessage("answer", "assistant", "Looking into it.", { historySequence: 2 }),
        createMuxMessage("flush-trigger", "user", "Flush context notes now.", {
          historySequence: 3,
          synthetic: true,
          uiVisible: false,
          muxMetadata: flushTurn,
        }),
        // A crash-recovered partial and a settled flush answer both carry the turn flag.
        createMuxMessage("flush-answer", "assistant", "Wrote notes; window can close.", {
          historySequence: 4,
          partial: true,
          muxMetadata: flushTurn,
        }),
        createMuxMessage("continue", "user", "Continue", {
          historySequence: 5,
          synthetic: true,
          uiVisible: false,
          muxMetadata: { type: "normal", contextBudgetContinuation: true },
        }),
        createMuxMessage("next-answer", "assistant", "Back to the fix.", {
          historySequence: 6,
          muxMetadata: { type: "normal", contextBudgetContinuation: true },
        }),
      ].map((message) => MuxMessageSchema.parse(message));
      const aggregator = new StreamingMessageAggregator(CREATED_AT);
      aggregator.loadHistoricalMessages(messages, false);
      const displayedIds = () =>
        aggregator
          .getDisplayedMessages()
          .map((row) => ("historyId" in row ? row.historyId : row.id));
      if (debug) {
        // Debug mode keeps showing every machine row, including the flush turn.
        expect(withDebugLlmRequestEnabled(displayedIds)).toEqual(
          messages.map((message) => message.id)
        );
        return;
      }
      expect(displayedIds()).toEqual(["user", "answer", "next-answer"]);
    }
  );

  test.each([false, true])(
    "does not collapse human or malformed warning rows (synthetic=%s)",
    (synthetic) => {
      const message = createMuxMessage("warning", "user", "Visible input", {
        historySequence: 1,
        synthetic,
        uiVisible: true,
        muxMetadata: {
          type: "context-budget-warning",
          contextTokens: synthetic ? -1 : 800,
          maxTokens: 1000,
          budgetTokens: 750,
        },
      });
      const aggregator = new StreamingMessageAggregator(CREATED_AT);
      aggregator.loadHistoricalMessages([MuxMessageSchema.parse(message)], false);
      expect(aggregator.getDisplayedMessages()[0]).toMatchObject({
        type: "user",
        content: "Visible input",
        contextBudgetWarning: undefined,
      });
    }
  );
});
