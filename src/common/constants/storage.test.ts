import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  PERSISTED_KEY_REGISTRY,
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
  findOrphanedWorkspaceStorageKeys,
  getDesktopPopoutKey,
  getDisableWorkspaceAgentsKey,
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getPendingScopeId,
  getPinnedTodoExpandedKey,
  getProjectScopeId,
  getReasoningModeKey,
  getReviewFileFilterKey,
  getReviewStateKey,
  getRightSidebarLayoutKey,
  getSubAgentTasksExpandedKey,
  getTerminalTitlesKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getTimelineFilterKey,
  getWorkspaceKeyPrefix,
  GLOBAL_SCOPE_ID,
  normalizeTerminalBadgeConfig,
  normalizeTranscriptDensity,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    const keys = Array.from(this.map.keys());
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("storage workspace-scoped keys", () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    // The helpers in src/common/constants/storage.ts rely on global localStorage.
    // In tests we install a minimal in-memory implementation.
    originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = new MemoryStorage();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("getDraftScopeId formats scope id", () => {
    expect(getDraftScopeId("/Users/me/repo", "draft-123")).toBe(
      "__draft__//Users/me/repo/draft-123"
    );
  });

  test("getInputAttachmentsKey formats key", () => {
    expect(getInputAttachmentsKey("ws-123")).toBe("inputAttachments:ws-123");
  });

  test("normalizeTranscriptDensity falls back for corrupt values", () => {
    expect(normalizeTranscriptDensity("hyper")).toBe("hyper");
    expect(normalizeTranscriptDensity("compact")).toBe("normal");
    expect(normalizeTranscriptDensity(null)).toBe("normal");
  });

  test("copyWorkspaceStorage copies inputAttachments key", () => {
    const source = "ws-source";
    const dest = "ws-dest";

    const sourceKey = getInputAttachmentsKey(source);
    const destKey = getInputAttachmentsKey(dest);

    const value = JSON.stringify([
      { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
    localStorage.setItem(sourceKey, value);

    copyWorkspaceStorage(source, dest);

    expect(localStorage.getItem(destKey)).toBe(value);
  });

  test("copyWorkspaceStorage drops staged draft attachments", () => {
    const source = "ws-source";
    const dest = "ws-dest";

    const sourceKey = getInputAttachmentsKey(source);
    const destKey = getInputAttachmentsKey(dest);
    const providerAttachment = {
      kind: "provider",
      id: "img-1",
      url: "data:image/png;base64,AAA",
      mediaType: "image/png",
    };
    const stagedAttachment = {
      kind: "staged",
      id: "zip-1",
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 128,
      stagedPath: ".mux/user-attachments/id/archive.zip",
    };
    localStorage.setItem(sourceKey, JSON.stringify([providerAttachment, stagedAttachment]));

    copyWorkspaceStorage(source, dest);

    expect(JSON.parse(localStorage.getItem(destKey) ?? "null")).toEqual([providerAttachment]);
  });

  test("deleteWorkspaceStorage removes inputAttachments key", () => {
    const workspaceId = "ws-delete";
    const key = getInputAttachmentsKey(workspaceId);

    localStorage.setItem(key, "value");
    deleteWorkspaceStorage(workspaceId);

    expect(localStorage.getItem(key)).toBeNull();
  });

  // These per-workspace keys were missing from the delete lists, so every deleted workspace
  // left them behind until they filled the origin quota.
  test("deleteWorkspaceStorage removes per-workspace keys the old lists missed", () => {
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

  // A prefix that is a prefix of another would misattribute keys: the wrong kind (eviction) or a
  // mangled scope id (orphan GC deleting or keeping the wrong keys).
  test("registered key prefixes never shadow each other", () => {
    const prefixes = PERSISTED_KEY_REGISTRY.map((entry) =>
      entry.scope === "workspaceId" ? getWorkspaceKeyPrefix(entry.getKey) : entry.key
    );
    for (const [index, prefix] of prefixes.entries()) {
      expect(prefix.length).toBeGreaterThan(0);
      for (const [otherIndex, other] of prefixes.entries()) {
        if (index !== otherIndex) expect(other.startsWith(prefix)).toBe(false);
      }
    }
  });
});

describe("findOrphanedWorkspaceStorageKeys", () => {
  const known = "0123456789";
  const unknown = "deadbeef00";
  const liveDraft = getDraftScopeId("/repo/with/slashes", "draft-live");
  const staleDraft = getDraftScopeId("/repo/with/slashes", "draft-stale");

  test("collects only unknown stable workspace ids and stale creation drafts", () => {
    const orphaned = [
      getInputKey(unknown),
      getReviewStateKey(unknown),
      getTerminalTitlesKey(unknown),
      getInputKey(staleDraft),
    ];
    const kept = [
      getInputKey(known),
      getInputKey(liveDraft),
      getInputKey(getPendingScopeId("/repo")),
      getThinkingLevelKey(getProjectScopeId("/repo")),
      getThinkingLevelKey(GLOBAL_SCOPE_ID),
      // Legacy global key sharing a registered prefix.
      getThinkingLevelByModelKey("openai:gpt-5"),
      // Legacy (non-stable) workspace id format.
      getInputKey("myproject-feature-branch"),
      // Unregistered key.
      `unregistered:${unknown}`,
    ];

    expect(
      findOrphanedWorkspaceStorageKeys(
        [...orphaned, ...kept],
        new Set([known]),
        new Set([liveDraft])
      )
    ).toEqual(orphaned);
  });

  test("keeps every draft key when the drafts map was not loaded", () => {
    expect(
      findOrphanedWorkspaceStorageKeys([getInputKey(staleDraft)], new Set([known]), null)
    ).toEqual([]);
  });
});

describe("normalizeTerminalBadgeConfig", () => {
  test("returns defaults for non-object input", () => {
    expect(normalizeTerminalBadgeConfig(undefined)).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
    expect(normalizeTerminalBadgeConfig("nope")).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
    expect(normalizeTerminalBadgeConfig([])).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
  });

  test("passes through a valid config", () => {
    const config: TerminalBadgeConfig = {
      enabled: true,
      template: "{tab}",
      position: "bottom-left",
      opacity: 0.75,
      fontSize: 24,
    };
    expect(normalizeTerminalBadgeConfig(config)).toEqual(config);
  });

  test("falls back per field on invalid values", () => {
    const normalized = normalizeTerminalBadgeConfig({
      enabled: "yes",
      template: 7,
      position: "middle",
      opacity: 3,
      fontSize: -2,
    });
    expect(normalized).toEqual({ ...DEFAULT_TERMINAL_BADGE_CONFIG, enabled: false });
  });

  test("rejects zero opacity and keeps the default", () => {
    expect(normalizeTerminalBadgeConfig({ opacity: 0 }).opacity).toBe(
      DEFAULT_TERMINAL_BADGE_CONFIG.opacity
    );
  });
});
