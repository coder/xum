import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputAttachmentsKey, getInputKey, getReviewsKey } from "@/common/constants/storage";
import { installDom } from "../../../../tests/ui/dom";
import { isRestoredDraftDurable } from "./restoredDraftDurability";

let cleanupDom: (() => void) | undefined;

const WORKSPACE_ID = "ws-durable";
const keys = {
  inputKey: getInputKey(WORKSPACE_ID),
  attachmentsKey: getInputAttachmentsKey(WORKSPACE_ID),
  reviewsKey: getReviewsKey(WORKSPACE_ID),
};
const storedReview = (id: string) => ({
  id,
  data: { filePath: "a.ts", lineRange: "1", selectedCode: "x", userNote: id },
  status: "attached",
  createdAt: 1,
});

describe("isRestoredDraftDurable", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    updatePersistedState(keys.inputKey, "restored\n\ndraft");
    updatePersistedState(keys.attachmentsKey, [
      {
        kind: "provider",
        id: "restored-1",
        url: "data:image/png;base64,AAA",
        mediaType: "image/png",
      },
    ]);
    updatePersistedState(keys.reviewsKey, {
      workspaceId: WORKSPACE_ID,
      reviews: { "review-1": storedReview("review-1") },
      lastUpdated: 1,
    });
  });
  afterEach(() => {
    cleanupDom?.();
  });

  const check = (overrides: Partial<Parameters<typeof isRestoredDraftDurable>[0]> = {}) =>
    isRestoredDraftDurable({
      ...keys,
      expectedText: "restored\n\ndraft",
      restoredAttachmentIds: ["restored-1"],
      restoredReviewIds: ["review-1"],
      ...overrides,
    });

  test("every restored part is in storage", () => {
    expect(check()).toBe(true);
  });

  // A failed text write leaves the old draft, which may already start with the restored text.
  test("the stored draft is not exactly the merged draft", () => {
    expect(check({ expectedText: "restored\n\nrestored\n\ndraft" })).toBe(false);
  });

  test("a restored attachment was not saved (too large, or the write failed)", () => {
    expect(check({ restoredAttachmentIds: ["restored-1", "restored-2"] })).toBe(false);
  });

  test("a restored note is missing from the review store (the write failed)", () => {
    expect(check({ restoredReviewIds: ["review-1", "review-2"] })).toBe(false);
  });

  test("restored notes went to the memory-only override", () => {
    expect(check({ restoredReviewIds: null })).toBe(false);
  });

  test("nothing to keep beyond the text", () => {
    expect(check({ restoredAttachmentIds: [], restoredReviewIds: [] })).toBe(true);
  });
});
