import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { APIContext, type APIClient } from "@/browser/contexts/API";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw, type WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  createTestApiClient,
  createTestBashResult,
  type TestExecuteBashResult,
} from "@/browser/testUtils";
import type { AssistedReviewHunk } from "@/common/types/review";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";

import { installDom } from "../../../../../tests/ui/dom";
import { ReviewAssistedStatsReporter } from "./ReviewPanel";

// The reporter runs while the Review panel is closed, so the Review tab badge can count the
// agent-flagged hunks the user has not read yet. It reads the diff itself and reports a count.

const WORKSPACE_ID = "assisted-reporter-workspace";
const PROJECT_PATH = "/repo/project-a";

type ExecuteBashInput = Parameters<APIClient["workspace"]["executeBash"]>[0];

function fileDiff(path: string, hunkStarts: number[], oldPath = path): string {
  const header = [`diff --git a/${oldPath} b/${path}`];
  if (oldPath !== path) header.push(`rename from ${oldPath}`, `rename to ${path}`);
  header.push(`--- a/${oldPath}`, `+++ b/${path}`);
  const hunks = hunkStarts.map(
    (start) => `@@ -${start},1 +${start},1 @@\n-old ${start}\n+new ${start}`
  );
  return [...header, ...hunks].join("\n");
}

function metadataFor(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: WORKSPACE_ID,
    name: "feature",
    projectName: "project-a",
    projectPath: PROJECT_PATH,
    namedWorkspacePath: "/repo/project-a/feature",
    runtimeConfig: { type: "local" },
    ...overrides,
  };
}

let assistedHunksSpy: ReturnType<typeof spyOn<WorkspaceStore, "getAssistedReviewHunks">>;

