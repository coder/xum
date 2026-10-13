import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Workspace } from "@/common/types/project";
import { getValidMessagingTag, normalizeMessagingTag } from "@/common/orpc/schemas/workspace";
import type { Config } from "@/node/config";
import type { WorkspaceService } from "./workspaceService";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";

const WORKSPACE_ID = "a1b2c3d4e5";
const CHILD_ID = "b2c3d4e5f6";
const SIDE_CHAT_ID = "c3d4e5f6a7";

/**
 * Real Config in a temp root: the tag must round-trip through the serialized config writer
 * and the metadata loader, not a mocked transform (same harness as the consent tests).
 */
async function createHarness() {
  const { config, service, rootDir: tempDir, cleanup } = await createWorkspaceServiceHarness();
  const projectPath = path.join(tempDir, "project");
  const workspacePath = path.join(tempDir, "src", "project", "root-ws");
  const childPath = path.join(tempDir, "src", "project", "child-ws");
  const sideChatPath = path.join(tempDir, "src", "project", "side-ws");
  for (const dir of [workspacePath, childPath, sideChatPath]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await config.editConfig((cfg) => {
    const workspaces: Workspace[] = [
      { id: WORKSPACE_ID, name: "root-ws", path: workspacePath },
      {
        id: CHILD_ID,
        name: "child-ws",
        path: childPath,
        parentWorkspaceId: WORKSPACE_ID,
      },
      {
        id: SIDE_CHAT_ID,
        name: "side-ws",
        path: sideChatPath,
        sideChatParentWorkspaceId: WORKSPACE_ID,
      },
    ];
    cfg.projects.set(projectPath, { workspaces });
    return cfg;
  });

  const persistedEntry = (workspaceId = WORKSPACE_ID): Workspace | undefined =>
    [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId);

  return { config, service, projectPath, persistedEntry, cleanup };
}

describe("WorkspaceService.setMessagingTag", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let config: Config;
  let service: WorkspaceService;

  beforeEach(async () => {
    harness = await createHarness();
    config = harness.config;
    service = harness.service;
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  test("normalizes @strip/lowercase/trim, persists, and publishes metadata", async () => {
    const published: Array<{
      workspaceId: string;
      metadata: { messagingTag?: string } | null;
    }> = [];
    service.on(
      "metadata",
      (event: { workspaceId: string; metadata: { messagingTag?: string } | null }) =>
        published.push(event)
    );

    const result = await service.setMessagingTag(WORKSPACE_ID, "  @Deep-Dive_1 ");
    expect(result.success).toBe(true);
    expect(harness.persistedEntry()?.messagingTag).toBe("deep-dive_1");
    expect(published).toHaveLength(1);
    expect(published[0].workspaceId).toBe(WORKSPACE_ID);
    expect(published[0].metadata?.messagingTag).toBe("deep-dive_1");

    // A fresh metadata load (what every other reader sees) carries the same tag.
    const reloaded = await config.getAllWorkspaceMetadata();
    expect(reloaded.find((m) => m.id === WORKSPACE_ID)?.messagingTag).toBe("deep-dive_1");
    // Tagging never mints or changes unrelated-workspace consent.
    expect(harness.persistedEntry()?.unrelatedWorkspaceConsent).toBeUndefined();
    expect(reloaded.find((m) => m.id === WORKSPACE_ID)?.unrelatedWorkspaceConsent).toBeUndefined();
  });

  test("invalid tags are rejected without persisting or publishing", async () => {
    expect((await service.setMessagingTag(WORKSPACE_ID, "research")).success).toBe(true);
    const published: unknown[] = [];
    service.on("metadata", (event: unknown) => published.push(event));

    for (const invalid of ["@bad tag!", "!!", "@", "a".repeat(33), "-leading-hyphen"]) {
      const result = await service.setMessagingTag(WORKSPACE_ID, invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid messaging tag");
      }
    }
    expect(harness.persistedEntry()?.messagingTag).toBe("research");
    expect(published).toEqual([]);
  });

  test("null and empty clear the tag, and clearing again is a committed no-op", async () => {
    expect((await service.setMessagingTag(WORKSPACE_ID, "research")).success).toBe(true);

    const cleared = await service.setMessagingTag(WORKSPACE_ID, null);
    expect(cleared.success).toBe(true);
    expect(harness.persistedEntry()?.messagingTag).toBeUndefined();
    const entry = harness.persistedEntry();
    expect(entry != null && "messagingTag" in entry).toBe(false);

    expect((await service.setMessagingTag(WORKSPACE_ID, "research")).success).toBe(true);
    expect((await service.setMessagingTag(WORKSPACE_ID, "   ")).success).toBe(true);
    expect(harness.persistedEntry()?.messagingTag).toBeUndefined();

    const reloaded = await config.getAllWorkspaceMetadata();
    expect(reloaded.find((m) => m.id === WORKSPACE_ID)?.messagingTag).toBeUndefined();
  });

  test("refuses child and side-chat workspaces without persisting", async () => {
    for (const [id, kind] of [
      [CHILD_ID, "sub-agent"],
      [SIDE_CHAT_ID, "side chat"],
    ] as const) {
      const result = await service.setMessagingTag(id, "research");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("root chat");
        expect(result.error).toContain(kind);
      }
      expect(harness.persistedEntry(id)?.messagingTag).toBeUndefined();
    }
  });

  test("a malformed persisted tag publishes as untagged, never bricking the workspace", async () => {
    await config.editConfig((cfg) => {
      const entry = cfg.projects
        .get(harness.projectPath)
        ?.workspaces.find((w) => w.id === WORKSPACE_ID);
      if (entry) {
        (entry as { messagingTag?: unknown }).messagingTag = "@Not Normalized!";
      }
      return cfg;
    });
    expect(getValidMessagingTag(harness.persistedEntry()?.messagingTag)).toBeUndefined();
    const metadata = await config.getAllWorkspaceMetadata();
    const root = metadata.find((m) => m.id === WORKSPACE_ID);
    expect(root?.messagingTag).toBeUndefined();
    expect(root?.name).toBe("root-ws");
  });
});

describe("messaging tag helpers", () => {
  test("normalizeMessagingTag trims, strips one @, lowercases, and validates", () => {
    expect(normalizeMessagingTag("  @Research ")).toBe("research");
    expect(normalizeMessagingTag("deep-dive_1")).toBe("deep-dive_1");
    expect(normalizeMessagingTag("@@double")).toBeNull();
    expect(normalizeMessagingTag("")).toBeNull();
    expect(normalizeMessagingTag("bad tag")).toBeNull();
    expect(normalizeMessagingTag("a".repeat(32))).toBe("a".repeat(32));
    expect(normalizeMessagingTag("a".repeat(33))).toBeNull();
  });

  test("getValidMessagingTag only accepts already-normalized tags (fail closed)", () => {
    expect(getValidMessagingTag("research")).toBe("research");
    expect(getValidMessagingTag("@research")).toBeUndefined();
    expect(getValidMessagingTag("Research")).toBeUndefined();
    expect(getValidMessagingTag(" research ")).toBeUndefined();
    expect(getValidMessagingTag("")).toBeUndefined();
    expect(getValidMessagingTag(undefined)).toBeUndefined();
    expect(getValidMessagingTag(42)).toBeUndefined();
  });
});
