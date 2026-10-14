import { describe, expect, it } from "bun:test";
import {
  COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES,
  MIN_FITTED_COMPACTION_SUMMARY_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  fitCompactionSummaryToHistoryRow,
  formatCompactionSummaryTruncationMarker,
  measurePersistedHistoryRowBytes,
} from "./historyRowBudget";

const workspaceId = "row-budget";
const limit = SESSION_HISTORY_MAX_LINE_BYTES - COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function boundary(summary: string, followUpText = "continue"): MuxMessage {
  return createMuxMessage("boundary", "assistant", summary, {
    compacted: "user",
    compactionBoundary: true,
    compactionEpoch: 2,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: { text: followUpText, model: "openai:gpt-4o", agentId: "exec" },
    },
  });
}

function summaryText(message: MuxMessage): string {
  const part = message.parts[0];
  if (part?.type !== "text") throw new Error("expected a text part");
  return part.text;
}

/** The text before the marker must be an exact prefix; the marker must report real byte counts. */
function expectExplicitPrefix(original: string, fittedText: string) {
  const kept = fittedText.slice(0, fittedText.lastIndexOf("\n\n["));
  expect(original.startsWith(kept)).toBe(true);
  expect(fittedText.slice(kept.length)).toBe(
    formatCompactionSummaryTruncationMarker(
      Buffer.byteLength(kept, "utf8"),
      Buffer.byteLength(original, "utf8")
    )
  );
  expect(LONE_SURROGATE.test(fittedText)).toBe(false);
}

describe("fitCompactionSummaryToHistoryRow", () => {
  it("returns an in-budget boundary unchanged", () => {
    const message = boundary("A short summary");
    const fitted = fitCompactionSummaryToHistoryRow(message, workspaceId);
    expect(fitted.message).toBe(message);
    expect(fitted.truncated).toBeUndefined();
    expect(fitted.rowExceedsLimit).toBe(false);
  });

  it.each([
    ["ascii", "s".repeat(SESSION_HISTORY_MAX_LINE_BYTES)],
    // Each control character escapes to six bytes; quotes and backslashes to two.
    ["escape-heavy", '\u0001"\\x'.repeat(SESSION_HISTORY_MAX_LINE_BYTES / 4)],
    // Astral characters are surrogate pairs: a cut must never split one.
    ["astral", "a\u{1F600}".repeat(SESSION_HISTORY_MAX_LINE_BYTES / 4)],
  ])("cuts a runaway %s summary so the row fits, keeping an exact prefix", (_name, summary) => {
    const message = boundary(summary);
    const fitted = fitCompactionSummaryToHistoryRow(message, workspaceId);
    expect(fitted.rowExceedsLimit).toBe(false);
    expect(measurePersistedHistoryRowBytes(fitted.message, workspaceId)).toBeLessThanOrEqual(limit);
    expectExplicitPrefix(summary, summaryText(fitted.message));
    expect(fitted.message.metadata).toBe(message.metadata);
  });

  it("leaves an oversized boundary without exactly one text part untouched", () => {
    const message = boundary("s".repeat(SESSION_HISTORY_MAX_LINE_BYTES), "continue");
    message.parts.push({ type: "text", text: "second part" });
    const fitted = fitCompactionSummaryToHistoryRow(message, workspaceId);
    expect(fitted.message).toBe(message);
    expect(fitted.rowExceedsLimit).toBe(true);
  });

  it("shrinks the summary to the room a large follow-up leaves", () => {
    const followUpText = "f".repeat(limit - MIN_FITTED_COMPACTION_SUMMARY_BYTES - 4096);
    const summary = "s".repeat(256 * 1024);
    const fitted = fitCompactionSummaryToHistoryRow(boundary(summary, followUpText), workspaceId);
    expect(fitted.rowExceedsLimit).toBe(false);
    expect(fitted.truncated?.keptBytes).toBeGreaterThanOrEqual(MIN_FITTED_COMPACTION_SUMMARY_BYTES);
    expectExplicitPrefix(summary, summaryText(fitted.message));
  });

  it("leaves the summary alone when the follow-up alone leaves no useful room", () => {
    const summary = "s".repeat(256 * 1024);
    const message = boundary(summary, "f".repeat(limit));
    const fitted = fitCompactionSummaryToHistoryRow(message, workspaceId);
    expect(fitted.message).toBe(message);
    expect(fitted.rowExceedsLimit).toBe(true);
  });

  it("still caps a runaway summary on its own when the follow-up is too large to fit", () => {
    const summary = "s".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1024);
    const message = boundary(summary, "f".repeat(limit));
    const fitted = fitCompactionSummaryToHistoryRow(message, workspaceId);
    expect(fitted.rowExceedsLimit).toBe(true);
    const text = summaryText(fitted.message);
    expect(Buffer.byteLength(JSON.stringify(text), "utf8") - 2).toBeLessThanOrEqual(limit);
    expectExplicitPrefix(summary, text);
    expect(fitted.message.metadata).toBe(message.metadata);
  });
});
