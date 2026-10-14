import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  markSubagentGitPatchArtifactApplied,
  readSubagentGitPatchArtifactsFile,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";

describe("subagentGitPatchArtifacts", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-subagent-git-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  test("readSubagentGitPatchArtifactsFile returns empty file when missing", async () => {
    const file = await readSubagentGitPatchArtifactsFile(testDir);
    expect(file.version).toBe(2);
    expect(file.artifactsByChildTaskId).toEqual({});
  });

  test("upsertSubagentGitPatchArtifact writes normalized task-scoped artifacts", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const createdAtMs = Date.now();

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs,
        updatedAtMs: createdAtMs,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: "/tmp/project-a",
            projectName: "project-a",
            storageKey: "project-a",
            status: "ready",
            commitCount: 2,
            mboxPath: getSubagentGitPatchMboxPath(testDir, childTaskId, "project-a"),
          },
          {
            projectPath: "/tmp/project-b",
            projectName: "project-b",
            storageKey: "project-b",
            status: "skipped",
            commitCount: 0,
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });

    const pathOnDisk = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.stat(pathOnDisk);

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const artifact = file.artifactsByChildTaskId[childTaskId];
    expect(artifact).toBeTruthy();
    expect(artifact?.childTaskId).toBe(childTaskId);
    expect(artifact?.parentWorkspaceId).toBe(workspaceId);
    expect(artifact?.createdAtMs).toBe(createdAtMs);
    expect(artifact?.status).toBe("ready");
    expect(artifact?.readyProjectCount).toBe(1);
    expect(artifact?.skippedProjectCount).toBe(1);
    expect(artifact?.totalCommitCount).toBe(2);
    expect(artifact?.projectArtifacts).toHaveLength(2);
  });

  test("markSubagentGitPatchArtifactApplied sets appliedAtMs on only the matching project", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const createdAtMs = Date.now();

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs,
        updatedAtMs: createdAtMs,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: "/tmp/project-a",
            projectName: "project-a",
            storageKey: "project-a",
            status: "ready",
            commitCount: 1,
            mboxPath: getSubagentGitPatchMboxPath(testDir, childTaskId, "project-a"),
          },
          {
            projectPath: "/tmp/project-b",
            projectName: "project-b",
            storageKey: "project-b",
            status: "ready",
            commitCount: 1,
            mboxPath: getSubagentGitPatchMboxPath(testDir, childTaskId, "project-b"),
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });

    const appliedAtMs = createdAtMs + 1234;
    const updated = await markSubagentGitPatchArtifactApplied({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      projectPath: "/tmp/project-b",
      appliedAtMs,
    });

    expect(
      updated?.projectArtifacts.find((artifact) => artifact.projectPath === "/tmp/project-a")
        ?.appliedAtMs
    ).toBeUndefined();
    expect(
      updated?.projectArtifacts.find((artifact) => artifact.projectPath === "/tmp/project-b")
        ?.appliedAtMs
    ).toBe(appliedAtMs);
    expect(updated?.updatedAtMs).toBe(appliedAtMs);
  });

  test("markSubagentGitPatchArtifactApplied matches normalized legacy single-project artifacts", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-legacy";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify(
        {
          version: 1,
          artifactsByChildTaskId: {
            [childTaskId]: {
              childTaskId,
              parentWorkspaceId: workspaceId,
              createdAtMs: 123,
              status: "ready",
              commitCount: 1,
              mboxPath: "/tmp/legacy-series.mbox",
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const appliedAtMs = 456;
    const updated = await markSubagentGitPatchArtifactApplied({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      projectPath: "/tmp/project-a",
      appliedAtMs,
    });

    expect(updated?.projectArtifacts).toHaveLength(1);
    expect(updated?.projectArtifacts[0]?.appliedAtMs).toBe(appliedAtMs);
  });

  test("skips malformed artifact entries while preserving valid ones", async () => {
    const childTaskId = "child-valid";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify(
        {
          version: 2,
          artifactsByChildTaskId: {
            [childTaskId]: {
              childTaskId,
              parentWorkspaceId: "parent-1",
              createdAtMs: 123,
              status: "ready",
              projectArtifacts: [
                {
                  projectPath: "/tmp/project-a",
                  projectName: "project-a",
                  storageKey: "project-a",
                  status: "ready",
                  commitCount: 1,
                },
              ],
              readyProjectCount: 1,
              failedProjectCount: 0,
              skippedProjectCount: 0,
              totalCommitCount: 1,
            },
            broken: null,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    expect(file.artifactsByChildTaskId[childTaskId]?.status).toBe("ready");
    expect(file.artifactsByChildTaskId.broken).toBeUndefined();
  });

  test("skips an entry whose map key escapes the patch folder, and later writes still work", async () => {
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    const validArtifact = (childTaskId: string) => ({
      childTaskId,
      parentWorkspaceId: "parent-1",
      createdAtMs: 123,
      status: "ready",
      projectArtifacts: [
        {
          projectPath: "/tmp/project-a",
          projectName: "project-a",
          storageKey: "project-a",
          status: "ready",
          commitCount: 1,
        },
      ],
      readyProjectCount: 1,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 1,
    });
    // The entry's own childTaskId is safe; only its key is not.
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          "../../escape": validArtifact("child-safe"),
          "child-kept": validArtifact("child-kept"),
        },
      }),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    expect(Object.keys(file.artifactsByChildTaskId)).toEqual(["child-kept"]);

    const updated = await markSubagentGitPatchArtifactApplied({
      workspaceId: "parent-1",
      workspaceSessionDir: testDir,
      childTaskId: "child-kept",
      projectPath: "/tmp/project-a",
      appliedAtMs: 456,
    });
    expect(updated?.projectArtifacts[0]?.appliedAtMs).toBe(456);
  });

  test("normalizes version 1 artifacts into one-project patch sets", async () => {
    const childTaskId = "child-1";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify(
        {
          version: 1,
          artifactsByChildTaskId: {
            [childTaskId]: {
              childTaskId,
              parentWorkspaceId: "parent-1",
              createdAtMs: 123,
              status: "ready",
              commitCount: 1,
              mboxPath: "/tmp/legacy-series.mbox",
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const artifact = file.artifactsByChildTaskId[childTaskId];
    expect(artifact?.projectArtifacts).toHaveLength(1);
    expect(artifact?.projectArtifacts[0]).toMatchObject({
      projectName: "project",
      storageKey: "legacy-single-project",
      status: "ready",
      commitCount: 1,
      mboxPath: "/tmp/legacy-series.mbox",
    });
  });
});
