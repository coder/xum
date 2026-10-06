import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { Workspace } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import {
  createTaskServiceStack,
  createWorkspaceServiceMocks,
  saveWorkspaces,
} from "./taskService.testHarness";

// getInfo, the AI-settings emit and TaskService.emitWorkspaceMetadata read one row. They must use
// the by-id build (one row, one checkout probe), never the full build over every workspace, and
// still answer the row the full build gives (src/node/config/snapshot.test.ts proves that
// equivalence). One malformed shape is the exception: duplicate ids with conflicting parents. There
// the answer is the first row with its own ancestor chain.
describe("WorkspaceService single-row metadata reads", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;

  const row = (id: string, fields: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id,
    path: path.join(harness.config.rootDir, "checkouts", id),
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local" },
    ...fields,
  });

  /** Rows emitted for each id, in order; the service emits through its own `metadata` event. */
  function recordEmits() {
    const emitted: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }> = [];
    const listener = (event: (typeof emitted)[number]) => emitted.push(event);
    harness.service.on("metadata", listener);
    return emitted;
  }

  /** Fails any read that falls back to building every workspace. */
  function forbidFullBuild() {
    return spyOn(harness.config, "getAllWorkspaceMetadata").mockImplementation(() => {
      throw new Error("Unexpected full metadata enumeration");
    });
  }

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    projectPath = path.join(harness.config.rootDir, "project");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("duplicate ids with conflicting parents answer the first row and its own root", async () => {
    await saveWorkspaces(harness.config, projectPath, [
      row("p1"),
      row("p2"),
      row("dup", { parentWorkspaceId: "p1", title: "first" }),
      row("dup", { parentWorkspaceId: "p2", title: "second" }),
      row("kid", { parentWorkspaceId: "dup" }),
    ]);
    const emitted = recordEmits();
    const emitWorkspace = mock(() => true);
    const { taskService } = createTaskServiceStack(harness.config, {
      workspaceService: createWorkspaceServiceMocks({ emit: emitWorkspace }).workspaceService,
    });
    const enumerate = forbidFullBuild();
    try {
      for (const id of ["dup", "kid"]) {
        const info = await harness.service.getInfo(id);
        expect({ id, root: info?.rootWorkspaceId }).toEqual({ id, root: "p1" });
        await taskService.emitWorkspaceMetadata(id);
      }
      expect((await harness.service.getInfo("dup"))?.title).toBe("first");
      const taskEmits = emitWorkspace.mock.calls as unknown as Array<
        [string, { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }]
      >;
      expect(
        taskEmits.map(([, event]) => [event.workspaceId, event.metadata?.rootWorkspaceId])
      ).toEqual([
        ["dup", "p1"],
        ["kid", "p1"],
      ]);

      const updated = await harness.service.updateAgentAISettings("dup", "exec", {
        model: "anthropic:claude-opus-5-5",
        thinkingLevel: "high",
      });
      expect(updated.success).toBe(true);
      expect(emitted.map((event) => [event.workspaceId, event.metadata?.rootWorkspaceId])).toEqual([
        ["dup", "p1"],
      ]);
      expect(emitted[0].metadata?.title).toBe("first");
    } finally {
      enumerate.mockRestore();
    }
  });

  test("answers the full-build row without a full build, and null for an unknown id", async () => {
    await saveWorkspaces(harness.config, projectPath, [
      row("root", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      row("child", { parentWorkspaceId: "root" }),
      row("same", { parentWorkspaceId: "root", title: "first" }),
      row("same", { parentWorkspaceId: "root", title: "second" }),
      // Worktree checkout deleted outside Xum: reads must report it as transcript-only.
      row("gone", { runtimeConfig: { type: "worktree", srcBaseDir: harness.config.srcDir } }),
    ]);
    fs.mkdirSync(path.join(harness.config.rootDir, "checkouts", "child"), { recursive: true });
    const full = await harness.config.getAllWorkspaceMetadata();
    const expected = (id: string) => full.find((metadata) => metadata.id === id)!;
    expect(expected("gone").transcriptOnly).toBe(true);
    const emitted = recordEmits();
    const emitWorkspace = mock(() => true);
    const { taskService } = createTaskServiceStack(harness.config, {
      workspaceService: createWorkspaceServiceMocks({ emit: emitWorkspace }).workspaceService,
    });
    const enumerate = forbidFullBuild();
    try {
      for (const id of ["child", "same", "gone"]) {
        expect(await harness.service.getInfo(id)).toEqual(expected(id));
        await taskService.emitWorkspaceMetadata(id);
        expect(emitWorkspace.mock.calls.at(-1)).toEqual([
          "metadata",
          { workspaceId: id, metadata: expected(id) },
        ]);
      }
      expect(await harness.service.getInfo("missing")).toBeNull();
      await taskService.emitWorkspaceMetadata("missing");
      expect(emitWorkspace.mock.calls.at(-1)).toEqual([
        "metadata",
        { workspaceId: "missing", metadata: null },
      ]);

      expect(
        (
          await harness.service.updateAgentAISettings("gone", "exec", {
            model: "anthropic:claude-opus-5-5",
            thinkingLevel: "high",
          })
        ).success
      ).toBe(true);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].workspaceId).toBe("gone");
      expect(emitted[0].metadata?.transcriptOnly).toBe(true);
      expect(emitted[0].metadata?.aiSettingsByAgent?.exec).toEqual({
        model: "anthropic:claude-opus-5-5",
        thinkingLevel: "high",
      });
    } finally {
      enumerate.mockRestore();
    }
  });
});
