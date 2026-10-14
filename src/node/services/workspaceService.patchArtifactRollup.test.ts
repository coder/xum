import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifactsFile,
} from "./subagentGitPatchArtifacts";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const parentId = "parent-ws";
const childId = "child-ws";
const storageKey = "repo";

// Removing a sub-agent rolls the patch artifacts of its own (grandchild) tasks up into the
// parent's session dir: the mbox dirs are copied and the index entries are merged, so the
// parent can still apply those patches after the child's session dir is gone.
describe("WorkspaceService remove rolls child patch artifacts into the parent", () => {
  let harness: WorkspaceServiceHarness;
  let parentDir: string;
  let childDir: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    const projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "parent", parentId, { runtimeConfig: { type: "local" } }),
      projectWorkspace(projectPath, "child", childId, {
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentId,
      }),
    ]);
    parentDir = path.join(harness.config.sessionsDir, parentId);
    childDir = path.join(harness.config.sessionsDir, childId);
    await fsPromises.mkdir(childDir, { recursive: true });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function artifact(
    taskId: string,
    sessionDir: string,
    updatedAtMs: number,
    /** null: the project produced no mbox. */
    mboxPath: string | null = getSubagentGitPatchMboxPath(sessionDir, taskId, storageKey)
  ): SubagentGitPatchArtifact {
    return {
      childTaskId: taskId,
      parentWorkspaceId: childId,
      createdAtMs: 1,
      updatedAtMs,
      status: "ready",
      projectArtifacts: [
        {
          projectPath: "/repo",
          projectName: "repo",
          storageKey,
          status: "ready",
          commitCount: 1,
          ...(mboxPath != null ? { mboxPath } : {}),
        },
      ],
      readyProjectCount: 1,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 1,
    };
  }

  async function writeIndex(sessionDir: string, entries: SubagentGitPatchArtifact[]) {
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(sessionDir),
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: Object.fromEntries(entries.map((e) => [e.childTaskId, e])),
      })
    );
  }

  async function writeMbox(mboxPath: string, content: string) {
    await fsPromises.mkdir(path.dirname(mboxPath), { recursive: true });
    await fsPromises.writeFile(mboxPath, content);
  }

  async function removeChild(): Promise<void> {
    expect((await harness.service.remove(childId, true)).success).toBe(true);
    expect(await fsPromises.stat(childDir).catch(() => null)).toBeNull();
  }

  test("copies the mbox dir and records the entry with the parent's mbox path", async () => {
    await writeIndex(childDir, [artifact("task-a", childDir, 10)]);
    await writeMbox(getSubagentGitPatchMboxPath(childDir, "task-a", storageKey), "patch a");

    await removeChild();

    const parentMbox = getSubagentGitPatchMboxPath(parentDir, "task-a", storageKey);
    expect(await fsPromises.readFile(parentMbox, "utf8")).toBe("patch a");
    const entry = (await readSubagentGitPatchArtifactsFile(parentDir)).artifactsByChildTaskId[
      "task-a"
    ];
    expect(entry).toMatchObject({ childTaskId: "task-a", parentWorkspaceId: parentId });
    expect(entry?.projectArtifacts.map((project) => project.mboxPath)).toEqual([parentMbox]);
  });

  test("keeps a newer parent entry and replaces an older one", async () => {
    await writeIndex(parentDir, [
      artifact("task-newer", parentDir, 50),
      artifact("task-older", parentDir, 5),
    ]);
    await writeIndex(childDir, [
      artifact("task-newer", childDir, 20),
      artifact("task-older", childDir, 20),
    ]);

    await removeChild();

    const entries = (await readSubagentGitPatchArtifactsFile(parentDir)).artifactsByChildTaskId;
    expect(entries["task-newer"]?.updatedAtMs).toBe(50);
    expect(entries["task-older"]?.updatedAtMs).toBe(20);
  });

  test("never copies an mbox from outside the child session dir", async () => {
    const outside = path.join(harness.rootDir, "outside", storageKey, "series.mbox");
    await writeMbox(outside, "not the child's");
    await writeIndex(childDir, [artifact("task-out", childDir, 10, outside)]);

    await removeChild();

    const parentMbox = getSubagentGitPatchMboxPath(parentDir, "task-out", storageKey);
    expect(await fsPromises.stat(parentMbox).catch(() => null)).toBeNull();
  });

  test("never copies an mbox for an index key that escapes the parent session dir", async () => {
    // The reader keeps the map key, not the entry's own childTaskId. This key resolves to
    // <sessions>/escaped, outside the parent's dir but still inside the test's temp root.
    const escapingKey = "../../escaped";
    const inChild = getSubagentGitPatchMboxPath(childDir, "safe", storageKey);
    await writeMbox(inChild, "patch");
    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(childDir),
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: { [escapingKey]: artifact("safe", childDir, 10, inChild) },
      })
    );
    const escapedDir = path.dirname(
      getSubagentGitPatchMboxPath(parentDir, escapingKey, storageKey)
    );
    expect(path.relative(parentDir, escapedDir).startsWith("..")).toBe(true);
    expect(path.relative(harness.rootDir, escapedDir).startsWith("..")).toBe(false);

    await removeChild();

    expect(await fsPromises.stat(escapedDir).catch(() => null)).toBeNull();
  });

  test("an entry without an mbox is merged without copying anything", async () => {
    await writeIndex(childDir, [artifact("task-none", childDir, 10, null)]);

    await removeChild();

    const entry = (await readSubagentGitPatchArtifactsFile(parentDir)).artifactsByChildTaskId[
      "task-none"
    ];
    expect(entry?.projectArtifacts.map((project) => project.mboxPath)).toEqual([undefined]);
    expect(
      await fsPromises
        .stat(path.dirname(getSubagentGitPatchMboxPath(parentDir, "task-none", storageKey)))
        .catch(() => null)
    ).toBeNull();
  });
});
