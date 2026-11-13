import {
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditNotCheckedReason,
  type LayoutAuditViewport,
} from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";

/** Every reason except "unsettled": that one is a pass that ran, not a width that failed. */
export type FailedReason = Exclude<LayoutAuditNotCheckedReason, "unsettled">;

/**
 * What one width of the audit produced. Only a "complete" outcome may vouch for the page. An
 * "unsettled" pass ran but its page never settled, so its findings are dropped: a false positive
 * costs the agent a fix loop, a miss costs one more publish.
 */
export type ViewportOutcome =
  | {
      viewport: LayoutAuditViewport;
      status: "complete";
      findings: readonly LayoutAuditPageFinding[];
    }
  | { viewport: LayoutAuditViewport; status: "unsettled" }
  | { viewport: LayoutAuditViewport; status: "failed"; reason: FailedReason };

/** One failed outcome per width, in run order: the audit could not run at all. */
export function failedOutcomes(reason: FailedReason): ViewportOutcome[] {
  return LAYOUT_AUDIT_VIEWPORTS.map((viewport) => ({ viewport, status: "failed", reason }));
}