function renderReporter(params: {
  assisted: AssistedReviewHunk[];
  // Answers the diff command; the origin fetch that precedes it always succeeds.
  diff: (input: ExecuteBashInput) => Promise<TestExecuteBashResult>;
  metadata?: FrontendWorkspaceMetadata;
  isCreating?: boolean;
}) {
  // A stable array keeps the store snapshot stable across renders.
  const assisted = params.assisted;
  assistedHunksSpy.mockImplementation(() => assisted);

  const executeBash = mock((input: ExecuteBashInput) =>
    input.script.includes("git fetch origin")
      ? Promise.resolve(createTestBashResult({ output: "" }))
      : params.diff(input)
  );
  const api = createTestApiClient({ workspace: { executeBash } });
  const counts: number[] = [];
  const onUnreadAssistedChange = mock((count: number) => {
    counts.push(count);
  });
  const workspaceContext = {
    workspaceMetadata: new Map([[WORKSPACE_ID, params.metadata ?? metadataFor()]]),
    loading: false,
    loaded: true,
    loadError: null,
  } as unknown as WorkspaceContextValue;

  render(
    <APIContext.Provider
      value={{
        api,
        status: "connected",
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      <WorkspaceContext.Provider value={workspaceContext}>
        <ReviewAssistedStatsReporter
          workspaceId={WORKSPACE_ID}
          workspacePath="/repo/project-a/feature"
          projectPath={PROJECT_PATH}
          isCreating={params.isCreating}
          onUnreadAssistedChange={onUnreadAssistedChange}
        />
      </WorkspaceContext.Provider>
    </APIContext.Provider>
  );
  const scripts = () => executeBash.mock.calls.map(([input]) => input.script);
  return { executeBash, counts, onUnreadAssistedChange, scripts };
}

describe("ReviewAssistedStatsReporter", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
    // The store derives assisted hunks from review_pane_update tool calls in the transcript; the
    // reporter reads them only through this public getter.
    assistedHunksSpy = spyOn(useWorkspaceStoreRaw(), "getAssistedReviewHunks");
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom();
  });

  test("reports zero without running git when the agent flagged nothing", () => {
    const view = renderReporter({
      assisted: [],
      diff: () => Promise.resolve(createTestBashResult({ output: fileDiff("src/a.ts", [1]) })),
    });
    expect(view.counts).toEqual([0]);
    expect(view.executeBash).not.toHaveBeenCalled();
  });

  test("counts the diff hunks in flagged files after fetching the origin base", async () => {
    const view = renderReporter({
      assisted: [{ path: "src/a.ts" }],
      diff: () =>
        Promise.resolve(
          createTestBashResult({
            output: [fileDiff("src/a.ts", [1, 20]), fileDiff("src/b.ts", [5])].join("\n"),
          })
        ),
    });

    await waitFor(() => expect(view.counts).toEqual([2]));
    // The default base is origin/main, so the branch is fetched (without a credential prompt)
    // before the diff runs against it.
    const [fetchScript, diffScript] = view.scripts();
    expect(fetchScript).toBe("GIT_TERMINAL_PROMPT=0 git fetch origin 'main' --quiet || true");
    expect(diffScript).toContain("origin/main");
    expect(diffScript).toContain("'src/a.ts'");
  });

  test("skips the fetch for a local diff base", async () => {
    updatePersistedState(STORAGE_KEYS.reviewDiffBase(WORKSPACE_ID), "HEAD");
    const view = renderReporter({
      assisted: [{ path: "src/a.ts" }],
      diff: () => Promise.resolve(createTestBashResult({ output: fileDiff("src/a.ts", [1]) })),
    });

    await waitFor(() => expect(view.counts).toEqual([1]));
    expect(view.scripts().some((script) => script.includes("git fetch"))).toBe(false);
  });

  test("does not run git while the workspace is still being created", async () => {
    const view = renderReporter({
      assisted: [{ path: "src/a.ts" }],
      diff: () => Promise.resolve(createTestBashResult({ output: fileDiff("src/a.ts", [1]) })),
      isCreating: true,
    });
    // Let any stray effect work settle before asserting that nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.executeBash).not.toHaveBeenCalled();
    expect(view.counts).toEqual([]);
  });

  test("maps each project's repo-relative diff paths back to workspace paths, renames included", async () => {
    const metadata = metadataFor({
      projects: [
        { projectName: "project-a", projectPath: "/repo/project-a" },
        { projectName: "project-b", projectPath: "/repo/project-b" },
      ],
    });
    const view = renderReporter({
      metadata,
      // The second pin names the file's old path: the rename keeps it flagged.
      assisted: [{ path: "project-b/src/agent.ts" }, { path: "project-a/src/old-name.ts" }],
      diff: (input) =>
        Promise.resolve(
          createTestBashResult({
            output:
              input.options?.repoRootProjectPath === "/repo/project-b"
                ? fileDiff("src/agent.ts", [3])
                : fileDiff("src/new-name.ts", [7, 9], "src/old-name.ts"),
          })
        ),
    });

    await waitFor(() => expect(view.counts).toEqual([3]));
    const diffRoots = view.executeBash.mock.calls
      .filter(([input]) => !input.script.includes("git fetch"))
      .map(([input]) => input.options?.repoRootProjectPath)
      .sort();
    expect(diffRoots).toEqual(["/repo/project-a", "/repo/project-b"]);
  });

  test("ignores the output of a failed diff command, and reports zero when git cannot run", async () => {
    const metadata = metadataFor({
      projects: [
        { projectName: "project-a", projectPath: "/repo/project-a" },
        { projectName: "project-b", projectPath: "/repo/project-b" },
      ],
    });
    const partial = renderReporter({
      metadata,
      assisted: [{ path: "project-a/src/a.ts" }, { path: "project-b/src/b.ts" }],
      diff: (input) =>
        Promise.resolve(
          input.options?.repoRootProjectPath === "/repo/project-b"
            ? // A failed diff can still print part of a diff; none of it may count.
              createTestBashResult({ output: fileDiff("src/b.ts", [1]), exitCode: 1 })
            : createTestBashResult({ output: fileDiff("src/a.ts", [1]) })
        ),
    });
    await waitFor(() => expect(partial.counts).toEqual([1]));
    cleanup();

    const broken = renderReporter({
      assisted: [{ path: "src/a.ts" }],
      diff: () => Promise.reject(new Error("connection lost")),
    });
    await waitFor(() => expect(broken.counts).toEqual([0]));
  });
});
