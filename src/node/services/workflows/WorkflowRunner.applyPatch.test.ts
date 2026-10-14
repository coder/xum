/* eslint-disable @typescript-eslint/require-await */
/**
 * `applyPatch` contract through a real workflow run: the spec the workflow passes reaches the
 * adapter normalized, and a raw `task_apply_git_patch` tool result is stored as the
 * applied/conflict/failed result the workflow reads back.
 */
import { describe, expect, mock, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner, type WorkflowApplyPatchSpec } from "./WorkflowRunner";

const RUN_ID = "wfr_apply_patch";

async function runApplyPatch(
  extraSpec: Record<string, unknown>,
  adapterResult: (spec: WorkflowApplyPatchSpec) => unknown
) {
  using tmp = new DisposableTempDir("workflow-runner-apply-patch");
  const store = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 100 });
  await store.createRun({
    id: RUN_ID,
    workspaceId: "workspace-1",
    workflow: {
      name: "apply-patch",
      description: "Apply an agent patch",
      scope: "built-in",
      executable: true,
    },
    source: `export default function workflow({ agent, applyPatch }) {
  agent("Implement the change", { id: "implement" });
  const patch = applyPatch({ id: "apply-implement", agentId: "implement", ...${JSON.stringify(extraSpec)} });
  return { reportMarkdown: patch.status };
}
`,
    args: {},
    now: "2026-05-29T00:00:00.000Z",
  });
  const applyPatch = mock(async (spec: WorkflowApplyPatchSpec) => adapterResult(spec));
  const runner = new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented", structuredOutput: {} };
      },
      applyPatch,
    },
    runnerId: "runner-a",
    clock: { nowIso: () => "2026-05-29T00:00:01.000Z", nowMs: () => 1_000 },
  });
  const outcome = await runner.run(RUN_ID).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error })
  );
  const run = await store.getRun(RUN_ID);
  const step = run.steps.find((candidate) => candidate.stepId === "apply-implement");
  const patchEvents = run.events.filter((event) => event.type === "patch");
  return { ...outcome, applyPatch, step, patchEvents };
}

const repoProject = { projectPath: "/repo", projectName: "repo" };

