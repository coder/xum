import { describe, expect, test } from "bun:test";
import {
  createMuxMessage,
  type DisplayedMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";
import { getActiveDelegatedTurnOwnerId, isTurnActive } from "./DelegatedTurnBanner";

function user(id: string, delegatedByWorkspaceId?: string): DisplayedMessage {
  return {
    type: "user",
    id,
    historyId: id,
    content: id,
    historySequence: 0,
    ...(delegatedByWorkspaceId != null ? { delegatedByWorkspaceId } : {}),
  };
}

describe("getActiveDelegatedTurnOwnerId", () => {
  test("names the owner only while the newest user row's delegated turn is active", () => {
    const delegated = [user("prompt", "owner-ws")];
    expect(getActiveDelegatedTurnOwnerId(delegated, true)).toBe("owner-ws");
    expect(getActiveDelegatedTurnOwnerId(delegated, false)).toBeNull();
    // New input typed here starts the next turn: the banner hides.
    expect(getActiveDelegatedTurnOwnerId([...delegated, user("human")], true)).toBeNull();
    expect(getActiveDelegatedTurnOwnerId([], true)).toBeNull();
  });
});

describe("isTurnActive", () => {
  test("a pending auto-retry keeps the turn active", () => {
    const idle = { canInterrupt: false, isStreamStarting: false, autoRetryStatus: null };
    expect(isTurnActive(idle)).toBe(false);
    expect(isTurnActive({ ...idle, canInterrupt: true })).toBe(true);
    expect(isTurnActive({ ...idle, isStreamStarting: true })).toBe(true);
    for (const type of ["auto-retry-scheduled", "auto-retry-starting"] as const) {
      expect(isTurnActive({ ...idle, autoRetryStatus: { type } })).toBe(true);
    }
    // An abandoned retry ended the turn.
    expect(isTurnActive({ ...idle, autoRetryStatus: { type: "auto-retry-abandoned" } })).toBe(
      false
    );
  });
});

describe("delegated prompt attribution", () => {
  test("a delegated turn's prompt row carries its owner; malformed correlation does not", () => {
    const build = (muxMetadata: MuxMessageMetadata) => {
      const [row] = buildDisplayedMessagesForMessage({
        message: createMuxMessage("prompt", "user", "Sync the stack", {
          historySequence: 1,
          muxMetadata,
        }),
        hasActiveStream: false,
        isContextBoundaryMessage: () => false,
      });
      if (row?.type !== "user") throw new Error(`expected user row, got ${row?.type}`);
      return row.delegatedByWorkspaceId;
    };
    expect(
      build({
        type: "workspace-turn-task",
        taskHandleId: "wst_sync",
        ownerWorkspaceId: "owner-ws",
        turnId: "turn-1",
      })
    ).toBe("owner-ws");
    expect(
      build({
        type: "workspace-turn-task",
        taskHandleId: "wst_sync",
        ownerWorkspaceId: " ",
        turnId: "turn-1",
      })
    ).toBeUndefined();
  });
});
