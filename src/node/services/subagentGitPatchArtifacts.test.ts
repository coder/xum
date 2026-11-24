import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  markSubagentGitPatchArtifactApplied,
  readLocalPatchPartialApply,
  readSubagentGitPatchArtifactsFile,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

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
      locks: nodeSessionLocks,
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
      locks: nodeSessionLocks,
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
      locks: nodeSessionLocks,
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
      locks: nodeSessionLocks,
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
      locks: nodeSessionLocks,
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

  test("readLocalPatchPartialApply fails closed on malformed state JSON", async () => {
    // A truncated write (or corruption) may hide a recorded partial
    // application; returning empty state would let a retry replay commits.
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      '{"version":1,"partialsByChildTaskId":{',
      "utf-8"
    );

    let thrownMessage = "";
    try {
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_x",
        projectPath: "/repo",
      });
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("Could not read local patch apply state");
  });

  test("readLocalPatchPartialApply fails closed on an unsupported state version", async () => {
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      JSON.stringify({ version: 2, partialsByChildTaskId: {}, completionsByChildTaskId: {} }),
      "utf-8"
    );

    let thrownMessage = "";
    try {
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_x",
        projectPath: "/repo",
      });
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("unsupported version 2");
  });

  test("readLocalPatchPartialApply degrades a corrupted record to a conservative marker", async () => {
    // The entry's presence is the evidence of partial application (clears
    // delete the key); dropping it for a corrupt appliedAtMs would let the
    // retry rerun the already-landed commit series through git am.
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      JSON.stringify({
        version: 1,
        partialsByChildTaskId: {
          task_x: { "/repo": { appliedAtMs: "corrupt", headCommitSha: 42 } },
          task_y: { "/repo": { appliedAtMs: 1234 } },
        },
      }),
      "utf-8"
    );

    const record = await readLocalPatchPartialApply({
      workspaceSessionDir: testDir,
      childTaskId: "task_x",
      projectPath: "/repo",
    });
    expect(record).not.toBeNull();
    // The corrupt fence SHA is discarded; fence-less completion is supported.
    expect(record?.headCommitSha).toBeUndefined();
    // Valid sibling records survive untouched.
    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_y",
        projectPath: "/repo",
      })
    ).toEqual({ appliedAtMs: 1234 });
  });

  test("fails closed on present-but-malformed containers", async () => {
    // A malformed container (null, array, or primitive) may hide recorded
    // partials or completions for any project; treating it as empty would
    // let a retry replay an already-applied commit series.
    const stateFilePath = path.join(testDir, "subagent-patches-local-apply.json");
    const readPartial = () =>
      readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_x",
        projectPath: "/repo",
      });
    const expectThrows = async () => {
      let thrownMessage = "";
      try {
        await readPartial();
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).toContain("is malformed");
    };

    for (const corrupted of [
      { version: 1, partialsByChildTaskId: "corrupt" },
      { version: 1, partialsByChildTaskId: { task_x: null } },
      { version: 1, partialsByChildTaskId: { task_x: [1, 2] } },
      { version: 1, partialsByChildTaskId: {}, completionsByChildTaskId: null },
      { version: 1, partialsByChildTaskId: {}, completionsByChildTaskId: { task_x: null } },
    ]) {
      await fsPromises.writeFile(stateFilePath, JSON.stringify(corrupted), "utf-8");
      await expectThrows();
    }

    // Absent containers stay valid (legacy files predate completions).
    await fsPromises.writeFile(stateFilePath, JSON.stringify({ version: 1 }), "utf-8");
    expect(await readPartial()).toBeNull();
  });

  test("degrades structurally empty partial records to unknown stage", async () => {
    // {} and [] prove nothing about the commit series; the legacy
    // absent-stage default (commits-applied) is reserved for records with a
    // valid appliedAtMs, or an interrupted am-started apply would skip git am.
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      JSON.stringify({
        version: 1,
        partialsByChildTaskId: {
          task_x: { "/repo": {}, "/repo2": [] },
          task_y: { "/repo": { appliedAtMs: 1234 } },
        },
      }),
      "utf-8"
    );

    for (const projectPath of ["/repo", "/repo2"]) {
      expect(
        await readLocalPatchPartialApply({
          workspaceSessionDir: testDir,
          childTaskId: "task_x",
          projectPath,
        })
      ).toEqual({ appliedAtMs: 0, stage: "unknown" });
    }
    // A valid legacy record keeps the absent-stage default.
    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_y",
        projectPath: "/repo",
      })
    ).toEqual({ appliedAtMs: 1234 });
  });

  test("degrades out-of-range partial timestamps to unknown stage", async () => {
    // -1 and 1.5 are corruption, not evidence of an applied series: reading
    // them as valid would give the record the legacy absent-stage
    // commits-applied default and skip git am on retry.
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      JSON.stringify({
        version: 1,
        partialsByChildTaskId: {
          task_x: { "/repo": { appliedAtMs: -1 }, "/repo2": { appliedAtMs: 1.5 } },
        },
      }),
      "utf-8"
    );

    for (const projectPath of ["/repo", "/repo2"]) {
      expect(
        await readLocalPatchPartialApply({
          workspaceSessionDir: testDir,
          childTaskId: "task_x",
          projectPath,
        })
      ).toEqual({ appliedAtMs: 0, stage: "unknown" });
    }
  });

  test("degrades a fully malformed partial record to an unknown-stage marker", async () => {
    // The record's contents are unreadable, so its stage cannot default to
    // the legacy commits-applied: that would skip git am for what may be an
    // interrupted am-started apply.
    await fsPromises.writeFile(
      path.join(testDir, "subagent-patches-local-apply.json"),
      JSON.stringify({
        version: 1,
        partialsByChildTaskId: { task_x: { "/repo": "corrupt" } },
      }),
      "utf-8"
    );

    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_x",
        projectPath: "/repo",
      })
    ).toEqual({ appliedAtMs: 0, stage: "unknown" });
  });

  test("readLocalPatchPartialApply fails closed when the state file is unreadable", async () => {
    // A directory at the state file path forces a non-ENOENT read error
    // (EISDIR). Returning an empty state here would let a retry replay an
    // already-applied commit series.
    await fsPromises.mkdir(path.join(testDir, "subagent-patches-local-apply.json"));

    let thrownMessage = "";
    try {
      await readLocalPatchPartialApply({
        workspaceSessionDir: testDir,
        childTaskId: "task_x",
        projectPath: "/repo",
      });
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("Could not read local patch apply state");
  });

  test("sanitizes corrupted dirty-capture and partial-application fields on read", async () => {
    const childTaskId = "child-corrupt-fields";
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
                  appliedAtMs: 456,
                  // Corruption: the fence must be a SHA string (it is shell
                  // quoted on retry), appliedPartial a boolean.
                  appliedPartial: 1,
                  appliedPartialHeadSha: 12345,
                  hadUncommittedChanges: "yes",
                  worktreePatchPath: 42,
                  worktreePatchBytes: "big",
                  worktreePatchSkippedReason: { reason: "x" },
                },
              ],
              readyProjectCount: 1,
              failedProjectCount: 0,
              skippedProjectCount: 0,
              totalCommitCount: 1,
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const projectArtifact = file.artifactsByChildTaskId[childTaskId]?.projectArtifacts[0];
    expect(projectArtifact).toBeDefined();
    // Truthy corruption keeps the fail-closed partial marker; the unusable
    // fence and capture metadata are dropped rather than bricking retries.
    expect(projectArtifact?.appliedPartial).toBe(true);
    expect(projectArtifact?.appliedPartialHeadSha).toBeUndefined();
    // A lost ancestry fence must not leave a usable commits-applied stage.
    expect(projectArtifact?.appliedPartialStage).toBe("unknown");
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchBytes).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toBeUndefined();
    expect(projectArtifact?.appliedAtMs).toBe(456);
  });

  test("drops one side of an aliased mboxPath/worktreePatchPath pair", async () => {
    const childTaskId = "child-aliased-paths";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    const aliasedPath = path.join(testDir, "subagent-patches", childTaskId, "repo", "some.patch");
    const projectArtifact = (name: string, commitCount: number) => ({
      projectPath: `/tmp/${name}`,
      projectName: name,
      storageKey: name,
      status: "ready",
      commitCount,
      mboxPath: aliasedPath,
      worktreePatchPath: aliasedPath,
    });
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          [childTaskId]: {
            childTaskId,
            parentWorkspaceId: "parent-1",
            createdAtMs: 123,
            status: "ready",
            projectArtifacts: [
              projectArtifact("with-commits", 1),
              projectArtifact("commit-free", 0),
            ],
            readyProjectCount: 2,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 1,
          },
        },
      }),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const [withCommits, commitFree] =
      file.artifactsByChildTaskId[childTaskId]?.projectArtifacts ?? [];
    // One file cannot be both kinds; the surviving field matches the
    // artifact's shape so the bytes are consumed exactly once.
    expect(withCommits?.mboxPath).toBe(aliasedPath);
    expect(withCommits?.worktreePatchPath).toBeUndefined();
    expect(commitFree?.mboxPath).toBeUndefined();
    expect(commitFree?.worktreePatchPath).toBe(aliasedPath);
  });

  test("keeps a falsey-corrupt appliedPartial as a partial marker", async () => {
    const childTaskId = "child-falsey-partial";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    const projectArtifact = (name: string, appliedPartial: unknown) => ({
      projectPath: `/tmp/${name}`,
      projectName: name,
      storageKey: name,
      status: "ready",
      commitCount: 1,
      appliedAtMs: 456,
      appliedPartial,
      appliedPartialStage: "am-started",
    });
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          [childTaskId]: {
            childTaskId,
            parentWorkspaceId: "parent-1",
            createdAtMs: 123,
            status: "ready",
            projectArtifacts: [
              projectArtifact("project-a", 0),
              projectArtifact("project-b", null),
              projectArtifact("project-c", ""),
            ],
            readyProjectCount: 3,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 3,
          },
        },
      }),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    // A corrupt value cannot prove the apply completed: coercing by
    // truthiness would erase the marker and let an already-applied check
    // skip the pending recovery. The independently valid stage survives.
    for (const artifact of file.artifactsByChildTaskId[childTaskId]?.projectArtifacts ?? []) {
      expect(artifact.appliedPartial).toBe(true);
      expect(artifact.appliedPartialStage).toBe("am-started");
      expect(artifact.appliedAtMs).toBe(456);
    }
  });

  test("keeps falsey-corrupt hadUncommittedChanges as dirty", async () => {
    const childTaskId = "child-falsey-dirty";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    const projectArtifact = (name: string, hadUncommittedChanges: unknown) => ({
      projectPath: `/tmp/${name}`,
      projectName: name,
      storageKey: name,
      status: "ready",
      commitCount: 1,
      hadUncommittedChanges,
      worktreePatchSkippedReason: "diff exceeded the capture cap",
    });
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          [childTaskId]: {
            childTaskId,
            parentWorkspaceId: "parent-1",
            createdAtMs: 123,
            status: "ready",
            projectArtifacts: [
              projectArtifact("project-a", 0),
              projectArtifact("project-b", null),
              projectArtifact("project-c", ""),
              // Type-valid but contradicted by the retained skip reason.
              projectArtifact("project-d", false),
            ],
            readyProjectCount: 4,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 4,
          },
        },
      }),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    // Coercing falsey corruption to false would erase the dirty-work
    // evidence the apply gate and cleanup deferral key on, while the skip
    // reason still records uncaptured work.
    const artifacts = file.artifactsByChildTaskId[childTaskId]?.projectArtifacts ?? [];
    expect(artifacts).toHaveLength(4);
    for (const artifact of artifacts) {
      expect(artifact.hadUncommittedChanges).toBe(true);
      expect(artifact.worktreePatchSkippedReason).toBe("diff exceeded the capture cap");
    }
  });

  test("degrades a zero appliedAtMs to an unknown partial marker", async () => {
    const childTaskId = "child-zero-applied";
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.writeFile(
      artifactsPath,
      JSON.stringify({
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
                appliedAtMs: 0,
              },
            ],
            readyProjectCount: 1,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 1,
          },
        },
      }),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const projectArtifact = file.artifactsByChildTaskId[childTaskId]?.projectArtifacts[0];
    // Consumers test the timestamp by truthiness, so an accepted 0 would
    // neither prove application nor fail closed, and a retry could replay
    // the commit series.
    expect(projectArtifact?.appliedAtMs).toBeUndefined();
    expect(projectArtifact?.appliedPartial).toBe(true);
    expect(projectArtifact?.appliedPartialStage).toBe("unknown");
  });

  test("drops finite numeric fields that violate the schema's integer/nonnegative bounds", async () => {
    const childTaskId = "child-numeric-corruption";
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
                  // Finite but out of schema bounds: strict result validation
                  // would reject the whole artifact on task_await retrieval.
                  worktreePatchBytes: -1,
                  appliedAtMs: 1.5,
                },
                {
                  projectPath: "/tmp/project-b",
                  projectName: "project-b",
                  storageKey: "project-b",
                  status: "ready",
                  worktreePatchBytes: 1.5,
                  appliedAtMs: "yesterday",
                },
              ],
              readyProjectCount: 2,
              failedProjectCount: 0,
              skippedProjectCount: 0,
              totalCommitCount: 0,
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const [first, second] = file.artifactsByChildTaskId[childTaskId]?.projectArtifacts ?? [];
    expect(first?.worktreePatchBytes).toBeUndefined();
    expect(first?.appliedAtMs).toBeUndefined();
    expect(second?.worktreePatchBytes).toBeUndefined();
    expect(second?.appliedAtMs).toBeUndefined();
    // A present appliedAtMs was the only record that an application
    // happened: dropping the corrupt timestamp alone would let a retry
    // replay the already-landed series, so it degrades to partial/unknown.
    for (const artifact of [first, second]) {
      expect(artifact?.appliedPartial).toBe(true);
      expect(artifact?.appliedPartialStage).toBe("unknown");
    }
  });

  test("readSubagentGitPatchArtifactsFile with propagateReadErrors throws on corruption, not on ENOENT", async () => {
    const missing = await readSubagentGitPatchArtifactsFile(testDir, {
      propagateReadErrors: true,
    });
    expect(missing.artifactsByChildTaskId).toEqual({});

    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(testDir),
      '{"version":2,"artifactsByChildTaskId":{',
      "utf-8"
    );
    let readError: unknown;
    try {
      await readSubagentGitPatchArtifactsFile(testDir, { propagateReadErrors: true });
    } catch (error) {
      readError = error;
    }
    expect(readError).toBeDefined();
    // The default read stays self-healing for non-cleanup callers.
    const lenient = await readSubagentGitPatchArtifactsFile(testDir);
    expect(lenient.artifactsByChildTaskId).toEqual({});
  });

  test("readSubagentGitPatchArtifactsFile with propagateReadErrors throws on a malformed entry", async () => {
    // Entry-level normalization failures are dropped by the default read;
    // during cleanup a dropped entry reads as absent and its patch files
    // get deleted, so propagation must surface them too.
    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(testDir),
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          task_ok: {
            childTaskId: "task_ok",
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
          task_bad: {
            childTaskId: "task_bad",
            parentWorkspaceId: "parent-1",
            createdAtMs: 123,
            status: "ready",
            projectArtifacts: "corrupt",
          },
        },
      }),
      "utf-8"
    );

    let readError: unknown;
    try {
      await readSubagentGitPatchArtifactsFile(testDir, { propagateReadErrors: true });
    } catch (error) {
      readError = error;
    }
    expect(readError).toBeDefined();
    expect(String(readError)).toContain("task_bad");
    // The default read still skips the bad entry and keeps the good one.
    const lenient = await readSubagentGitPatchArtifactsFile(testDir);
    expect(Object.keys(lenient.artifactsByChildTaskId)).toEqual(["task_ok"]);
  });
});
