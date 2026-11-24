import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { BranchSelector } from "@/browser/components/BranchSelector/BranchSelector";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createLRUCache } from "@/browser/utils/lruCache";
import {
  BRANCH_CACHE_ENTRY_PREFIX,
  BRANCH_CACHE_INDEX_KEY,
  BRANCH_CACHE_MAX_ENTRIES,
} from "@/common/constants/storage";

// Footer branch chip — isolated version of the CopyBranchNameWithoutHover story (which renders
// the whole app). The selector seeds its branch from the localStorage branch cache, so the preview
// writes that cache entry instead of running the app's git-status poller. The story checks that
// the copy button is fully visible on coarse (touch) pointers; headless/mouse previews have no
// coarse pointer, so the preview forces that visible state with a scoped style.

const WORKSPACE_ID = "branch-copy-1";
const BRANCH = "feature/copy-branch";

// Same cache options as BranchSelector.tsx. Writing through the LRU cache (persisted-state
// helpers) keeps its index and subscribers in sync instead of leaving an untracked entry
// in the gallery's shared storage.
const branchCache = createLRUCache<string>({
  entryPrefix: BRANCH_CACHE_ENTRY_PREFIX,
  indexKey: BRANCH_CACHE_INDEX_KEY,
  maxEntries: BRANCH_CACHE_MAX_ENTRIES,
});

function seedBranchCache() {
  branchCache.set(WORKSPACE_ID, BRANCH);
}

// Answers the popover's git probes so opening it lists branches (main + the current one).
const client = createMockORPCClient({
  executeBash: async (_workspaceId: string, script: string) => {
    let output = "";
    if (script.includes("rev-parse --is-inside-work-tree")) output = "true";
    else if (script.includes("--show-current")) output = BRANCH;
    else if (script.includes("git branch --sort"))
      output = `${BRANCH}\nmain\nfix/settings-validation`;
    else if (script.includes("git remote")) output = "origin";
    return { success: true as const, output, exitCode: 0, wall_duration_ms: 1 };
  },
});

export const CopyBranchNameWithoutHover = () => {
  seedBranchCache();
  return (
    <MuxPreviewShell client={client}>
      <style>{`.ds-branch-touch [aria-label="Copy branch name"]{opacity:1!important}`}</style>
      <div className="bg-background text-foreground ds-branch-touch p-6">
        <div className="border-border flex items-center rounded border px-2 py-1">
          <BranchSelector workspaceId={WORKSPACE_ID} workspaceName={BRANCH} />
        </div>
      </div>
    </MuxPreviewShell>
  );
};
