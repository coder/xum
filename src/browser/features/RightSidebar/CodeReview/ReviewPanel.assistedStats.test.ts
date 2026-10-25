import { describe, expect, test } from "bun:test";

import type { AssistedReviewHunk, DiffHunk } from "@/common/types/review";
import { normalizeAssistedReviewHunks } from "@/common/utils/review/assistedReview";
import {
  buildReviewDiffPathFilterSpecs,
  countUnreadAssistedHunks,
  getEffectiveReviewFrontendFilters,
  getEffectiveReviewIncludeUncommitted,
  getReviewPanelPathContext,
} from "./ReviewPanel";

function hunk(overrides: Partial<DiffHunk>): DiffHunk {
  return {
    id: overrides.id ?? "h1",
    filePath: overrides.filePath ?? "src/file.ts",
    oldStart: overrides.oldStart ?? 1,
    oldLines: overrides.oldLines ?? 3,
    newStart: overrides.newStart ?? 1,
    newLines: overrides.newLines ?? 3,
    content: overrides.content ?? " line\n+change",
    header: overrides.header ?? "@@ -1,3 +1,3 @@",
    changeType: overrides.changeType,
    oldPath: overrides.oldPath,
  };
}

describe("countUnreadAssistedHunks", () => {
  test("counts only matched assisted hunks that are not read", () => {
    const hunks = [
      hunk({ id: "unread-match", filePath: "src/a.ts", newStart: 10, newLines: 5 }),
      hunk({ id: "read-match", filePath: "src/a.ts", newStart: 30, newLines: 5 }),
      hunk({ id: "unmatched", filePath: "src/b.ts", newStart: 10, newLines: 5 }),
    ];
    const assisted: AssistedReviewHunk[] = [{ path: "src/a.ts" }];

    const count = countUnreadAssistedHunks(hunks, assisted, (id) => id === "read-match");

    expect(count).toBe(1);
  });

  test("range filters count only overlapping new-side hunks", () => {
    const hunks = [
      hunk({ id: "before", filePath: "src/a.ts", newStart: 1, newLines: 3 }),
      hunk({ id: "overlap", filePath: "src/a.ts", newStart: 9, newLines: 3 }),
      hunk({ id: "after", filePath: "src/a.ts", newStart: 20, newLines: 3 }),
    ];
    const assisted: AssistedReviewHunk[] = [{ path: "src/a.ts", range: { start: 10, end: 12 } }];

    expect(countUnreadAssistedHunks(hunks, assisted, () => false)).toBe(1);
  });
});

describe("getReviewPanelPathContext", () => {
  test("keeps primary project-relative pins while matching cwd-relative fallbacks", () => {
    const pathContext = getReviewPanelPathContext({
      workspaceMetadata: {
        projectPath: "/repo/app",
        subProjectPath: "/repo/app/packages/api",
      },
      projectPath: "/repo/app",
    });
    expect(pathContext).toEqual({
      projectPath: "/repo/app",
      executionRootPath: "/repo/app/packages/api",
    });
    const assisted = normalizeAssistedReviewHunks(
      [
        { path: "src/agent.ts", range: { start: 2, end: 4 }, comment: "ambiguous" },
        { path: "packages/api/src/already-rooted.ts", comment: "project-relative" },
      ],
      pathContext
    );

    expect(assisted).toEqual([
      { path: "src/agent.ts", range: { start: 2, end: 4 }, comment: "ambiguous" },
      { path: "packages/api/src/already-rooted.ts", comment: "project-relative" },
    ]);
    expect(
      countUnreadAssistedHunks(
        [hunk({ id: "match", filePath: "packages/api/src/agent.ts", newStart: 3 })],
        assisted,
        () => false,
        pathContext
      )
    ).toBe(1);
  });
});

describe("buildReviewDiffPathFilterSpecs single-project", () => {
  function singleProjectPathFilter(
    params: Omit<Parameters<typeof buildReviewDiffPathFilterSpecs>[0], "projectPath">
  ): string {
    const specs = buildReviewDiffPathFilterSpecs({ ...params, projectPath: "/repo" });
    expect(specs).toHaveLength(1);
    return specs[0].pathFilter;
  }

  test("assisted mode fetches agent-pinned files instead of the stale selected file", () => {
    const pathFilter = singleProjectPathFilter({
      isImmersive: false,
      assistedOnly: true,
      assistedHunks: [
        { path: "src/agent.ts" },
        { path: "src/agent.ts", range: { start: 3, end: 4 } },
      ],
      selectedFilePath: "src/user-selected.ts",
      selectedDiffPath: "src/user-selected.ts",
      workspaceMetadata: null,
    });

    expect(pathFilter).toBe(" -- 'src/agent.ts'");
  });

  test("non-assisted mode preserves the selected file pathspec", () => {
    const pathFilter = singleProjectPathFilter({
      isImmersive: false,
      assistedOnly: false,
      assistedHunks: [{ path: "src/agent.ts" }],
      selectedFilePath: "src/user-selected.ts",
      selectedDiffPath: "src/user-selected.ts",
      workspaceMetadata: null,
    });

    expect(pathFilter).toBe(" -- 'src/user-selected.ts'");
  });
});

