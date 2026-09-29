import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { QuotaLimitedStorage } from "../../../tests/ui/quotaLimitedStorage";

import { deleteWorkspaceStorage, migrateWorkspaceStorage } from "@/browser/utils/workspaceStorage";
import {
  getModelKey,
  getDesktopPopoutKey,
  getDisableWorkspaceAgentsKey,
  getMCPTestResultsKey,
  getPinnedTodoExpandedKey,
  getReasoningModeKey,
  getReviewFileFilterKey,
  getRightSidebarLayoutKey,
  getSubAgentTasksExpandedKey,
  getTerminalTitlesKey,
  getTimelineFilterKey,
} from "@/common/constants/storage";

describe("deleteWorkspaceStorage", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  // These per-workspace keys were missing from the delete lists, so every deleted workspace
  // left them behind until they filled the origin quota.
  test("removes per-workspace keys the old lists missed", () => {
    const workspaceId = "ws-delete-missing";
    const otherWorkspaceKey = getReasoningModeKey("ws-other");
    const keys = [
      getReasoningModeKey,
      getDisableWorkspaceAgentsKey,
      getPinnedTodoExpandedKey,
      getSubAgentTasksExpandedKey,
      getRightSidebarLayoutKey,
      getTerminalTitlesKey,
      getReviewFileFilterKey,
      getTimelineFilterKey,
      getDesktopPopoutKey,
    ].map((getKey) => getKey(workspaceId));
    for (const key of [...keys, otherWorkspaceKey]) localStorage.setItem(key, "value");

    deleteWorkspaceStorage(workspaceId);

    for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(otherWorkspaceKey)).toBe("value");
  });

  // Workspace-scoped MCP test results embed the project path before the id, so the registry loop
  // cannot address them.
  test("removes the workspace's mcpTestResults keys in every project", () => {
    const workspaceId = "ws-delete-mcp";
    const removed = [
      getMCPTestResultsKey("/repo/a", workspaceId),
      getMCPTestResultsKey("/repo/b", workspaceId),
    ];
    const kept = [
      getMCPTestResultsKey("/repo/a"),
      getMCPTestResultsKey("/repo/a", "ws-other"),
      getMCPTestResultsKey("/repo/a", `x${workspaceId}`),
    ];
    for (const key of [...removed, ...kept]) localStorage.setItem(key, "value");

    deleteWorkspaceStorage(workspaceId);

    for (const key of removed) expect(localStorage.getItem(key)).toBeNull();
    for (const key of kept) expect(localStorage.getItem(key)).toBe("value");
  });
});

describe("migrateWorkspaceStorage", () => {
  beforeEach(() => {
    saveDomGlobals();
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  // The copy no longer throws when a write fails; deleting the source anyway would erase the
  // only persisted copy of the scope's model/review/name state.
  test("keeps the source keys when a destination write fails", () => {
    const storage = new QuotaLimitedStorage(60);
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    Object.defineProperty(domWindow, "localStorage", { value: storage, configurable: true });
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.localStorage = storage;
    const sourceKey = getModelKey("__pending__/repo");
    storage.setItem(sourceKey, JSON.stringify("anthropic:claude-opus"));

    migrateWorkspaceStorage("__pending__/repo", "ws-destination");

    expect(storage.getItem(sourceKey)).toBe(JSON.stringify("anthropic:claude-opus"));
  });
});
