import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";

import { buildFileTree } from "@/common/utils/git/numstatParser";
import {
  FILE_TREE_EXPAND_STATE_MAX_CHARS,
  getFileTreeExpandStateKey,
} from "@/common/constants/storage";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
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

  test("follows another window's expansion changes after a local toggle", () => {
    const dirs = ["module-directory-0", "module-directory-1"];
    const root = buildFileTree(
      dirs.map((dir, i) => ({
        filePath: `src/features/${dir}/file-${i}.ts`,
        additions: 1,
        deletions: 0,
      }))
    );
    const workspaceId = "filetree02";
    const key = getFileTreeExpandStateKey(workspaceId);
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
    fireEvent.click(view.getByText(dirs[0]).parentElement!.querySelector("[data-toggle]")!);
    expect(view.queryByText("file-0.ts")).not.toBeNull();

    // Another window of the same workspace replaces the stored overrides. (Its storage event
    // reaches listener hooks like this external update does; the module installs its storage
    // listener on the first test window only, so a StorageEvent cannot be used here.)
    act(() => {
      updatePersistedState(key, { [`src/features/${dirs[1]}`]: true });
    });

    // The local live copy must not mask the newer stored state.
    expect(view.queryByText("file-1.ts")).not.toBeNull();
    expect(view.queryByText("file-0.ts")).toBeNull();
  });
});
