import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

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

  test("record predicate hides every kind except feedback", () => {
    const hidden = createMuxMessage("r", "user", "x", {
      synthetic: true,
      muxMetadata: { type: "plan-review", kind: "resolve", recordId: "rec", threadId: "thr" },
    });
    const feedback = createMuxMessage("f", "user", "x", {
      muxMetadata: buildPlanReviewMetadata(feedbackRecord),
    });
    const ordinary = createMuxMessage("u", "user", "x");
    expect(isPlanReviewRecordMessage(hidden)).toBe(true);
    expect(isPlanReviewRecordMessage(feedback)).toBe(false);
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
