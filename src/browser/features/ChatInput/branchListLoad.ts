import type { BranchListResult } from "@/common/orpc/types";

/**
 * Where a creation view's branch list stands. "failed" (the list rejected, or had not settled
 * within BRANCH_LIST_TIMEOUT_MS) is not "loaded with no branches": a failed list must not make a
 * git project look like a non-git one, which would silently switch the runtime to Local (#6055).
 */
export type BranchLoadStatus = "loading" | "loaded" | "failed";

/** How long a creation view waits for its branch list before it reports the load as failed. */
export const BRANCH_LIST_TIMEOUT_MS = 15_000;

export type BranchListLoadOutcome =
  | {
      status: "loaded";
      branches: string[];
      recommendedTrunk: string | null;
      /** The repository's default branch; null when the backend does not know it. */
      defaultBranch: string | null;
      /** The branches committed to most recently; empty when the backend names none. */
      recentBranches: string[];
    }
  | { status: "failed" };

/** A loaded list with its optional fields filled in, so callers need not default them. */
function loadedOutcome(result: BranchListResult): BranchListLoadOutcome {
  return {
    status: "loaded",
    branches: result.branches,
    recommendedTrunk: result.recommendedTrunk,
    defaultBranch: result.defaultBranch ?? null,
    recentBranches: result.recentBranches ?? [],
  };
}

/**
 * Starts one branch-list load and reports its outcome. It reports "failed" when the list rejects
 * or has not settled within `timeoutMs`; a list that settles after that still reports "loaded",
 * so a slow list recovers. Returns a cancel function: no outcome is reported after it runs.
 */
export function startBranchListLoad(
  load: () => Promise<BranchListResult>,
  onOutcome: (outcome: BranchListLoadOutcome) => void,
  timeoutMs: number = BRANCH_LIST_TIMEOUT_MS
): () => void {
  let active = true;
  const timer = setTimeout(() => {
    if (active) onOutcome({ status: "failed" });
  }, timeoutMs);
  load().then(
    (result) => {
      clearTimeout(timer);
      if (active) onOutcome(loadedOutcome(result));
    },
    (error: unknown) => {
      clearTimeout(timer);
      console.error("Failed to load branches:", error);
      if (active) onOutcome({ status: "failed" });
    }
  );
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
