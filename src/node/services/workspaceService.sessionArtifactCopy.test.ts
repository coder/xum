import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import { log } from "./log";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const parentId = "parent-ws";
const childId = "child-ws";

// Removing a sub-agent rolls the reports of its own (grandchild) tasks up into the parent's
// session dir, so they outlive the child's session dir. Each report lives in a per-task
// directory that is copied only when the parent does not already have one.
describe("WorkspaceService remove rolls child report dirs into the parent", () => {
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

  function reportDir(sessionDir: string, taskId: string): string {
    return path.join(sessionDir, "subagent-reports", taskId);
  }

  async function writeFile(filePath: string, content: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content);
  }

  /** Index entries for the child's tasks; only the index decides which dirs are rolled up. */
  async function writeChildReportIndex(taskIds: string[]): Promise<void> {
    const entries = Object.fromEntries(
      taskIds.map((taskId) => [
        taskId,
        {
          childTaskId: taskId,
          parentWorkspaceId: childId,
          createdAtMs: 1,
          updatedAtMs: 1,
          ancestorWorkspaceIds: [childId, parentId],
        },
      ])
    );
    await writeFile(
      path.join(childDir, "subagent-reports.json"),
      JSON.stringify({ version: 1, artifactsByChildTaskId: entries })
    );
  }

  /** log.error calls about a report dir copy into the parent, found by their context. */
  function copyFailureLogs(logError: { mock: { calls: unknown[][] } }): unknown[] {
    const reportsDir = path.join(parentDir, "subagent-reports");
    return logError.mock.calls
      .map(([, context]) => context)
      .filter((context) => {
        const destDir = (context as { destDir?: unknown } | undefined)?.destDir;
        return typeof destDir === "string" && destDir.startsWith(reportsDir);
      });
  }

  async function readOrNull(filePath: string): Promise<string | null> {
    return fsPromises.readFile(filePath, "utf8").catch(() => null);
  }

  async function removeChild(): Promise<void> {
    expect((await harness.service.remove(childId, true)).success).toBe(true);
    // The child's own session dir is gone, so the parent copy is the only one left.
    expect(await fsPromises.stat(childDir).catch(() => null)).toBeNull();
  }

  test("copies the whole report dir when the parent has none", async () => {
    await writeChildReportIndex(["task-a"]);
    await writeFile(path.join(reportDir(childDir, "task-a"), "report.json"), "child report");
    await writeFile(path.join(reportDir(childDir, "task-a"), "nested", "extra.txt"), "extra");

    await removeChild();

    expect(await readOrNull(path.join(reportDir(parentDir, "task-a"), "report.json"))).toBe(
      "child report"
    );
    expect(await readOrNull(path.join(reportDir(parentDir, "task-a"), "nested", "extra.txt"))).toBe(
      "extra"
    );
  });

  test("keeps an existing parent report dir untouched", async () => {
    await writeChildReportIndex(["task-b"]);
    await writeFile(path.join(reportDir(childDir, "task-b"), "report.json"), "child report");
    await writeFile(path.join(reportDir(childDir, "task-b"), "child-only.txt"), "child");
    await writeFile(path.join(reportDir(parentDir, "task-b"), "report.json"), "parent report");

    await removeChild();

    expect(await readOrNull(path.join(reportDir(parentDir, "task-b"), "report.json"))).toBe(
      "parent report"
    );
    // No merge either: files only the child had are not added to the existing dir.
    expect(
      await readOrNull(path.join(reportDir(parentDir, "task-b"), "child-only.txt"))
    ).toBeNull();
  });

  test("skips an indexed task without a report dir silently and still copies the others", async () => {
    const logError = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      await writeChildReportIndex(["task-missing", "task-c"]);
      await writeFile(path.join(reportDir(childDir, "task-c"), "report.json"), "c report");

      await removeChild();

      expect(
        await fsPromises.stat(reportDir(parentDir, "task-missing")).catch(() => null)
      ).toBeNull();
      expect(await readOrNull(path.join(reportDir(parentDir, "task-c"), "report.json"))).toBe(
        "c report"
      );
      expect(copyFailureLogs(logError)).toEqual([]);
    } finally {
      logError.mockRestore();
    }
  });

  test("logs and keeps a parent file that occupies the report dir path", async () => {
    const logError = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      await writeChildReportIndex(["task-d"]);
      await writeFile(path.join(reportDir(childDir, "task-d"), "report.json"), "child report");
      await writeFile(reportDir(parentDir, "task-d"), "not a dir");

      await removeChild();

      expect(await readOrNull(reportDir(parentDir, "task-d"))).toBe("not a dir");
      const copyFailures = copyFailureLogs(logError);
      expect(copyFailures).toHaveLength(1);
      expect(copyFailures[0]).toMatchObject({
        artifact: "subagent-reports",
        taskId: "task-d",
        destDir: reportDir(parentDir, "task-d"),
      });
    } finally {
      logError.mockRestore();
    }
  });
});
