import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import type { Workspace } from "@/common/types/project";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

// The renderer deletes the localStorage keys of every workspace id missing from this set, so a
// missing live id loses that workspace's drafts, and a partial set must fail instead.
describe("WorkspaceService.listKnownIdsForStorageGc", () => {
  const projectPath = "/fake/project";
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function entry(id: string, extra: Partial<Workspace> = {}): Workspace {
    return {
      path: `${projectPath}/${id}`,
      id,
      name: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      ...extra,
    };
  }

  /**
   * Id-less legacy config entry whose two compatibility metadata.json files carry different ids:
   * the generated-legacy one is canonical, the basename one is a legacy alias.
   */
  async function legacyEntryWithAlias(basenameMetadata: string): Promise<Workspace> {
    const config = harness.config;
    const workspaceName = "aliased-feature";
    const workspacePath = path.join(config.srcDir, "project", workspaceName);
    await fs.mkdir(workspacePath, { recursive: true });
    const basenameDir = path.join(config.sessionsDir, workspaceName);
    await fs.mkdir(basenameDir, { recursive: true });
    await fs.writeFile(path.join(basenameDir, "metadata.json"), basenameMetadata);
    const legacyDir = path.join(
      config.sessionsDir,
      config.generateLegacyId(projectPath, workspacePath)
    );
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "metadata.json"),
      JSON.stringify({ id: "live-generated-id", name: workspaceName })
    );
    return { path: workspacePath };
  }

  test("includes active, archived, sub-agent and legacy alias ids", async () => {
    await saveWorkspaces(harness.config, projectPath, [
      entry("a0a0a0a0a0"),
      entry("b1b1b1b1b1", { archivedAt: "2026-01-02T00:00:00.000Z" }),
      entry("c2c2c2c2c2", { parentWorkspaceId: "a0a0a0a0a0" }),
      await legacyEntryWithAlias(
        JSON.stringify({ id: "stale-basename-id", name: "aliased-feature" })
      ),
    ]);

    const ids = await harness.service.listKnownIdsForStorageGc();

    expect(new Set(ids)).toEqual(
      new Set(["a0a0a0a0a0", "b1b1b1b1b1", "c2c2c2c2c2", "live-generated-id", "stale-basename-id"])
    );
  });

  test("rejects instead of returning a partial set when strict enumeration fails", async () => {
    await saveWorkspaces(harness.config, projectPath, [
      entry("a0a0a0a0a0"),
      await legacyEntryWithAlias("{ not json"),
    ]);

    let rejected = false;
    await harness.service.listKnownIdsForStorageGc().catch(() => {
      rejected = true;
    });

    expect(rejected).toBe(true);
  });
});
