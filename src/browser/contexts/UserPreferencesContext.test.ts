import { describe, expect, test } from "bun:test";

import {
  canPrunePreferenceScopes,
  createMergePatch,
  mirrorBackendPreferences,
  prunePreferenceScopes,
} from "./UserPreferencesContext";
import {
  GLOBAL_SCOPE_ID,
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  getAgentIdKey,
} from "@/common/constants/storage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  setJSON(key: string, value: unknown): void {
    this.setItem(key, JSON.stringify(value));
  }
}

describe("UserPreferencesProvider bridge helpers", () => {
  test("removes stale local cache entries on a backend refresh", () => {
    const storage = new MemoryStorage();
    storage.setJSON(REVIEW_INCLUDE_UNCOMMITTED_KEY, false);
    storage.setJSON(getAgentIdKey(GLOBAL_SCOPE_ID), "plan");

    mirrorBackendPreferences({
      backendPreferences: { review: { includeUncommitted: true } },
      storage,
    });

    expect(JSON.parse(storage.getItem(REVIEW_INCLUDE_UNCOMMITTED_KEY) ?? "null")).toBe(true);
    expect(storage.getItem(getAgentIdKey(GLOBAL_SCOPE_ID))).toBeNull();
  });

  test("removing the last known value of a section deletes only that stored value", () => {
    expect(createMergePatch({ appearance: { theme: "dark" } }, {})).toEqual({
      appearance: { theme: null },
    });
  });

  test("only prunes scoped preferences after successful project and workspace loads", () => {
    const ready = {
      hydrated: true,
      projectLoading: false,
      projectLoaded: true,
      projectLoadError: null,
      workspaceLoading: false,
      workspaceLoaded: true,
      workspaceLoadError: null,
    };

    expect(canPrunePreferenceScopes(ready)).toBe(true);
    expect(canPrunePreferenceScopes({ ...ready, projectLoaded: false })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, workspaceLoaded: false })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, projectLoadError: "failed" })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, workspaceLoadError: "failed" })).toBe(false);
  });

  test("prunes project and workspace scoped preferences that no longer exist", () => {
    const projects = new Map([
      ["/repo/a", { workspaces: [] }],
      ["/repo/c", { workspaces: [] }],
    ]);

    expect(
      prunePreferenceScopes({
        preferences: {
          navigation: { projectOrder: ["/repo/b", "/repo/a"] },
          ai: {
            projectDefaults: {
              "/repo/a": { agentId: "exec" },
              "/repo/b": { agentId: "plan" },
            },
          },
          workspaceCreation: {
            byProject: {
              "/repo/b": { trunkBranch: "origin/main" },
            },
          },
          notifications: {
            notifyOnResponseByWorkspace: { "ws-keep": true, "ws-drop": true },
          },
          review: {
            defaultBaseByProject: { "/repo/b": "origin/main" },
          },
        },
        projectPaths: new Set(["/repo/a", "/repo/c"]),
        workspaceIds: new Set(["ws-keep"]),
        userProjects: projects,
      })
    ).toEqual({
      navigation: { projectOrder: ["/repo/c", "/repo/a"] },
      ai: { projectDefaults: { "/repo/a": { agentId: "exec" } } },
      notifications: { notifyOnResponseByWorkspace: { "ws-keep": true } },
    });
  });

  test("keeps scratch AI defaults while pruning removed projects", () => {
    const projects = new Map([["/repo/a", { workspaces: [] }]]);

    expect(
      prunePreferenceScopes({
        preferences: {
          ai: {
            projectDefaults: {
              _scratch: { agentId: "plan", model: "anthropic:claude-x", thinkingLevel: "high" },
              "/repo/removed": { agentId: "plan" },
            },
          },
        },
        // The scratch system project is never part of the valid project paths.
        projectPaths: new Set(["/repo/a"]),
        workspaceIds: new Set(),
        userProjects: projects,
      })
    ).toEqual({
      ai: {
        projectDefaults: {
          _scratch: { agentId: "plan", model: "anthropic:claude-x", thinkingLevel: "high" },
        },
      },
    });
  });
});