describe("WorkflowRunner applyPatch spec", () => {
  test.each([
    {
      name: "snake_case",
      extra: {
        three_way: false,
        force: true,
        onConflict: "return",
        strategy: "dry-run-then-apply",
        expected_head_sha: "abc123",
        project_path: "/repo",
        allowed_path_prefixes: [" src/ ", "docs"],
      },
      expected: {
        threeWay: false,
        force: true,
        expectedHeadSha: "abc123",
        projectPath: "/repo",
        allowedPathPrefixes: ["src/", "docs"],
      },
    },
    {
      name: "camelCase",
      extra: {
        threeWay: false,
        strategy: "three-way",
        expectedHeadSha: "def456",
        projectPath: "/other",
        project_path: "/ignored",
        allowedPathPrefixes: ["lib"],
      },
      expected: {
        threeWay: false,
        force: false,
        expectedHeadSha: "def456",
        projectPath: "/other",
        allowedPathPrefixes: ["lib"],
      },
    },
  ])("$name options reach the adapter normalized", async ({ extra, expected }) => {
    const { error, applyPatch } = await runApplyPatch(extra, (spec) => ({
      success: true,
      status: "applied",
      taskId: spec.sourceTaskId,
    }));

    expect(error).toBeUndefined();
    expect(applyPatch).toHaveBeenCalledTimes(1);
    const adapterSpec: unknown = applyPatch.mock.calls[0]?.[0];
    expect(adapterSpec).toEqual({
      id: "apply-implement",
      sourceTaskId: "task_impl",
      agentId: "implement",
      target: "parent",
      ...expected,
    });
  });

  test.each([
    { name: "onConflict abort", extra: { onConflict: "abort" }, message: "onConflict" },
    { name: "strategy rebase", extra: { strategy: "rebase" }, message: "strategy" },
    { name: "empty expectedHeadSha", extra: { expectedHeadSha: "" }, message: "expectedHeadSha" },
    {
      name: "non-array allowedPathPrefixes",
      extra: { allowedPathPrefixes: "src" },
      message: "allowedPathPrefixes must be an array",
    },
    {
      name: "blank allowed path prefix",
      extra: { allowed_path_prefixes: ["src", "  "] },
      message: "allowedPathPrefixes entries",
    },
  ])("rejects $name before calling the adapter", async ({ extra, message }) => {
    const { error, applyPatch } = await runApplyPatch(extra, () => {
      throw new Error("adapter must not run");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect(applyPatch).not.toHaveBeenCalled();
  });
});

describe("WorkflowRunner applyPatch raw tool results", () => {
  test("a successful tool result is stored as applied with its commits", async () => {
    const projectResults = [
      { ...repoProject, status: "applied", appliedCommits: [{ subject: "Add x", sha: "abc" }] },
    ];
    const { result, step, patchEvents } = await runApplyPatch({}, () => ({
      success: true,
      taskId: "task_impl",
      projectResults,
      appliedCommits: [{ subject: "Add x", sha: "abc" }],
      headCommitSha: "abc",
      dryRun: false,
      note: "applied cleanly",
    }));

    expect(result).toEqual({ reportMarkdown: "applied" });
    expect(step?.result?.structuredOutput).toEqual({
      success: true,
      status: "applied",
      taskId: "task_impl",
      dryRun: false,
      projectResults,
      appliedCommits: [{ subject: "Add x", sha: "abc" }],
      headCommitSha: "abc",
      note: "applied cleanly",
    });
    expect(patchEvents.map((event) => event.status)).toEqual(["started", "applied"]);
  });

  test("conflict paths from the result and its projects are merged without duplicates", async () => {
    const { result, step } = await runApplyPatch({}, () => ({
      success: false,
      taskId: "task_impl",
      error: "merge conflict",
      conflictPaths: ["src/a.ts"],
      projectResults: [
        { ...repoProject, status: "failed", conflictPaths: ["src/a.ts", "src/b.ts"] },
        { projectPath: "/docs", projectName: "docs", status: "skipped" },
      ],
    }));

    expect(result).toEqual({ reportMarkdown: "conflict" });
    expect(step?.result?.structuredOutput).toMatchObject({
      success: false,
      status: "conflict",
      conflictPaths: ["src/a.ts", "src/b.ts"],
      error: "merge conflict",
    });
    expect(step?.result?.reportMarkdown).toContain("src/a.ts, src/b.ts");
  });

  test("a project's failed patch subject marks the result as a conflict", async () => {
    const { result, step } = await runApplyPatch({}, () => ({
      success: false,
      taskId: "task_impl",
      error: "git am failed",
      projectResults: [{ ...repoProject, status: "failed", failedPatchSubject: "Add x" }],
    }));

    expect(result).toEqual({ reportMarkdown: "conflict" });
    expect(step?.result?.structuredOutput).toMatchObject({
      status: "conflict",
      failedPatchSubject: "Add x",
    });
    expect(step?.result?.structuredOutput).not.toHaveProperty("conflictPaths");
  });

  test("a failure without conflicts is stored as failed with its error", async () => {
    const { result, step } = await runApplyPatch({}, () => ({
      success: false,
      taskId: "task_impl",
      error: "no patch artifact",
    }));

    expect(result).toEqual({ reportMarkdown: "failed" });
    expect(step?.result?.structuredOutput).toEqual({
      success: false,
      status: "failed",
      taskId: "task_impl",
      error: "no patch artifact",
    });
    expect(step?.result?.reportMarkdown).toContain("no patch artifact");
  });

  test("a malformed adapter result fails the step instead of storing it", async () => {
    const { error, step, patchEvents } = await runApplyPatch({}, () => ({
      success: "yes",
      taskId: "task_impl",
    }));

    expect(error).toBeInstanceOf(Error);
    expect(step?.status).toBe("failed");
    expect(patchEvents.map((event) => event.status)).toEqual(["started", "failed"]);
  });
});
