import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { PRLinkBadge } from "@/browser/components/PRLinkBadge/PRLinkBadge";
import type { GitHubPRLinkWithStatus } from "@/common/types/links";

// Mirrors the story's PRStatusBadges gallery: a single badge per common PR state
// rendered in the same bordered "links dropdown"-style container the story uses.
// PRLinkBadge only needs theme + tooltip from the shell.
const PR_LINK: GitHubPRLinkWithStatus = {
  type: "github-pr",
  url: "https://github.com/coder/mux/pull/1623",
  owner: "coder",
  repo: "mux",
  number: 1623,
  detectedAt: 1_700_000_000_000,
  occurrenceCount: 1,
  status: {
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    title: "feat: add first-class link support",
    isDraft: false,
    headRefName: "feature/links",
    baseRefName: "main",
    fetchedAt: 1_700_000_000_000,
  },
};

export const ReadyToMerge = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-2">
        <PRLinkBadge prLink={PR_LINK} />
      </div>
    </div>
  </MuxPreviewShell>
);
