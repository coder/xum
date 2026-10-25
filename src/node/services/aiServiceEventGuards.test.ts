import { describe, expect, test } from "bun:test";
import {
  isStreamEndEvent,
  isStreamErrorEvent,
  isStreamStartEvent,
  isSuccessfulToolResult,
  isToolCallEndEvent,
  isWorkspaceEvent,
  statusSetResultStatus,
} from "./aiServiceEventGuards";

// WorkspaceService trusts an event's fields only after these guards pass, so each guard must
// reject the malformed shapes an emitter could hand it.
describe("aiServiceEventGuards", () => {
  test.each([
    [{ workspaceId: "ws" }, true],
    [{ workspaceId: 7 }, false],
    [{}, false],
    [null, false],
    ["ws", false],
  ])("isWorkspaceEvent(%p) is %p", (value, expected) => {
    expect(isWorkspaceEvent(value)).toBe(expected);
  });

  test.each([
    [{ workspaceId: "ws", model: "openai:gpt-5.2" }, true],
    [{ workspaceId: "ws" }, false],
    [{ workspaceId: "ws", model: 1 }, false],
    [{ model: "openai:gpt-5.2" }, false],
  ])("isStreamStartEvent(%p) is %p", (value, expected) => {
    expect(isStreamStartEvent(value)).toBe(expected);
  });

  test.each([
    [{ workspaceId: "ws" }, true],
    [{ workspaceId: "ws", metadata: {} }, true],
    [{ workspaceId: "ws", metadata: null }, false],
    [{ workspaceId: "ws", metadata: "usage" }, false],
  ])("isStreamEndEvent(%p) is %p", (value, expected) => {
    expect(isStreamEndEvent(value)).toBe(expected);
  });

  test.each([
    [{ workspaceId: "ws", error: "boom", errorType: "model_not_found" }, true],
    [{ workspaceId: "ws", error: { message: "boom" } }, false],
    [{ workspaceId: "ws" }, false],
  ])("isStreamErrorEvent(%p) is %p", (value, expected) => {
    expect(isStreamErrorEvent(value)).toBe(expected);
  });

  test.each([
    [{ workspaceId: "ws", toolName: "todo_write", result: undefined }, true],
    [{ workspaceId: "ws", toolName: "todo_write" }, false],
    [{ workspaceId: "ws", toolName: 3, result: {} }, false],
  ])("isToolCallEndEvent(%p) is %p", (value, expected) => {
    expect(isToolCallEndEvent(value)).toBe(expected);
  });

  test.each([
    [{ success: true }, true],
    [{ success: "true" }, false],
    [{ success: false }, false],
    [null, false],
  ])("isSuccessfulToolResult(%p) is %p", (value, expected) => {
    expect(isSuccessfulToolResult(value)).toBe(expected);
  });

  test("statusSetResultStatus reads the status only from a successful result", () => {
    expect(statusSetResultStatus({ success: true, emoji: "🔍", message: "Reading" })).toEqual({
      emoji: "🔍",
      message: "Reading",
    });
    expect(statusSetResultStatus({ success: false, emoji: "🔍", message: "Reading" })).toBeNull();
    expect(statusSetResultStatus("ok")).toBeNull();
  });
});
