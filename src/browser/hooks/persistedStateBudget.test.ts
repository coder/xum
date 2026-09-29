/**
 * CI bound on localStorage usage, derived from the persisted key registry.
 *
 * Every registered key family is expanded to a realistic worst-case instance count and filled
 * with values exactly at their budgets through the real write path. The total must stay far
 * enough below the origin quota that nothing the app keeps can crowd out the rest. Raising a
 * budget, an LRU maxEntries or adding a per-workspace key grows these totals, so the test fails
 * when a change would let localStorage fill up again.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  EXPERIMENTS,
  getExperimentKey,
  getLegacyPtcExclusiveExperimentKey,
  type ExperimentId,
} from "@/common/constants/experiments";
import * as storageModule from "@/common/constants/storage";
import {
  GLOBAL_SCOPE_ID,
  PERSISTED_KEY_REGISTRY,
  getAgentIdKey,
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
  getDraftScopeId,
  getModelKey,
  getPersistedKeyKind,
  getPersistedKeyRegistration,
  getProjectScopeId,
  getReasoningModeKey,
  getThinkingLevelKey,
  type PersistedKeyRegistration,
} from "@/common/constants/storage";

// Realistic worst-case scale. Do not lower these to make a budget fit; shrink the budget or bound
// the value at its owner instead.
/** Workspaces with local UI state (stable 10-hex ids). */
const WORKSPACE_COUNT = 200;
/** Open creation drafts (their scope ids embed the project path). */
const DRAFT_SCOPE_COUNT = 10;
/** Projects; project-scoped keys embed the project path. */
const PROJECT_COUNT = 50;
/** A long but realistic project path. */
const PROJECT_PATH_CHARS = 120;
/** Models with a per-model auto-compaction threshold. */
const MODEL_COUNT = 50;

/**
 * Origin quotas are ~5 Mi UTF-16 code units (Chromium, Firefox). Everything the app keeps must fit
 * well below that, leaving room for unregistered legacy keys that cleanups have not removed yet.
 * Non-evictable data gets its own ceiling because cache eviction cannot free it.
 */
const NON_EVICTABLE_CEILING_CHARS = 2.5 * 1024 * 1024;
const LOCAL_STORAGE_BUDGET_CEILING_CHARS = 3.5 * 1024 * 1024;

/**
 * Workspace keys that creation flows also write under project and global scope ids (creation
 * defaults), so they are counted once per project plus once for the global scope.
 */
const PROJECT_SCOPED_WORKSPACE_KEYS = [
  getModelKey,
  getAgentIdKey,
  getThinkingLevelKey,
  getReasoningModeKey,
  getDisableWorkspaceAgentsKey,
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
];

function projectPath(index: number): string {
  const prefix = `/Users/someone/src/github.com/org/project-${index}/`;
  return prefix + "p".repeat(PROJECT_PATH_CHARS - prefix.length);
}

function workspaceId(index: number): string {
  return index.toString(16).padStart(10, "0");
}

const projectPaths = Array.from({ length: PROJECT_COUNT }, (_, index) => projectPath(index));
const workspaceIds = Array.from({ length: WORKSPACE_COUNT }, (_, index) => workspaceId(index));
const draftScopeIds = Array.from({ length: DRAFT_SCOPE_COUNT }, (_, index) =>
  getDraftScopeId(projectPaths[index % PROJECT_COUNT], `${index}`.padStart(36, "d"))
);
const projectScopeIds = [...projectPaths.map(getProjectScopeId), GLOBAL_SCOPE_ID];
const experimentKeys = [
  ...(Object.keys(EXPERIMENTS) as ExperimentId[]).map(getExperimentKey),
  getLegacyPtcExclusiveExperimentKey(),
];

/** Every concrete key the worst-case model writes for one registration. */
function modelledKeys(entry: PersistedKeyRegistration): string[] {
  if (entry.scope === "workspaceId") {
    const scopeIds =
      entry.scopes === "draft"
        ? draftScopeIds
        : entry.scopes === "webview"
          ? workspaceIds
          : [...workspaceIds, ...draftScopeIds];
    const keys = scopeIds.map(entry.getKey);
    if (PROJECT_SCOPED_WORKSPACE_KEYS.includes(entry.getKey)) {
      keys.push(...projectScopeIds.map(entry.getKey));
    }
    return keys;
  }
  if (entry.match === "exact") return [entry.key];
  switch (entry.instances) {
    case "project":
      return projectPaths.map((path) => entry.key + path);
    case "project+workspace":
      return [
        ...projectPaths.map((path) => entry.key + path),
        ...workspaceIds.map(
          (id, index) => `${entry.key}${projectPaths[index % PROJECT_COUNT]}:${id}`
        ),
      ];
    case "model":
      return Array.from(
        { length: MODEL_COUNT },
        (_, index) => `${entry.key}provider:model-${index}`
      );
    case "experiment":
      return experimentKeys.filter((key) => key.startsWith(entry.key));
    default:
      // LRU caches key their entries by workspace id; model every entry maxEntries allows, which
      // can be more than WORKSPACE_COUNT (session costs outlive deleted workspaces).
      return Array.from({ length: entry.instances }, (_, index) => entry.key + workspaceId(index));
  }
}

