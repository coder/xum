import type { APIClient } from "@/browser/contexts/API";
import type {
  AgentPluginUpdateCheck,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Bulk plugin update, shared by Settings → Plugins ("Update all") and the "Update All Plugins"
 * palette command, so both decide the same way. The palette path is the section's keyboard path.
 *
 * Each pending update is previewed first. The backend refuses an update that changes a plugin's
 * capability surface unless the user confirmed the reviewed SHAs (installService.update), so a
 * capability-changing update is never applied here: it comes back as a review for the user to
 * confirm one at a time. The batch is not atomic: every plugin is previewed, applied or failed
 * on its own, and a failure never stops the rest.
 */
export interface UpdateAllResult {
  updated: string[];
  /** Capability-changing updates, each waiting for the user's own confirmation. */
  reviews: AgentPluginUpdateReview[];
  failures: Array<{ name: string; error: string }>;
  /** Moved tags are not bulk-applied: tags should be immutable, so each needs a per-plugin review. */
  tagMoved: string[];
  /** An unreachable remote is an unknown state, never "up to date". */
  checkFailures: string[];
}

type StepOutcome =
  | { kind: "updated" }
  | { kind: "review"; review: AgentPluginUpdateReview }
  | { kind: "failed"; error: string };

async function updateOne(api: APIClient, name: string): Promise<StepOutcome> {
  try {
    const preview = await api.agentPlugins.previewUpdate({ name });
    if (!preview.success) return { kind: "failed", error: preview.error };
    if (preview.data.changes.length > 0) return { kind: "review", review: preview.data };
    const result = await api.agentPlugins.update({ name });
    return result.success ? { kind: "updated" } : { kind: "failed", error: result.error };
  } catch (error) {
    return { kind: "failed", error: getErrorMessage(error) };
  }
}

const namesWithStatus = (
  checks: readonly AgentPluginUpdateCheck[],
  status: AgentPluginUpdateCheck["status"]
): string[] => checks.filter((check) => check.status === status).map((check) => check.name);

/**
 * Applies every "update-available" check in order, one plugin at a time (the installer mutates
 * one registry). `onProgress` names the plugin about to be previewed.
 */
export async function updateAllPlugins(
  api: APIClient,
  checks: readonly AgentPluginUpdateCheck[],
  onProgress?: (name: string) => void
): Promise<UpdateAllResult> {
  const result: UpdateAllResult = {
    updated: [],
    reviews: [],
    failures: [],
    tagMoved: namesWithStatus(checks, "tag-moved"),
    checkFailures: namesWithStatus(checks, "error"),
  };
  for (const name of namesWithStatus(checks, "update-available")) {
    onProgress?.(name);
    const outcome = await updateOne(api, name);
    switch (outcome.kind) {
      case "updated":
        result.updated.push(name);
        break;
      case "review":
        result.reviews.push(outcome.review);
        break;
      case "failed":
        result.failures.push({ name, error: outcome.error });
        break;
    }
  }
  return result;
}

export interface UpdateAllSummary {
  tone: "success" | "error";
  message: string;
}

function summaryParts(result: UpdateAllResult): string[] {
  const parts: string[] = [];
  if (result.updated.length > 0) parts.push(`Updated ${result.updated.join(", ")}`);
  if (result.failures.length > 0) {
    parts.push(`Update failed — ${result.failures.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
  }
  if (result.reviews.length > 0) {
    parts.push(`Review needed for ${result.reviews.map((review) => review.name).join(", ")}`);
  }
  if (result.tagMoved.length > 0) {
    parts.push(`Tag moved for ${result.tagMoved.join(", ")} — review in Settings → Plugins`);
  }
  if (result.checkFailures.length > 0) {
    parts.push(`Update check failed for ${result.checkFailures.join(", ")}`);
  }
  return parts;
}

/** A failure, a moved tag or an unreachable remote must never read as a clean success. */
const isUnexpected = (result: UpdateAllResult): boolean =>
  result.failures.length > 0 || result.checkFailures.length > 0 || result.tagMoved.length > 0;

/** The status the section shows and the palette toasts. */
export function summarizeUpdateAll(result: UpdateAllResult): UpdateAllSummary {
  const parts = summaryParts(result);
  if (parts.length === 0) return { tone: "success", message: "All plugins are up to date." };
  return { tone: isUnexpected(result) ? "error" : "success", message: parts.join(". ") };
}
