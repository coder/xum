import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealGitStatusStoreModule from "@/browser/stores/GitStatusStore";
import type { GitStatus } from "@/common/types/workspace";
import type {
  MultiProjectGitSummary,
  ProjectGitStatusResult,
} from "@/browser/stores/GitStatusStore";

// Captured before the stub below so the real store is restored for later suites
// in the same bun process (CI shares one process per shard).
restoreModulesAfterSuite([["@/browser/stores/GitStatusStore", { ...RealGitStatusStoreModule }]]);

let currentSummary: MultiProjectGitSummary | null = null;
let currentRefreshing = false;

void mock.module("@/browser/stores/GitStatusStore", () => ({
  useMultiProjectGitSummary: () => currentSummary,
  useGitStatusRefreshing: () => currentRefreshing,
  useGitStatus: () => null,
  useProjectGitStatuses: () => null,
  useGitStatusStoreRaw: () => ({
    invalidateWorkspace: () => undefined,
  }),
  invalidateGitStatus: () => undefined,
}));

import { MultiProjectDivergenceDialog } from "@/browser/components/GitStatusIndicator/MultiProjectDivergenceDialog";
import { MultiProjectGitStatusIndicator } from "@/browser/components/GitStatusIndicator/MultiProjectGitStatusIndicator";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

function createGitStatus(overrides?: Partial<GitStatus>): GitStatus {
  return {
    branch: "feature/test",
    ahead: 0,
    behind: 0,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
    ...overrides,
  };
}

function createProjectStatusResult(
  overrides?: Partial<ProjectGitStatusResult>
): ProjectGitStatusResult {
  return {
    projectPath: "/tmp/repo-a",
    projectName: "repo-a",
    gitStatus: createGitStatus(),
    error: null,
    ...overrides,
  };
}

function createSummary(projects: ProjectGitStatusResult[]): MultiProjectGitSummary {
  return {
    totalProjectCount: projects.length,
    divergedProjectCount: projects.filter(
      (project) =>
        project.gitStatus !== null && (project.gitStatus.ahead > 0 || project.gitStatus.behind > 0)
    ).length,
    dirtyProjectCount: projects.filter((project) => project.gitStatus?.dirty === true).length,
    unknownProjectCount: projects.filter((project) => project.gitStatus === null).length,
    projects,
  };
}

function renderWithTooltipProvider(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("MultiProjectGitStatusIndicator", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    currentSummary = null;
    currentRefreshing = false;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    currentSummary = null;
    currentRefreshing = false;
  });

  test("renders a compact clean summary chip", () => {
    currentSummary = createSummary([
      createProjectStatusResult({ projectPath: "/tmp/repo-a", projectName: "repo-a" }),
      createProjectStatusResult({ projectPath: "/tmp/repo-b", projectName: "repo-b" }),
      createProjectStatusResult({ projectPath: "/tmp/repo-c", projectName: "repo-c" }),
    ]);

    const view = renderWithTooltipProvider(
      <MultiProjectGitStatusIndicator workspaceId="workspace-1" tooltipPosition="bottom" />
    );

    const button = view.getByRole("button", { name: "Open multi-project git status details" });
    expect(button.textContent).toContain("3 repos");
    expect(button.textContent).not.toContain("diverged");
    expect(button.textContent).not.toContain("dirty");
  });

  test("renders unknown, diverged, and dirty summary copy", () => {
    currentSummary = createSummary([
      createProjectStatusResult({
        projectPath: "/tmp/repo-a",
        projectName: "repo-a",
        gitStatus: null,
        error: "Git status unavailable",
      }),
      createProjectStatusResult({
        projectPath: "/tmp/repo-b",
        projectName: "repo-b",
        gitStatus: createGitStatus({ ahead: 2 }),
      }),
      createProjectStatusResult({
        projectPath: "/tmp/repo-c",
        projectName: "repo-c",
        gitStatus: createGitStatus({ behind: 1, dirty: true }),
      }),
    ]);

    const view = renderWithTooltipProvider(
      <MultiProjectGitStatusIndicator workspaceId="workspace-1" />
    );
    const button = view.getByRole("button", { name: "Open multi-project git status details" });

    expect(button.textContent).toContain("1 unknown");
    expect(button.textContent).toContain("2 diverged");
    expect(button.textContent).toContain("1 dirty");
  });

  test("opens the dialog on click and closes it through dialog dismissal", async () => {
    currentSummary = createSummary([
      createProjectStatusResult({
        projectPath: "/tmp/repo-a",
        projectName: "repo-a",
        gitStatus: createGitStatus({
          branch: "feature/a",
          ahead: 3,
          behind: 1,
          dirty: true,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 4,
          incomingDeletions: 1,
        }),
      }),
    ]);

    const view = renderWithTooltipProvider(
      <MultiProjectGitStatusIndicator workspaceId="workspace-1" />
    );
    const button = view.getByRole("button", { name: "Open multi-project git status details" });
    const body = within(view.container.ownerDocument.body);

    fireEvent.click(button);

    const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
    expect(dialog.textContent).toContain("Multi-project git status");
    expect(dialog.textContent).toContain("repo-a");
    expect(dialog.textContent).toContain("feature/a");
    expect(dialog.textContent).toContain("+5");
    expect(dialog.textContent).toContain("-2");
    expect(dialog.textContent).toContain("Dirty");

    fireEvent.click(body.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(body.queryByRole("dialog")).toBeNull();
    });
  });

  test("shows a loading state when the summary has not arrived yet", async () => {
    currentSummary = null;

    const view = renderWithTooltipProvider(
      <MultiProjectGitStatusIndicator workspaceId="workspace-1" />
    );
    const button = view.getByRole("button", { name: "Open multi-project git status details" });
    expect(button.textContent).toContain("repos…");

    fireEvent.click(button);

    const body = within(view.container.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
    expect(dialog.textContent).toContain("Loading git status for workspace repos…");
  });
});

describe("MultiProjectDivergenceDialog", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders inline unknown row content when a project git status is unavailable", async () => {
    const summary = createSummary([
      createProjectStatusResult({ projectPath: "/tmp/repo-a", projectName: "repo-a" }),
      createProjectStatusResult({
        projectPath: "/tmp/repo-b",
        projectName: "repo-b",
        gitStatus: null,
        error: "Permission denied while reading git status",
      }),
    ]);

    const view = renderWithTooltipProvider(
      <MultiProjectDivergenceDialog
        isOpen={true}
        onOpenChange={() => undefined}
        summary={summary}
        isRefreshing={false}
      />
    );
    const body = within(view.container.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });

    expect(dialog.textContent).toContain("repo-b");
    expect(dialog.textContent).toContain("Permission denied while reading git status");
    expect(dialog.textContent).toContain("repo-a");
  });
});
