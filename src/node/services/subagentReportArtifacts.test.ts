import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  getSubagentReportArtifactPath,
  readSubagentReportArtifact,
  readSubagentReportArtifactStrict,
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";

describe("subagentReportArtifacts", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-subagent-report-"));
  });

  afterEach(async () => {
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  test("upsertSubagentReportArtifact computes reportTokenEstimate", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const markdown = "A".repeat(400);

    await upsertSubagentReportArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
      reportMarkdown: markdown,
      title: "token-estimate-test",
      nowMs: Date.now(),
    });

    const artifacts = await readSubagentReportArtifactsFile(testDir);
    const entry = artifacts.artifactsByChildTaskId[childTaskId];

    expect(entry).toBeDefined();
    expect(entry?.reportTokenEstimate).toBe(100);
  });

  test("upsertSubagentReportArtifact preserves plan file path metadata", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-plan";
    const planFilePath = path.join(testDir, "plans", "repo", "plan-child.md");

    await upsertSubagentReportArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
      reportMarkdown: "plan report",
      planFilePath,
      nowMs: Date.now(),
    });

    const artifacts = await readSubagentReportArtifactsFile(testDir);
    expect(artifacts.artifactsByChildTaskId[childTaskId]?.planFilePath).toBe(planFilePath);

    const artifact = await readSubagentReportArtifact(testDir, childTaskId);
    expect(artifact?.planFilePath).toBe(planFilePath);
  });

  test("upsertSubagentReportArtifact preserves structured output", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-structured";
    const structuredOutput = { claims: ["durable"], confidence: 0.8 };

    await upsertSubagentReportArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
      reportMarkdown: "structured report",
      structuredOutput,
      nowMs: Date.now(),
    });

    const artifact = await readSubagentReportArtifact(testDir, childTaskId);

    expect(artifact?.structuredOutput).toEqual(structuredOutput);
  });

  // #7003: the attempt id is read from the body, which holds the report markdown it labels; the
  // index is a separate write and may still name the previous report's attempt (a reader between
  // the two writes, or a failed index write).
  test("readSubagentReportArtifactStrict labels the report with its body's attempt", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const base = {
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
    };
    await upsertSubagentReportArtifact({
      ...base,
      reportMarkdown: "Report A.",
      taskAttemptId: "att_00000000000000a1",
    });
    const indexBeforeB = await fsPromises.readFile(
      path.join(testDir, "subagent-reports.json"),
      "utf-8"
    );
    await upsertSubagentReportArtifact({
      ...base,
      reportMarkdown: "Report B.",
      taskAttemptId: "att_00000000000000b2",
    });
    // The index as a reader between B's body write and its index write sees it.
    await fsPromises.writeFile(path.join(testDir, "subagent-reports.json"), indexBeforeB);

    const read = await readSubagentReportArtifact(testDir, childTaskId);

    expect(read?.reportMarkdown).toBe("Report B.");
    expect(read?.taskAttemptId).toBe("att_00000000000000b2");
  });

  describe("readSubagentReportArtifactStrict", () => {
    test("distinguishes a positively absent report from a persisted one", async () => {
      const childTaskId = "child-strict";
      expect(await readSubagentReportArtifactStrict(testDir, childTaskId)).toEqual({
        kind: "absent",
      });
      await upsertSubagentReportArtifact({
        workspaceId: "parent-1",
        workspaceSessionDir: testDir,
        childTaskId,
        parentWorkspaceId: "parent-1",
        ancestorWorkspaceIds: ["parent-1"],
        reportMarkdown: "done",
        nowMs: Date.now(),
      });
      const found = await readSubagentReportArtifactStrict(testDir, childTaskId);
      expect(found.kind).toBe("found");
      if (found.kind === "found") expect(found.artifact.reportMarkdown).toBe("done");
    });

    test("a corrupt report body is unreadable, never absent; the lenient reader still self-heals to null", async () => {
      const childTaskId = "child-corrupt";
      const reportPath = getSubagentReportArtifactPath(testDir, childTaskId);
      await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
      await fsPromises.writeFile(reportPath, "{ not json");
      const strict = await readSubagentReportArtifactStrict(testDir, childTaskId);
      expect(strict.kind).toBe("unreadable");
      expect(await readSubagentReportArtifact(testDir, childTaskId)).toBeNull();

      // A parseable body without a report is equally not evidence of absence.
      await fsPromises.writeFile(reportPath, JSON.stringify({ childTaskId, reportMarkdown: "" }));
      expect((await readSubagentReportArtifactStrict(testDir, childTaskId)).kind).toBe(
        "unreadable"
      );
    });

    test("an I/O failure other than ENOENT is unreadable", async () => {
      const childTaskId = "child-eacces";
      const reportPath = getSubagentReportArtifactPath(testDir, childTaskId);
      // A directory where the report FILE should be: reading it fails with EISDIR, not ENOENT.
      await fsPromises.mkdir(reportPath, { recursive: true });
      const strict = await readSubagentReportArtifactStrict(testDir, childTaskId);
      expect(strict.kind).toBe("unreadable");
      if (strict.kind === "unreadable") expect(strict.error).toContain("EISDIR");
      expect(await readSubagentReportArtifact(testDir, childTaskId)).toBeNull();
    });
  });
});
