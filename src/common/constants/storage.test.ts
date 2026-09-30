import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  PERSISTED_KEY_REGISTRY,
  getDraftScopeId,
  getInputAttachmentsKey,
  getWorkspaceKeyPrefix,
  normalizeTerminalBadgeConfig,
  normalizeTranscriptDensity,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";

describe("storage workspace-scoped keys", () => {
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

  // A prefix that is a prefix of another would give keys the wrong kind, so quota eviction could
  // remove a draft or preference that merely shares a cache key's prefix.
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