describe("buildReviewDiffPathFilterSpecs", () => {
  const workspaceMetadata = {
    projects: [
      { projectName: "project-a", projectPath: "/repo/project-a" },
      { projectName: "project-b", projectPath: "/repo/project-b" },
    ],
  };

  test("assisted mode roots each multi-project pathspec in the pinned file's repository", () => {
    const specs = buildReviewDiffPathFilterSpecs({
      isImmersive: false,
      assistedOnly: true,
      assistedHunks: [{ path: "project-b/src/agent.ts" }, { path: "project-a/src/main.ts" }],
      selectedFilePath: "project-b/src/stale-selection.ts",
      selectedDiffPath: "src/stale-selection.ts",
      selectedRepoRootProjectPath: "/repo/project-b",
      workspaceMetadata,
      projectPath: "/repo/project-a",
    });

    expect(specs).toEqual([
      {
        repoRootProjectPath: "/repo/project-b",
        pathFilter: " -- 'src/agent.ts'",
        selectedFilePath: "src/agent.ts",
      },
      {
        repoRootProjectPath: "/repo/project-a",
        pathFilter: " -- 'src/main.ts'",
        selectedFilePath: "src/main.ts",
      },
    ]);
  });

  test("assisted mode fetches primary paths plus execution-root fallbacks", () => {
    const specs = buildReviewDiffPathFilterSpecs({
      isImmersive: false,
      assistedOnly: true,
      assistedHunks: [{ path: "src/agent.ts" }, { path: "README.md" }],
      selectedFilePath: null,
      selectedDiffPath: "",
      workspaceMetadata: null,
      projectPath: "/repo/app",
      pathContext: {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      },
    });

    expect(specs).toEqual([
      {
        repoRootProjectPath: "/repo/app",
        pathFilter: " -- 'src/agent.ts' 'packages/api/src/agent.ts' 'README.md'",
        selectedFilePath: "src/agent.ts",
      },
    ]);
  });

  test("non-assisted mode keeps selected file rooting for truncation recovery", () => {
    const specs = buildReviewDiffPathFilterSpecs({
      isImmersive: false,
      assistedOnly: false,
      assistedHunks: [{ path: "project-a/src/main.ts" }],
      selectedFilePath: "project-b/src/user-selected.ts",
      selectedDiffPath: "src/user-selected.ts",
      selectedRepoRootProjectPath: "/repo/project-b",
      workspaceMetadata,
      projectPath: "/repo/project-a",
    });

    expect(specs).toEqual([
      {
        repoRootProjectPath: "/repo/project-b",
        pathFilter: " -- 'src/user-selected.ts'",
        selectedFilePath: "project-b/src/user-selected.ts",
      },
    ]);
  });
});

describe("getEffectiveReviewIncludeUncommitted", () => {
  test("assisted mode includes working-tree edits even when the user toggle is off", () => {
    expect(
      getEffectiveReviewIncludeUncommitted({ assistedOnly: true, includeUncommitted: false })
    ).toBe(true);
  });

  test("non-assisted mode keeps the user include-uncommitted toggle", () => {
    expect(
      getEffectiveReviewIncludeUncommitted({ assistedOnly: false, includeUncommitted: false })
    ).toBe(false);
  });
});

describe("getEffectiveReviewFrontendFilters", () => {
  test("assisted mode honors the user search term", () => {
    // Previously the assisted-only branch wiped the search term so a pin
    // couldn't be hidden by stale state. That clobbered legitimate
    // narrowing — we now leave the user's query alone in both modes.
    expect(
      getEffectiveReviewFrontendFilters({
        assistedOnly: true,
        showReadHunks: false,
        assistedShowReadHunks: false,
        searchTerm: "needle",
      })
    ).toEqual({ showReadHunks: false, searchTerm: "needle" });
  });

  test("assisted mode uses assistedShowReadHunks for the read filter", () => {
    // Marking a pin as read should clear it from the worklist by default,
    // so the assisted-scoped flag drives this decision instead of the
    // global "showReadHunks" preference. The user's general preference is
    // intentionally ignored here.
    expect(
      getEffectiveReviewFrontendFilters({
        assistedOnly: true,
        showReadHunks: true, // user prefers showing read globally
        assistedShowReadHunks: false, // worklist default: hide read pins
        searchTerm: "",
      })
    ).toEqual({ showReadHunks: false, searchTerm: "" });

    expect(
      getEffectiveReviewFrontendFilters({
        assistedOnly: true,
        showReadHunks: false, // user prefers hiding read globally
        assistedShowReadHunks: true, // explicit "show read" in worklist mode
        searchTerm: "",
      })
    ).toEqual({ showReadHunks: true, searchTerm: "" });
  });

  test("non-assisted mode keeps user filters and ignores assistedShowReadHunks", () => {
    expect(
      getEffectiveReviewFrontendFilters({
        assistedOnly: false,
        showReadHunks: false,
        assistedShowReadHunks: true, // ignored outside Assisted mode
        searchTerm: "needle",
      })
    ).toEqual({ showReadHunks: false, searchTerm: "needle" });
  });
});
