import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  TaskApplyGitPatchProjectResultCard,
  TaskApplyGitPatchToolCall,
  type ParsedProjectResult,
} from "@/browser/features/Tools/TaskApplyGitPatchToolCall";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { installDom } from "../../../../tests/ui/dom";

const projectResults: ParsedProjectResult[] = [
  {
    projectPath: "/tmp/project-a",
    projectName: "project-a",
    status: "applied",
    appliedCommits: [
      {
        sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
        subject: "feat: add Apply Patch tool UI",
      },
    ],
  },
  {
    projectPath: "/tmp/project-b",
    projectName: "project-b",
    status: "skipped",
    error: "Patch generation was skipped because this project produced no commits.",
  },
  {
    projectPath: "/tmp/project-c",
    projectName: "project-c",
    status: "failed",
    error: "git am failed",
    failedPatchSubject: "fix: reconcile project-c changes",
    conflictPaths: ["src/index.ts"],
  },
];

describe("task_apply_git_patch commit list", () => {
  // Render into a per-test window and unmount afterwards so nodes never linger in
  // the baseline document shared by later suites in the same bun process.
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders commit groups per project with skipped and failed sections", () => {
    const view = render(
      <TooltipProvider>
        <div>
          {projectResults.map((projectResult) => (
            <TaskApplyGitPatchProjectResultCard
              key={projectResult.projectPath}
              projectResult={projectResult}
              isDryRun={false}
            />
          ))}
        </div>
      </TooltipProvider>
    );

    expect(view.getByText("project-a")).toBeTruthy();
    expect(view.getByText("project-b")).toBeTruthy();
    expect(view.getByText("project-c")).toBeTruthy();
    expect(view.getByText("feat: add Apply Patch tool UI")).toBeTruthy();
    expect(
      view.getByText("Patch generation was skipped because this project produced no commits.")
    ).toBeTruthy();
    expect(view.getByText("fix: reconcile project-c changes")).toBeTruthy();
    expect(view.getByText("src/index.ts")).toBeTruthy();
    expect(view.getByText("0f1e2d3")).toBeTruthy();
  });

  test("renders legacy project results even when projectPath is empty", () => {
    const view = render(
      <TooltipProvider>
        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-legacy", three_way: null }}
          status="completed"
          result={{
            success: false,
            taskId: "task-legacy",
            dryRun: false,
            error: "patch failed",
            projectResults: [
              {
                projectPath: "",
                projectName: "project",
                status: "failed",
                error: "legacy patch generation failed",
              },
            ],
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("project")).toBeTruthy();
    expect(view.getByText("legacy patch generation failed")).toBeTruthy();
  });
});
