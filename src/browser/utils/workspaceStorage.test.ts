import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { QuotaLimitedStorage } from "../../../tests/ui/quotaLimitedStorage";

import {
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
  migrateWorkspaceStorage,
} from "@/browser/utils/workspaceStorage";
import {
  getModelKey,
  getReviewsKey,
  getPersistedKeyRegistration,
  getWorkspaceNameStateKey,
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

  // Older builds stored values larger than today's budgets (e.g. the whole creation message in
  // workspaceNameState). The destination can only hold such a value in memory, so the source must
  // stay the durable copy.
  test("keeps a source value that is over its budget at the destination", () => {
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.localStorage = domWindow.localStorage;
    const sourceKey = getWorkspaceNameStateKey("__pending__/repo2");
    const budget = getPersistedKeyRegistration(sourceKey)!.maxValueChars;
    const legacyValue = JSON.stringify({ lastGeneratedFor: "m".repeat(budget) });
    localStorage.setItem(sourceKey, legacyValue);

    migrateWorkspaceStorage("__pending__/repo2", "ws-destination2");

    expect(localStorage.getItem(sourceKey)).toBe(legacyValue);
  });
});

describe("copyWorkspaceStorage", () => {
  beforeEach(() => {
    saveDomGlobals();
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.localStorage = domWindow.localStorage;
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  // A source whose legacy review data was never imported has no review-state.json for the backend
  // fork to copy; the fork's own one-time import needs the legacy keys.
  test("carries not-yet-imported legacy review data to a fork", () => {
    const legacyReviews = JSON.stringify({ workspaceId: "ws-source", reviews: { r1: {} } });
    localStorage.setItem(getReviewsKey("ws-source"), legacyReviews);

    expect(copyWorkspaceStorage("ws-source", "ws-fork")).toBe(true);

    expect(localStorage.getItem(getReviewsKey("ws-fork"))).toBe(legacyReviews);
  });
});