function keyLabel(entry: PersistedKeyRegistration): string {
  return entry.scope === "workspaceId" ? entry.getKey("{scope}") : entry.key;
}

describe("localStorage budget", () => {
  let cleanupDom: (() => void) | null = null;
  let error: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    cleanupDom = installDom();
    error = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    error.mockRestore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the worst case of every registered key stays under the ceilings", () => {
    const storage = window.localStorage;
    const notStored: string[] = [];
    for (const entry of PERSISTED_KEY_REGISTRY) {
      if (entry.maxValueChars === 0) continue; // Legacy keys: never written.
      // A JSON string of exactly maxValueChars chars (quotes included).
      const value = "x".repeat(entry.maxValueChars - 2);
      for (const key of modelledKeys(entry)) {
        updatePersistedState(key, value);
        // Check the disk, not the return value: an over-budget value (e.g. a key resolving to a
        // smaller-budget registration) is kept in memory and still returns true, so it would be
        // missing from the totals below.
        if (storage.getItem(key) !== JSON.stringify(value)) notStored.push(key);
      }
    }
    expect(notStored).toEqual([]);

    let total = 0;
    let nonEvictable = 0;
    // VS Code webview keys live in the webview's own origin, not the app's.
    let webview = 0;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)!;
      const chars = key.length + (storage.getItem(key)?.length ?? 0);
      const registration = getPersistedKeyRegistration(key);
      if (registration?.scope === "workspaceId" && registration.scopes === "webview") {
        webview += chars;
        continue;
      }
      total += chars;
      if (getPersistedKeyKind(key) !== "cache") nonEvictable += chars;
    }

    // What one more workspace costs: the lever a new per-workspace key moves 200-fold.
    const id = workspaceIds[0];
    let perWorkspace = 0;
    for (const entry of PERSISTED_KEY_REGISTRY) {
      if (entry.scope !== "workspaceId" || entry.scopes !== "workspace") continue;
      if (entry.maxValueChars > 0) perWorkspace += entry.getKey(id).length + entry.maxValueChars;
    }
    const summary =
      `total ${total} / ${LOCAL_STORAGE_BUDGET_CEILING_CHARS} chars, ` +
      `non-evictable ${nonEvictable} / ${NON_EVICTABLE_CEILING_CHARS} chars, ` +
      `per workspace ${perWorkspace} chars x ${WORKSPACE_COUNT + DRAFT_SCOPE_COUNT} scopes, ` +
      `VS Code webview origin ${webview} / ${NON_EVICTABLE_CEILING_CHARS} chars`;
    expect({ nonEvictableFits: nonEvictable <= NON_EVICTABLE_CEILING_CHARS, summary }).toEqual({
      nonEvictableFits: true,
      summary,
    });
    expect({ totalFits: total <= LOCAL_STORAGE_BUDGET_CEILING_CHARS, summary }).toEqual({
      totalFits: true,
      summary,
    });
    expect({ webviewFits: webview <= NON_EVICTABLE_CEILING_CHARS, summary }).toEqual({
      webviewFits: true,
      summary,
    });
  });

  // An unregistered key is refused at runtime, so a new key constant without a registration would
  // silently stop persisting.
  test("every key constant and key function resolves to a registration", () => {
    // Legacy keys that are only read and removed (migrations/cleanups), never written.
    const legacyOnly = new Set([
      "GATEWAY_MODELS_KEY",
      "GATEWAY_ENABLED_KEY",
      "getInputAttachmentsKey",
      "getAutoRetryKey",
    ]);
    const unregistered: string[] = [];
    for (const [name, value] of Object.entries(storageModule)) {
      if (legacyOnly.has(name)) continue;
      let key: string | null = null;
      if (name.endsWith("_KEY") && typeof value === "string") key = value;
      if (/^get\w+Key$/.test(name) && typeof value === "function") {
        key = (value as (scope: string) => string)("0123456789");
      }
      if (key !== null && getPersistedKeyRegistration(key) === undefined) unregistered.push(name);
    }
    for (const key of experimentKeys) {
      if (getPersistedKeyRegistration(key) === undefined) unregistered.push(key);
    }
    expect(unregistered).toEqual([]);
  });

  test("the model covers every registration with at least one key", () => {
    const empty = PERSISTED_KEY_REGISTRY.filter((entry) => modelledKeys(entry).length === 0);
    expect(empty.map(keyLabel)).toEqual([]);
  });
});
