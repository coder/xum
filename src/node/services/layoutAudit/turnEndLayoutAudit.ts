import * as path from "path";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Runtime } from "@/node/runtime/Runtime";
import type { Config } from "@/node/config";
import { listArtifactRecords, withPublishedKinds } from "@/node/services/artifactRecordStore";
import {
  getWorkspaceArtifactCapabilities,
  listArtifactsAtLocation,
  resolveArtifactsLocation,
} from "@/node/services/artifactsOperations";
import { checkArtifactLayout } from "@/node/services/layoutAudit/checkArtifactLayout";
import { layoutAuditLastStartedAtMs } from "@/node/services/layoutAudit/layoutFingerprints";
import type { LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import { log } from "@/node/services/log";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";

/**
 * The proactive layout audit (experiment: "artifacts"). Only a publish runs the audit, so a page
 * the agent edits in place (or rewrites from bash, or that a sub-agent changes) would reach the
 * Artifacts tab unchecked, and the user would be the first to see a broken layout. When a turn
 * ends, Xum checks the pages that changed and tells whether the agent has an issue to look at:
 * AIService turns a yes into one constant continuation prompt (LAYOUT_TURN_END_NUDGE).
 */

/** At most this many changed pages are audited at one turn end, newest first. */
export const TURN_END_AUDIT_MAX_PAGES = 3;

/** What the audit reads of a workspace's artifacts: the tab's listing, not the files. */
export interface TurnEndArtifactListing {
  entries: ReadonlyArray<Pick<ArtifactEntry, "path" | "kind" | "modifiedMs">>;
  /** Paths that have a publish record. */
  publishedPaths: readonly string[];
}

/**
 * The pages to audit: published, shown as HTML, and changed since their last audit, newest
 * first. "Changed" is one rule: modified at or after the start of the page's last audit that ran
 * to its end, else (after a restart, or before any audit) at or after the start of the ending
 * stream. So a restart audits nothing old, and a publish-time audit is not repeated: it started
 * after the write it covers.
 */
export function pagesChangedSinceAudit(
  listing: TurnEndArtifactListing,
  streamStartedAtMs: number,
  lastAuditStartedAtMs: (relPath: string) => number | undefined
): string[] {
  const published = new Set(listing.publishedPaths);
  return listing.entries
    .filter(
      (entry) =>
        entry.kind === "html" &&
        published.has(entry.path) &&
        entry.modifiedMs >= (lastAuditStartedAtMs(entry.path) ?? streamStartedAtMs)
    )
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, TURN_END_AUDIT_MAX_PAGES)
    .map((entry) => entry.path);
}

/**
 * Only a fully checked page counts, and only an issue that no publish result has listed yet (the
 * report marks one the agent was shown `persistent`). A width that was not checked proves
 * nothing, so it cannot start a continuation.
 */
function hasNewIssue(report: LayoutAuditReport | undefined): boolean {
  return report?.checked === true && report.issues.some((issue) => issue.persistent !== true);
}

export interface TurnEndLayoutAuditDeps {
  /** When the ending stream started (host clock, ms). */
  streamStartedAtMs: number;
  /** A user Stop, or a shutdown: ends the audit, and then nothing is reported. */
  abortSignal: AbortSignal;
  list: () => Promise<TurnEndArtifactListing>;
  lastAuditStartedAtMs: (relPath: string) => number | undefined;
  /** Audits one page and leaves the fix-loop memory as it was. */
  audit: (relPath: string, abortSignal: AbortSignal) => Promise<LayoutAuditReport | undefined>;
}

/**
 * Whether at least one changed page has a new layout issue. The pages run at the same time, each
 * with the audit's own budget. Whatever fails (the listing, an audit) counts as no finding: the
 * turn has already ended, and "not checked" is never a reason to wake the agent.
 */
export async function hasNewLayoutIssueAtTurnEnd(deps: TurnEndLayoutAuditDeps): Promise<boolean> {
  let pages: string[];
  try {
    if (deps.abortSignal.aborted) return false;
    pages = pagesChangedSinceAudit(
      await deps.list(),
      deps.streamStartedAtMs,
      deps.lastAuditStartedAtMs
    );
  } catch (error) {
    log.debug("turn-end layout audit could not list the artifacts", { error });
    return false;
  }
  const reports = await Promise.allSettled(
    pages.map((relPath) => deps.audit(relPath, deps.abortSignal))
  );
  if (deps.abortSignal.aborted) return false;
  return reports.some((settled) => settled.status === "fulfilled" && hasNewIssue(settled.value));
}

export interface WorkspaceTurnEndLayoutAudit {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata;
  config: Pick<Config, "sessionsDir" | "loadConfigOrDefault">;
  /** The agent's bash runtime and cwd, where a publish audits the page too. */
  runtime: Runtime;
  cwd: string;
  streamStartedAtMs: number;
  abortSignal: AbortSignal;
}

/**
 * hasNewLayoutIssueAtTurnEnd for a real workspace. It lists nothing and audits nothing when the
 * workspace has no artifacts location, or when the probe the tab uses says agent-browser is
 * missing (a probe that could not answer does not stop the audit: it reports "not checked").
 */
export async function workspaceHasNewLayoutIssueAtTurnEnd(
  input: WorkspaceTurnEndLayoutAudit
): Promise<boolean> {
  const { workspaceId, metadata, abortSignal } = input;
  const location = await resolveArtifactsLocation(input.config.sessionsDir, workspaceId, metadata, {
    abortSignal,
  });
  if (location.kind === "unavailable") return false;
  const projects = input.config.loadConfigOrDefault().projects;
  const capabilities = await getWorkspaceArtifactCapabilities(workspaceId, metadata, projects);
  if (capabilities.agentBrowserAvailable === false) return false;
  const sessionDir = path.join(input.config.sessionsDir, workspaceId);
  const trusted = isWorkspaceTrustedForSharedExecution(metadata, projects);
  return hasNewLayoutIssueAtTurnEnd({
    streamStartedAtMs: input.streamStartedAtMs,
    abortSignal,
    list: async () => {
      const records = await listArtifactRecords(sessionDir);
      // Nothing is published, so nothing can be audited: skip the listing, which is an exec on a
      // remote runtime.
      if (records.length === 0) return { entries: [], publishedPaths: [] };
      const listing = await listArtifactsAtLocation(location, abortSignal);
      return {
        entries: withPublishedKinds(listing.entries, records),
        publishedPaths: records.map((record) => record.path),
      };
    },
    lastAuditStartedAtMs: (relPath) => layoutAuditLastStartedAtMs(sessionDir, relPath),
    audit: (relPath, signal) =>
      checkArtifactLayout({
        kind: "html",
        runtime: input.runtime,
        cwd: input.cwd,
        trusted,
        location,
        relPath,
        sessionDir,
        abortSignal: signal,
        remember: false,
      }),
  });
}
