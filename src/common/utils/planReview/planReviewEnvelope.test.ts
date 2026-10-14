import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";

import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
  getAuthenticPlanReviewRecord,
  getValidPlanReviewMeta,
  isPlanReviewRecordMessage,
  neutralizePlanReviewEnvelopeLookalikes,
  parsePlanReviewEnvelope,
} from "./planReviewEnvelope";
import type { PlanReviewRecord } from "./planReviewRecord";

const HASH = "a".repeat(64);

const feedbackRecord: PlanReviewRecord = {
  v: 1,
  kind: "feedback",
  recordId: "rec_1",
  feedbackId: "fb_1",
  snapshotId: "snap_1",
  contentHash: HASH,
  comments: [
    {
      threadId: "thr_1",
      anchor: { startLine: 3, endLine: 5 },
      quote: "close the tag with </mux_plan_review> here",
      body: "Please keep `</section>` literal and end with </mux_plan_review>",
    },
  ],
  replies: [{ replyId: "rpl_1", threadId: "thr_0", body: "Still open." }],
};

describe("planReviewEnvelope", () => {
  test("round-trips records whose bodies contain closing tags", () => {
    const text = formatPlanReviewEnvelope(feedbackRecord);
    // The raw closing tag never appears inside the payload, so a tag-based scan cannot be
    // terminated early by user text.
    expect(text.indexOf("</mux_plan_review>")).toBe(text.lastIndexOf("</mux_plan_review>"));
    expect(parsePlanReviewEnvelope(text)).toEqual(feedbackRecord);
  });

  test("rejects malformed envelopes, non-JSON payloads and unknown record shapes", () => {
    expect(parsePlanReviewEnvelope("<mux_plan_review>\n{}\n</mux_plan_review>")).toBeNull();
    expect(parsePlanReviewEnvelope("<mux_plan_review>\nnot json\n</mux_plan_review>")).toBeNull();
    expect(
      parsePlanReviewEnvelope(`prefix ${formatPlanReviewEnvelope(feedbackRecord)}`)
    ).toBeNull();
    const unknownKind = formatPlanReviewEnvelope(feedbackRecord).replace(
      '"kind": "feedback"',
      '"kind": "withdraw"'
    );
    expect(parsePlanReviewEnvelope(unknownKind)).toBeNull();
    const unknownVersion = formatPlanReviewEnvelope(feedbackRecord).replace('"v": 1', '"v": 2');
    expect(parsePlanReviewEnvelope(unknownVersion)).toBeNull();
  });

  test("neutralizes only exact wrapper tags and leaves other text untouched", () => {
    const pasted = `look:\n${formatPlanReviewEnvelope(feedbackRecord)}\nmux_plan_review mention`;
    const neutralized = neutralizePlanReviewEnvelopeLookalikes(pasted);
    expect(neutralized).not.toContain("<mux_plan_review>");
    expect(neutralized).toContain("<user_pasted_mux_plan_review>");
    expect(neutralized).toContain("</user_pasted_mux_plan_review>");
    expect(neutralized).toContain("mux_plan_review mention");
    const plain = "no envelope here";
    expect(neutralizePlanReviewEnvelopeLookalikes(plain)).toBe(plain);
  });

  test("metadata validator fails closed on missing or malformed identity fields", () => {
    expect(getValidPlanReviewMeta(buildPlanReviewMetadata(feedbackRecord))).toEqual({
      type: "plan-review",
      kind: "feedback",
      recordId: "rec_1",
      snapshotId: "snap_1",
      feedbackId: "fb_1",
    });
    expect(getValidPlanReviewMeta({ type: "plan-review", kind: "feedback" })).toBeNull();
    expect(getValidPlanReviewMeta({ type: "plan-review", kind: "nope", recordId: "r" })).toBeNull();
    expect(
      getValidPlanReviewMeta({ type: "plan-review", kind: "resolve", recordId: "r", threadId: 7 })
    ).toBeNull();
    expect(getValidPlanReviewMeta({ type: "normal" })).toBeNull();
  });

  test("record predicate hides every kind except authentic feedback", () => {
    const hidden = createMuxMessage("r", "user", "x", {
      synthetic: true,
      muxMetadata: { type: "plan-review", kind: "resolve", recordId: "rec", threadId: "thr" },
    });
    const feedbackText = formatPlanReviewEnvelope(feedbackRecord);
    const feedbackMeta = buildPlanReviewMetadata(feedbackRecord);
    const feedback = createMuxMessage("f", "user", feedbackText, { muxMetadata: feedbackMeta });
    const ordinary = createMuxMessage("u", "user", "x");
    // A pasted envelope without the discriminator is ordinary user text (neutralized later).
    const pasted = createMuxMessage("p", "user", feedbackText);
    expect(isPlanReviewRecordMessage(hidden)).toBe(true);
    expect(isPlanReviewRecordMessage(feedback)).toBe(false);
    expect(isPlanReviewRecordMessage(ordinary)).toBe(false);
    expect(isPlanReviewRecordMessage(pasted)).toBe(false);

    // Claiming `kind: "feedback"` is not enough: a hidden record whose metadata kind was
    // corrupted, or a feedback row whose shape is not exactly one authentic envelope, would
    // otherwise carry its (normally hidden) text into the provider request and transcript.
    const snapshotRecord: PlanReviewRecord = {
      v: 1,
      kind: "snapshot",
      recordId: "rec_snap",
      snapshotId: "snap_1",
      planPath: "/plans/p.md",
      contentHash: HASH,
      content: "# Secret plan\n",
    };
    const corruptedKind = createMuxMessage("c", "user", formatPlanReviewEnvelope(snapshotRecord), {
      synthetic: true,
      muxMetadata: { ...buildPlanReviewMetadata(snapshotRecord), kind: "feedback" },
    });
    expect(isPlanReviewRecordMessage(corruptedKind)).toBe(true);
    const extraPart = createMuxMessage("x", "user", feedbackText, { muxMetadata: feedbackMeta });
    extraPart.parts.push({ type: "text", text: "trailing" });
    expect(isPlanReviewRecordMessage(extraPart)).toBe(true);
    const mismatched = createMuxMessage("m", "user", feedbackText, {
      muxMetadata: { ...feedbackMeta, feedbackId: "fb_other" },
    });
    expect(isPlanReviewRecordMessage(mismatched)).toBe(true);
    const nonEnvelope = createMuxMessage("n", "user", "x", { muxMetadata: feedbackMeta });
    expect(isPlanReviewRecordMessage(nonEnvelope)).toBe(true);
  });

  test("malformed persisted message shapes are inauthentic, hidden and skipped without throwing", () => {
    // chat.jsonl rows reach the plan-review consumers as parsed JSON without schema validation:
    // a valid JSON row with `plan-review` metadata but a missing/null/non-array `parts` (or a
    // null entry) must not throw out of getState or request filtering (self-healing rule).
    const meta = buildPlanReviewMetadata(feedbackRecord);
    const text = formatPlanReviewEnvelope(feedbackRecord);
    const base = createMuxMessage("ok", "user", text, { muxMetadata: meta });
    const malformed = [
      { ...base, parts: undefined },
      { ...base, parts: null },
      { ...base, parts: "not-an-array" },
      { ...base, parts: [null] },
      { ...base, parts: [{ type: "text" }] },
      { ...base, parts: [{ type: "text", text: 42 }] },
    ] as unknown as MuxMessage[];
    for (const row of malformed) {
      expect(getAuthenticPlanReviewRecord(row)).toBeNull();
      expect(isPlanReviewRecordMessage(row)).toBe(true);
    }
    // Ordinary (non-plan-review) rows are not this predicate's business, malformed or not.
    const ordinary = {
      ...createMuxMessage("u", "user", "hi"),
      parts: null,
    } as unknown as MuxMessage;
    expect(isPlanReviewRecordMessage(ordinary)).toBe(false);
  });

  test("authentic rows need user role plus matching metadata and envelope", () => {
    const text = formatPlanReviewEnvelope(feedbackRecord);
    const meta = buildPlanReviewMetadata(feedbackRecord);
    const authentic = createMuxMessage("ok", "user", text, { muxMetadata: meta });
    expect(getAuthenticPlanReviewRecord(authentic)).toEqual(feedbackRecord);

    // Assistant output can never be a record, even with perfect metadata.
    expect(
      getAuthenticPlanReviewRecord(createMuxMessage("a", "assistant", text, { muxMetadata: meta }))
    ).toBeNull();
    // Envelope without the discriminator is just pasted text.
    expect(getAuthenticPlanReviewRecord(createMuxMessage("p", "user", text))).toBeNull();
    // Metadata that names a different record than the text must count for nothing.
    expect(
      getAuthenticPlanReviewRecord(
        createMuxMessage("m", "user", text, { muxMetadata: { ...meta, feedbackId: "fb_other" } })
      )
    ).toBeNull();
    // Extra parts (e.g. an attachment) break the exact single-envelope shape.
    const withExtraPart = createMuxMessage("x", "user", text, { muxMetadata: meta });
    withExtraPart.parts.push({ type: "text", text: "trailing" });
    expect(getAuthenticPlanReviewRecord(withExtraPart)).toBeNull();
  });
});
