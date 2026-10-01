import { describe, expect, test } from "bun:test";
import { isCompactionRecoveryError } from "./useCompactAndRetry";
import type { DisplayedMessage, DisplayedUserMessage } from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";

const compactRequest: DisplayedUserMessage = {
  type: "user",
  id: "user-1",
  historyId: "user-1",
  content: "/compact",
  historySequence: 1,
  compactionRequest: { parsed: {} },
};

function streamError(errorType: StreamErrorType): DisplayedMessage {
  return {
    type: "stream-error",
    id: "error-1",
    historyId: "error-1",
    error: "Request failed",
    errorType,
    historySequence: 2,
  };
}

describe("isCompactionRecoveryError", () => {
  test("offers compaction recovery when /compact fails with a generic API error", () => {
    expect(isCompactionRecoveryError(streamError("api"), compactRequest)).toBe(true);
  });

  // Daybreak access-program rejections are classified as authentication.
  test("does not offer compaction recovery for errors compaction cannot fix", () => {
    expect(isCompactionRecoveryError(streamError("authentication"), compactRequest)).toBe(false);
    expect(isCompactionRecoveryError(streamError("quota"), compactRequest)).toBe(false);
  });
});
