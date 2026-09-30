import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";

import { subscribePersistedStateWrites } from "@/browser/hooks/usePersistedState";
import {
  collectOrphanedWorkspaceStorage,
  resetWorkspaceStorageGcForTests,
} from "@/browser/utils/workspaceStorageGc";
import {
  GLOBAL_SCOPE_ID,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  getDraftScopeId,
  getMCPTestResultsKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getReviewStateKey,
  getTerminalTitlesKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";

const KNOWN_ID = "0123456789";
const ORPHAN_ID = "deadbeef00";
const MAPPED_DRAFT = getDraftScopeId("/repo/with/slashes", "draft-live");
// Absent from the drafts map, e.g. a routed draft id whose map entry another tab removed.
const UNMAPPED_DRAFT = getDraftScopeId("/repo/with/slashes", "draft-unmapped");

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
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    resetWorkspaceStorageGcForTests();
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  test("removes only keys of unknown stable workspace ids", async () => {
    const orphaned = [
      getModelKey(ORPHAN_ID),
      getReviewStateKey(ORPHAN_ID),
      getTerminalTitlesKey(ORPHAN_ID),
      getMCPTestResultsKey("/repo", ORPHAN_ID),
    ];
    const kept = [
      getModelKey(KNOWN_ID),
      getMCPTestResultsKey("/repo", KNOWN_ID),
      // The drafts map is not authoritative, so creation-draft keys are never collected.
      getModelKey(MAPPED_DRAFT),
      getModelKey(UNMAPPED_DRAFT),
      getModelKey(getPendingScopeId("/repo")),
      getThinkingLevelKey(getProjectScopeId("/repo")),
      getThinkingLevelKey(GLOBAL_SCOPE_ID),
      // Legacy global key sharing a registered prefix.
      getThinkingLevelByModelKey("openai:gpt-5"),
      // Legacy (non-stable) workspace id format.
      getModelKey("myproject-feature-branch"),
      getMCPTestResultsKey("/repo", "myproject-feature-branch"),
      // Project-level MCP results.
      getMCPTestResultsKey("/repo"),
      // Unregistered key.
      `unregistered:${ORPHAN_ID}`,
    ];
    seed([...orphaned, ...kept]);
    // A loaded map that lacks UNMAPPED_DRAFT: reintroducing map-based draft collection would
    // remove that key, so the map is seeded on purpose even though GC never reads it.
    seedDraftsMap();

    const removed = await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => Promise.resolve([KNOWN_ID]),
    });

    expect(removed.sort()).toEqual([...orphaned].sort());
    expect(remaining(orphaned)).toEqual([]);
    expect(remaining(kept)).toEqual(kept);
  });

  // Mounted usePersistedState consumers must observe the removal, or they would keep showing
  // (and could write back) the deleted value.
  test("notifies persisted-state write listeners for every removed key", async () => {
    seed([getModelKey(ORPHAN_ID), getModelKey(KNOWN_ID)]);
    const removedKeys: string[] = [];
    const unsubscribe = subscribePersistedStateWrites((event) => {
      if (event.newValue == null) removedKeys.push(event.key);
    });

    try {
      await collectOrphanedWorkspaceStorage({
        listKnownWorkspaceIds: () => Promise.resolve([KNOWN_ID]),
      });
    } finally {
      unsubscribe();
    }

    expect(removedKeys).toEqual([getModelKey(ORPHAN_ID)]);
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("config unreadable"))],
    ["resolves a malformed list", () => Promise.resolve(undefined as unknown as string[])],
  ])("removes nothing when the known-id endpoint %s", async (_name, listKnownWorkspaceIds) => {
    const keys = [getModelKey(ORPHAN_ID), getMCPTestResultsKey("/repo", ORPHAN_ID)];
    seed(keys);

    let failed = false;
    await collectOrphanedWorkspaceStorage({ listKnownWorkspaceIds }).catch(() => {
      failed = true;
    });

    expect(failed).toBe(true);
    expect(remaining(keys)).toEqual(keys);
  });

  test("runs at most once per session, even after a failed run", async () => {
    seed([getModelKey(ORPHAN_ID)]);
    await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => Promise.reject(new Error("backend unavailable")),
    }).catch(() => undefined);

    const listKnownWorkspaceIds = mock(() => Promise.resolve<string[]>([]));
    await collectOrphanedWorkspaceStorage({ listKnownWorkspaceIds });

    expect(listKnownWorkspaceIds).not.toHaveBeenCalled();
    expect(remaining([getModelKey(ORPHAN_ID)])).toEqual([getModelKey(ORPHAN_ID)]);
  });

  // The backend may enumerate before a workspace created in this session is persisted; that
  // workspace's keys are written after the snapshot and must survive.
  test("never removes keys written after the candidate snapshot", async () => {
    const createdLaterKey = getModelKey("abcdef0123");
    seed([getModelKey(ORPHAN_ID)]);

    await collectOrphanedWorkspaceStorage({
      listKnownWorkspaceIds: () => {
        localStorage.setItem(createdLaterKey, JSON.stringify("new value"));
        return Promise.resolve([]);
      },
    });

    expect(localStorage.getItem(getModelKey(ORPHAN_ID))).toBeNull();
    expect(localStorage.getItem(createdLaterKey)).not.toBeNull();
  });
});
