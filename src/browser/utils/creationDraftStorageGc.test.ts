import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";

import {
  collectOrphanedCreationDraftStorage,
  resetCreationDraftStorageGcForTests,
} from "@/browser/utils/creationDraftStorageGc";
import {
  getDraftScopeId,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getThinkingLevelKey,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import type { DraftList } from "@/common/orpc/schemas/drafts";

const PROJECT = "/repo/with/slashes";
const listed = (draftId: string) => ({
  projectPath: PROJECT,
  draftId,
  subProjectPath: null,
  createdAt: 1,
});

function seed(keys: readonly string[]): void {
  for (const key of keys) localStorage.setItem(key, JSON.stringify("value"));
}

function remaining(keys: readonly string[]): string[] {
  return keys.filter((key) => localStorage.getItem(key) !== null);
}

describe("collectOrphanedCreationDraftStorage", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    resetCreationDraftStorageGcForTests();
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  test("removes the settings keys of creation drafts the backend no longer lists", async () => {
    // Deleted (or turned into a workspace) by another origin, or its project was removed.
    const orphans = [
      getModelKey(getDraftScopeId(PROJECT, "gone")),
      getThinkingLevelKey(getDraftScopeId("/removed/project", "old")),
    ];
    const kept = [
      // Typed input is never collected: a typed workspace name, and legacy draft text that its
      // migration keeps until the backend confirms the import.
      getWorkspaceNameStateKey(getDraftScopeId(PROJECT, "gone")),
      getInputKey(getDraftScopeId(PROJECT, "gone")),
      getModelKey(getDraftScopeId(PROJECT, "listed")),
      // Not confirmed by the backend yet (an optimistic row) or the routed draft.
      getModelKey(getDraftScopeId(PROJECT, "live")),
      // Scopes that are not listed creation drafts.
      getModelKey(getDraftScopeId(PROJECT, "default")),
      getModelKey(getPendingScopeId(PROJECT)),
      getModelKey(getProjectScopeId(PROJECT)),
      getModelKey("0123456789"),
      getModelKey(getDraftScopeId(PROJECT, "bad id!")),
    ];
    seed([...orphans, ...kept]);

    const removed = await collectOrphanedCreationDraftStorage({
      listCreationDrafts: () =>
        Promise.resolve<DraftList>({ entries: [listed("listed")], revision: 1 }),
      isLive: (projectPath, draftId) => projectPath === PROJECT && draftId === "live",
    });

    expect(removed.sort()).toEqual([...orphans].sort());
    expect(remaining([...orphans, ...kept])).toEqual(kept);
  });

  test("removes nothing when the backend list cannot be read, and runs once per session", async () => {
    const key = getModelKey(getDraftScopeId(PROJECT, "gone"));
    seed([key]);
    let error: unknown;
    try {
      await collectOrphanedCreationDraftStorage({
        listCreationDrafts: () => Promise.reject(new Error("list.json unreadable")),
        isLive: () => false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(remaining([key])).toEqual([key]);

    const again = await collectOrphanedCreationDraftStorage({
      listCreationDrafts: () => Promise.resolve<DraftList>({ entries: [], revision: 1 }),
      isLive: () => false,
    });
    expect(again).toEqual([]);
    expect(remaining([key])).toEqual([key]);
  });

  test("keeps keys written for a draft created after the key snapshot", async () => {
    seed([getModelKey(getDraftScopeId(PROJECT, "gone"))]);
    const late = getModelKey(getDraftScopeId(PROJECT, "late"));
    await collectOrphanedCreationDraftStorage({
      listCreationDrafts: () => {
        // A draft created while the list request is in flight.
        seed([late]);
        return Promise.resolve<DraftList>({ entries: [], revision: 1 });
      },
      isLive: () => false,
    });
    expect(remaining([late])).toEqual([late]);
  });
});
