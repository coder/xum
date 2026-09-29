import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";

import { buildFileTree } from "@/common/utils/git/numstatParser";
import {
  FILE_TREE_EXPAND_STATE_MAX_CHARS,
  getFileTreeExpandStateKey,
} from "@/common/constants/storage";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { FileTree } from "./FileTree";

describe("FileTree expansion state", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps every expanded directory open while persisting only what fits the budget", () => {
    // Third-level directories start collapsed, so opening each one stores an override. Together
    // they are far over the key budget.
    const dirCount = 30;
    const dirs = Array.from({ length: dirCount }, (_, i) => `module-directory-${i}`);
    const root = buildFileTree(
      dirs.map((dir, i) => ({
        filePath: `src/features/${dir}/file-${i}.ts`,
        additions: 1,
        deletions: 0,
      }))
    );
    const workspaceId = "filetree01";
    const view = render(
      <TooltipProvider>
        <FileTree
          root={root}
          selectedPath={null}
          onSelectFile={() => undefined}
          workspaceId={workspaceId}
        />
      </TooltipProvider>
    );

    for (const dir of dirs) {
      const row = view.getByText(dir).parentElement!;
      fireEvent.click(row.querySelector("[data-toggle]")!);
    }

    // Trimming the live map made the oldest directories collapse again on their own.
    for (let i = 0; i < dirCount; i++) {
      expect(view.queryByText(`file-${i}.ts`)).not.toBeNull();
    }
    const stored = window.localStorage.getItem(getFileTreeExpandStateKey(workspaceId))!;
    expect(stored.length).toBeLessThanOrEqual(FILE_TREE_EXPAND_STATE_MAX_CHARS);
    // The persisted copy keeps the newest overrides, so a reload restores the latest expansions.
    expect(JSON.parse(stored)).toMatchObject({ [`src/features/${dirs[dirCount - 1]}`]: true });
  });
});
