import { describe, expect, test } from "bun:test";
import {
  createMuxMessage,
  type DisplayedMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";
import { getActiveDelegatedTurnOwnerId } from "./DelegatedTurnBanner";

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
