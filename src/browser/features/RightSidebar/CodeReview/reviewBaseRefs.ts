import type { APIClient } from "@/browser/contexts/API";
import { repoRootBashOptions } from "@/browser/utils/executeBash";
import { shellQuote } from "@/common/utils/shell";

/**
 * Which of `candidates` resolve to a commit in the workspace's repository, in one bash call.
 * Returns null when the check itself fails (no repository, runtime down), so callers can tell
 * "none exist" from "unknown".
 *
 * Review bases used to be suggested and defaulted from a fixed list (`origin/main`, `develop`, …)
 * whether or not those refs existed, so a repo without an `origin` remote opened Review on a raw
 * `git` error (#5682).
 */
export async function listExistingRevisions(
  api: APIClient,
  workspaceId: string,
  candidates: readonly string[]
): Promise<Set<string> | null> {
  if (candidates.length === 0) return new Set();
  const checks = candidates.map(
    (candidate) =>
      `git rev-parse --verify --quiet ${shellQuote(`${candidate}^{commit}`)} >/dev/null && printf '%s\\n' ${shellQuote(candidate)}`
  );
  let result: Awaited<ReturnType<APIClient["workspace"]["executeBash"]>>;
  try {
    result = await api.workspace.executeBash({
      workspaceId,
      // `; true`: a missing last candidate must not turn the whole check into a failure.
      script: `${checks.join("; ")}; true`,
      options: repoRootBashOptions(10),
    });
  } catch {
    return null;
  }
  if (!result.success || !result.data.success) return null;
  const found = new Set(
    result.data.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  // The script only ever prints candidates; anything else means the script is wrong.
  for (const ref of found) {
    if (!candidates.includes(ref)) throw new Error(`Unexpected revision in output: ${ref}`);
  }
  return found;
}
