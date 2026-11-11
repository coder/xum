import * as path from "path";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Runtime } from "@/node/runtime/Runtime";
import type { Config } from "@/node/config";
import {
  listArtifactRecords,
  withPublishedKinds,
  type ArtifactRecord,
} from "@/node/services/artifactRecordStore";
import {
  listArtifactsAtLocation,
  resolveArtifactsLocation,
} from "@/node/services/artifactsOperations";
import {
  checkArtifactLayout,
  isAuditableHtml,
} from "@/node/services/layoutAudit/checkArtifactLayout";
import { layoutAuditLastStartedAtMs } from "@/node/services/layoutAudit/layoutFingerprints";
import { hasNewLayoutIssue } from "@/node/services/layoutAudit/layoutReport";
import type { LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import { log } from "@/node/services/log";
import { sideChatCapabilityGrants } from "@/node/services/sideChat";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";

/**
 * The proactive layout audit (experiment: "artifacts"). Only a publish runs the audit, so a page
 * the agent edits in place (or rewrites from bash, or that a sub-agent changes) would reach the
 * Artifacts tab unchecked, and the user would be the first to see a broken layout. When a turn
 * ends, Xum checks the pages that changed and tells whether the agent has an issue to look at:
 * AIService turns a yes into one constant continuation prompt (LAYOUT_TURN_END_NUDGE).
 */

/** At most this many pages are audited at one turn end, newest first. The rest stay due. */
export const TURN_END_AUDIT_MAX_PAGES = 3;

/** What the audit reads of a workspace's artifacts: the tab's listing, not the files. */
export interface TurnEndArtifactListing {
  entries: ReadonlyArray<Pick<ArtifactEntry, "path" | "kind" | "modifiedMs">>;
  /** The publish records: a page is published when it has one. */
  published: ReadonlyArray<Pick<ArtifactRecord, "path" | "publishedAtMs">>;
}

/**
 * Whether a page modified at `modifiedMs` changed at or after `barMs`. A remote runtime lists
 * modified times in whole seconds (artifactRuntimeStore), and the bar is a host time in
 * milliseconds, so an edit in the same second as the bar would read as older than it. Such a
 * time is compared with the bar cut to its second: the page is audited once more rather than
 * skipped. A local time keeps its milliseconds: it has a whole-second value one time in 1000.
 */
function isModifiedSince(modifiedMs: number, barMs: number): boolean {
  const precisionMs = modifiedMs % 1000 === 0 ? 1000 : 1;
  return modifiedMs >= Math.floor(barMs / precisionMs) * precisionMs;
}

/**
 * The pages that are due for an audit, newest first: published, shown as HTML, and modified at
 * or after their bar. The bar is the start of the last audit that settled the page in this
 * process, else the time of its latest publish (each publish rewrites the record). A publish
 * audits the page after it writes the record, so a publish-time audit is not repeated, and an
 * edit made before the latest publish is the publish's to check.
 *
 * Due is derived, never marked: a page whose audit did not settle it keeps its bar, so the rule
 * alone keeps it due at later turn ends, after a restart and after an eviction from the start
 * times. That covers a page past the cap of one turn end, one whose audit a Stop ended before it
 * settled, and one whose turn-end audit found a new issue: new input or a Stop can win over the
 * continuation that tells the agent, so the page is audited at each turn end until a publish
 * has shown the issue.
 */
export function pagesDueForAudit(
  listing: TurnEndArtifactListing,
  lastAuditStartedAtMs: (relPath: string) => number | undefined
): string[] {
  const publishedAtMs = new Map(
    listing.published.map((record) => [record.path, record.publishedAtMs])
  );
  return listing.entries
    .filter((entry) => {
      const publishedAt = publishedAtMs.get(entry.path);
      return (
        // The publish check's own rule: a page it would not audit never settles, so it must
        // not take one of the turn end's slots.
        isAuditableHtml(entry.kind, entry.path) &&
        publishedAt != null &&
        isModifiedSince(entry.modifiedMs, lastAuditStartedAtMs(entry.path) ?? publishedAt)
      );
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .map((entry) => entry.path);
}

export interface TurnEndLayoutAuditDeps {
  /** A user Stop, or a shutdown: ends the audit, and then nothing is reported. */
  abortSignal: AbortSignal;
  list: () => Promise<TurnEndArtifactListing>;
  lastAuditStartedAtMs: (relPath: string) => number | undefined;
  /** Audits one page and leaves the fix-loop memory as it was. */
  audit: (relPath: string, abortSignal: AbortSignal) => Promise<LayoutAuditReport | undefined>;
}

/**
 * Whether at least one due page has a new layout issue. The pages run at the same time, each
 * with the audit's own budget. Whatever fails (the listing, an audit) counts as no finding: the
 * turn has already ended, and "not checked" is never a reason to wake the agent.
 */
export async function hasNewLayoutIssueAtTurnEnd(deps: TurnEndLayoutAuditDeps): Promise<boolean> {
  let pages: string[];
  try {
    if (deps.abortSignal.aborted) return false;
    pages = pagesDueForAudit(await deps.list(), deps.lastAuditStartedAtMs).slice(
      0,
      TURN_END_AUDIT_MAX_PAGES
    );
  } catch (error) {
    log.debug("turn-end layout audit could not list the artifacts", { error });
    return false;
  }
  const reports = await Promise.allSettled(
    pages.map((relPath) => deps.audit(relPath, deps.abortSignal))
  );
  if (deps.abortSignal.aborted) return false;
  // A width that was not checked proves nothing and starts no continuation by itself, but an
  // issue from a width that completed still counts.
  return reports.some(
    (settled) =>
      settled.status === "fulfilled" && settled.value != null && hasNewLayoutIssue(settled.value)
  );
}

export interface WorkspaceTurnEndLayoutAudit {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata;
  config: Pick<Config, "sessionsDir" | "loadConfigOrDefault">;
  /** The agent's bash runtime and cwd, where a publish audits the page too. */
  runtime: Runtime;
  cwd: string;
  abortSignal: AbortSignal;
}

/**
 * hasNewLayoutIssueAtTurnEnd for a real workspace. It looks nothing up, lists nothing and audits
 * nothing in a side chat, when the workspace has published nothing (most turn ends: no location
 * lookup, which can be an exec on a remote runtime), or when it has no artifacts location. A
 * workspace without agent-browser is not skipped here: the audit itself reports "not checked"
 * within a fraction of a second, and that settles the page.
 */
export async function workspaceHasNewLayoutIssueAtTurnEnd(
  input: WorkspaceTurnEndLayoutAudit
): Promise<boolean> {
  const { workspaceId, metadata, abortSignal } = input;
  // A side chat only reads, so its turn changed no page. Its tools never run the repository's
  // tool_env either (turnRequestBuilder), and this audit must not be the one thing that does.
  if (sideChatCapabilityGrants(metadata) != null) return false;
  const sessionDir = path.join(input.config.sessionsDir, workspaceId);
  const records = await listArtifactRecords(sessionDir);
  if (records.length === 0) return false;
  const location = await resolveArtifactsLocation(input.config.sessionsDir, workspaceId, metadata, {
    abortSignal,
  });
  if (location.kind === "unavailable") return false;
  const trusted = isWorkspaceTrustedForSharedExecution(
    metadata,
    input.config.loadConfigOrDefault().projects
  );
  return hasNewLayoutIssueAtTurnEnd({
    abortSignal,
    list: async () => {
      const listing = await listArtifactsAtLocation(location, abortSignal);
      return {
        entries: withPublishedKinds(listing.entries, records),
        published: records,
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
