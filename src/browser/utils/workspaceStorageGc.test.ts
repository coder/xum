import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import {
  collectOrphanedWorkspaceStorage,
  resetWorkspaceStorageGcForTests,
} from "@/browser/utils/workspaceStorageGc";
import {
  GLOBAL_SCOPE_ID,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  getDraftScopeId,
  getInputKey,
  getMCPTestResultsKey,
  getPendingScopeId,
  getProjectScopeId,
  getReviewStateKey,
  getTerminalTitlesKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";

const KNOWN_ID = "0123456789";
const ORPHAN_ID = "deadbeef00";
const LIVE_DRAFT = getDraftScopeId("/repo/with/slashes", "draft-live");
const STALE_DRAFT = getDraftScopeId("/repo/with/slashes", "draft-stale");

function seed(keys: readonly string[]): void {
  for (const key of keys) localStorage.setItem(key, JSON.stringify("value"));
}

function seedDraftsMap(): void {
  localStorage.setItem(
    WORKSPACE_DRAFTS_BY_PROJECT_KEY,
    JSON.stringify({
      "/repo/with/slashes": [{ draftId: "draft-live", subProjectPath: null, createdAt: 1 }],
    })
  );
}

function remaining(keys: readonly string[]): string[] {
  return keys.filter((key) => localStorage.getItem(key) !== null);
}

describe("collectOrphanedWorkspaceStorage", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    resetWorkspaceStorageGcForTests();
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("removes only keys of unknown stable workspace ids and stale creation drafts", async () => {
    const orphaned = [
      getInputKey(ORPHAN_ID),
      getReviewStateKey(ORPHAN_ID),
      getTerminalTitlesKey(ORPHAN_ID),
      getMCPTestResultsKey("/repo", ORPHAN_ID),
      getInputKey(STALE_DRAFT),
    ];
    const kept = [
      getInputKey(KNOWN_ID),
      getMCPTestResultsKey("/repo", KNOWN_ID),
      getInputKey(LIVE_DRAFT),
      getInputKey(getPendingScopeId("/repo")),
      getThinkingLevelKey(getProjectScopeId("/repo")),
      getThinkingLevelKey(GLOBAL_SCOPE_ID),
      // Legacy global key sharing a registered prefix.
      getThinkingLevelByModelKey("openai:gpt-5"),
      // Legacy (non-stable) workspace id format.
      getInputKey("myproject-feature-branch"),
      getMCPTestResultsKey("/repo", "myproject-feature-branch"),
      // Project-level MCP results.
      getMCPTestResultsKey("/repo"),
      // Unregistered key.
      `unregistered:${ORPHAN_ID}`,
    ];
    seed([...orphaned, ...kept]);
    seedDraftsMap();

    const removed = await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => Promise.resolve([KNOWN_ID]),
    });

    expect(removed.sort()).toEqual([...orphaned].sort());
    expect(remaining(orphaned)).toEqual([]);
    expect(remaining(kept)).toEqual(kept);
  });

  test("keeps every draft key when the drafts map is missing", async () => {
    seed([getInputKey(STALE_DRAFT)]);

    await collectOrphanedWorkspaceStorage({ listKnownWorkspaceIds: () => Promise.resolve([]) });

    expect(remaining([getInputKey(STALE_DRAFT)])).toEqual([getInputKey(STALE_DRAFT)]);
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("config unreadable"))],
    ["resolves a malformed list", () => Promise.resolve(undefined as unknown as string[])],
  ])("removes nothing when the known-id endpoint %s", async (_name, listKnownWorkspaceIds) => {
    const keys = [getInputKey(ORPHAN_ID), getInputKey(STALE_DRAFT)];
    seed(keys);
    seedDraftsMap();

    let failed = false;
    await collectOrphanedWorkspaceStorage({ listKnownWorkspaceIds }).catch(() => {
      failed = true;
    });

    expect(failed).toBe(true);
    expect(remaining(keys)).toEqual(keys);
  });

  test("runs at most once per session, even after a failed run", async () => {
    seed([getInputKey(ORPHAN_ID)]);
    await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => Promise.reject(new Error("backend unavailable")),
    }).catch(() => undefined);

    const listKnownWorkspaceIds = mock(() => Promise.resolve<string[]>([]));
    await collectOrphanedWorkspaceStorage({ listKnownWorkspaceIds });

    expect(listKnownWorkspaceIds).not.toHaveBeenCalled();
    expect(remaining([getInputKey(ORPHAN_ID)])).toEqual([getInputKey(ORPHAN_ID)]);
  });

  // The backend may enumerate before a workspace created in this session is persisted; that
  // workspace's keys are written after the snapshot and must survive.
  test("never removes keys written after the candidate snapshot", async () => {
    const createdLaterKey = getInputKey("abcdef0123");
    seed([getInputKey(ORPHAN_ID)]);

    await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => {
        localStorage.setItem(createdLaterKey, JSON.stringify("new draft"));
        return Promise.resolve([]);
      },
    });

    expect(localStorage.getItem(getInputKey(ORPHAN_ID))).toBeNull();
    expect(localStorage.getItem(createdLaterKey)).not.toBeNull();
  });
});
