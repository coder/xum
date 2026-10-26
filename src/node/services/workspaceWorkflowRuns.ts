import assert from "@/common/utils/assert";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  isActiveWorkflowRunStatus,
  isNestedWorkflowRun,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import * as path from "path";

interface ActiveWorkflowRunIdsOptions {
  /**
   * Install the shared Set for an ARCHIVED workspace too. Only workflow status events need
   * that (so later events accumulate without a disk scan); read paths leave dormant
   * workspaces out of the cache. See resolveActiveWorkflowRunIds.
   */
  installDormant?: boolean;
}

/** An attempt result: an eviction replaced the cache during the attempt's await; retry. */
const EVICTED = Symbol("evicted");

/**
 * The process-local cache of each workspace's active workflow runs, for the activity list and
 * the sidebar. WorkspaceService builds the activity snapshots; this class owns the cache, its
 * lazy disk bootstrap, and the eviction rules that keep a removed workspace's runs from coming
 * back.
 */
export class WorkspaceWorkflowRuns {
  // Lazily bootstrapped workflow activity cache so sidebar refreshes don't rescan run history.
  private readonly activeWorkflowRunIdBootstrapsByWorkspace = new Map<
    string,
    Promise<Set<string>>
  >();
  private readonly activeWorkflowRunIdsByWorkspace = new Map<string, Set<string>>();
  // Workspaces where NONZERO workflow-run activity was actually observed
  // (bootstrap probe, run-status event, or list read). This — not cache
  // presence — is the zero-count tombstone signal: the activity list's own
  // probe installs an (empty) cache for every scoped id, so cache existence
  // would fabricate recency:0 entries for every idle config-known workspace
  // from the second list on, re-bloating the payload this scoping trims.
  private readonly workflowRunSeenWorkspaces = new Set<string>();

  constructor(
    private readonly deps: { config: Pick<Config, "sessionsDir" | "loadConfigOrDefault"> }
  ) {}

  /** The installed (shared) cache of a workspace, if any; never bootstraps. */
  installedActiveWorkflowRunIds(workspaceId: string): ReadonlySet<string> | undefined {
    return this.activeWorkflowRunIdsByWorkspace.get(workspaceId);
  }

  /** Whether a nonzero workflow-run count was observed: see workflowRunSeenWorkspaces. */
  hasSeenWorkflowRuns(workspaceId: string): boolean {
    return this.workflowRunSeenWorkspaces.has(workspaceId);
  }

  /** Ids with an installed cache, for the activity list's fail-open scope. */
  cachedWorkspaceIds(): IterableIterator<string> {
    return this.activeWorkflowRunIdsByWorkspace.keys();
  }

  /** Ids with observed workflow-run activity, for the activity list's fail-open scope. */
  seenWorkspaceIds(): IterableIterator<string> {
    return this.workflowRunSeenWorkspaces.values();
  }

  /** Unarchive: drop the dormant cache so the next read bootstraps from disk. */
  invalidateActiveWorkflowRunIds(workspaceId: string): void {
    // dry-duplicate-ok: the matches (turnRequestBuilder, the message aggregator) only share the
    // shape "delete one key from two maps"; they clear unrelated state and change apart.
    this.activeWorkflowRunIdsByWorkspace.delete(workspaceId);
    this.activeWorkflowRunIdBootstrapsByWorkspace.delete(workspaceId);
  }

  /** Removal (or a tombstone lifted for revival): drop the cache and the seen marker. */
  evictWorkflowRunCaches(workspaceId: string): void {
    this.invalidateActiveWorkflowRunIds(workspaceId);
    this.workflowRunSeenWorkspaces.delete(workspaceId);
  }

  private async populateActiveWorkflowRunIds(
    workspaceId: string,
    activeRunIds: Set<string>
  ): Promise<Set<string>> {
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.deps.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRunStatusSnapshots();
      for (const run of runs) {
        if (
          run.workspaceId === workspaceId &&
          !isNestedWorkflowRun(run) &&
          isActiveWorkflowRunStatus(run.status)
        ) {
          activeRunIds.add(run.id);
        }
      }
    } catch (error) {
      log.debug("Failed to inspect active workflow runs for workspace activity", {
        workspaceId,
        error,
      });
    }
    return activeRunIds;
  }

  async getActiveWorkflowRunIds(
    workspaceId: string,
    options?: ActiveWorkflowRunIdsOptions
  ): Promise<Set<string>> {
    let activeRunIds = await this.resolveActiveWorkflowRunIds(workspaceId, options);
    // Converge on the installed cache: a dormant (archived) read resolves a DETACHED empty
    // Set, and a workflow event can install and populate the shared one in the microtask
    // gap above. Returning the detached copy would let an authoritative list response that
    // lands after the event clear the activity the event just delivered to the renderer.
    // (Same applies to the pathological detached disk probe in resolve's fallback.)
    const installed = this.activeWorkflowRunIdsByWorkspace.get(workspaceId);
    if (installed != null && installed !== activeRunIds) {
      activeRunIds = installed;
    }
    if (
      activeRunIds.size > 0 &&
      // Installation re-check in THIS continuation: an eviction (removal, or
      // a tombstone lifted for revival) can land in the microtask gap after
      // resolve's own final check. A detached set must not repopulate the
      // seen marker — the evicted id's caches are empty, so a stale marker
      // would fabricate zero-count entries for the idle revived workspace.
      this.activeWorkflowRunIdsByWorkspace.get(workspaceId) === activeRunIds
    ) {
      // A list- or event-delivered nonzero count is what makes a later zero
      // meaningful as a tombstone (see workflowRunSeenWorkspaces).
      this.workflowRunSeenWorkspaces.add(workspaceId);
    }
    return activeRunIds;
  }

  private async resolveActiveWorkflowRunIds(
    workspaceId: string,
    options?: ActiveWorkflowRunIdsOptions
  ): Promise<Set<string>> {
    assert(workspaceId.length > 0, "getActiveWorkflowRunIds requires workspaceId");
    // Bounded retry: evictWorkflowRunCaches (removal, or a tombstone
    // lifted for re-registration) can race an in-flight bootstrap. A waiter
    // that captured the pre-eviction Set would otherwise return the removed
    // incarnation's runs — ghost counts with no future terminal event to
    // clear them — so after every await the Set is re-verified as still the
    // installed cache and the read restarts when it was evicted.
    for (let attempt = 0; attempt < 3; attempt++) {
      const activeRunIds = await this.tryResolveActiveWorkflowRunIds(workspaceId, options);
      if (activeRunIds !== EVICTED) {
        return activeRunIds;
      }
    }
    // Eviction churn exhausted the retries (pathological): probe disk once
    // more DETACHED so the caller still gets current durable state without
    // installing a cache that may itself be mid-eviction.
    return this.populateActiveWorkflowRunIds(workspaceId, new Set<string>());
  }

  /** One attempt of resolveActiveWorkflowRunIds; EVICTED when an eviction raced it. */
  private async tryResolveActiveWorkflowRunIds(
    workspaceId: string,
    options?: ActiveWorkflowRunIdsOptions
  ): Promise<Set<string> | typeof EVICTED> {
    const cached = this.activeWorkflowRunIdsByWorkspace.get(workspaceId);
    if (cached != null) {
      return await this.awaitInstalledActiveWorkflowRunIds(workspaceId, cached);
    }

    const workspace = findWorkspaceEntry(
      this.deps.config.loadConfigOrDefault(),
      workspaceId
    )?.workspace;
    // Archived stores are dormant until unarchive invalidates this cache. Live workflow
    // events still update the shared Set without scanning archived session directories,
    // so only the event path installs one: read paths (the activity list walks every
    // config-known id) would otherwise fill this map with an empty Set per archived
    // workspace, thousands on long-lived deployments, that nothing ever reads back.
    // The detached result is provisional: getActiveWorkflowRunIds swaps in the shared
    // Set if an event installed one before the caller's continuation ran.
    if (workspace && isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      const activeRunIds = new Set<string>();
      if (options?.installDormant === true) {
        this.activeWorkflowRunIdsByWorkspace.set(workspaceId, activeRunIds);
      }
      return activeRunIds;
    }

    return await this.bootstrapActiveWorkflowRunIds(workspaceId);
  }

  /** The installed cache, once its bootstrap (if any) settled; EVICTED if it was replaced. */
  private async awaitInstalledActiveWorkflowRunIds(
    workspaceId: string,
    cached: Set<string>
  ): Promise<Set<string> | typeof EVICTED> {
    const bootstrap = this.activeWorkflowRunIdBootstrapsByWorkspace.get(workspaceId);
    if (bootstrap != null) {
      await bootstrap;
    }
    if (this.activeWorkflowRunIdsByWorkspace.get(workspaceId) !== cached) {
      return EVICTED;
    }
    return cached;
  }

  /** Installs the shared cache and fills it from disk; EVICTED if it was replaced meanwhile. */
  private async bootstrapActiveWorkflowRunIds(
    workspaceId: string
  ): Promise<Set<string> | typeof EVICTED> {
    // Install the shared Set before awaiting disk so parallel workflow status events
    // mutate the same cache instead of racing to replace each other after bootstrap.
    const activeRunIds = new Set<string>();
    this.activeWorkflowRunIdsByWorkspace.set(workspaceId, activeRunIds);
    const bootstrap = this.populateActiveWorkflowRunIds(workspaceId, activeRunIds);
    this.activeWorkflowRunIdBootstrapsByWorkspace.set(workspaceId, bootstrap);
    try {
      await bootstrap;
    } finally {
      if (this.activeWorkflowRunIdBootstrapsByWorkspace.get(workspaceId) === bootstrap) {
        this.activeWorkflowRunIdBootstrapsByWorkspace.delete(workspaceId);
      }
    }
    if (this.activeWorkflowRunIdsByWorkspace.get(workspaceId) !== activeRunIds) {
      return EVICTED;
    }
    return activeRunIds;
  }

  async updateActiveWorkflowRunCount(event: {
    workspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
  }): Promise<number> {
    // Bounded retry (same reason as resolveActiveWorkflowRunIds): an
    // eviction can land in the microtask gap after the cache read resolves,
    // so the mutation below would hit a detached incarnation — and must not
    // mark the seen set for an id whose caches were just evicted, or the
    // idle revived workspace emits fabricated zero-count entries forever.
    let detachedSize = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const activeRunIds = await this.getActiveWorkflowRunIds(event.workspaceId, {
        installDormant: true,
      });
      if (isActiveWorkflowRunStatus(event.status)) {
        activeRunIds.add(event.runId);
      } else {
        activeRunIds.delete(event.runId);
      }
      detachedSize = activeRunIds.size;
      if (this.activeWorkflowRunIdsByWorkspace.get(event.workspaceId) !== activeRunIds) {
        continue;
      }
      if (isActiveWorkflowRunStatus(event.status)) {
        this.workflowRunSeenWorkspaces.add(event.workspaceId);
      }
      return activeRunIds.size;
    }
    // Eviction churn exhausted the retries (pathological): report the last
    // detached mutation's size without seen-marking, mirroring the detached
    // disk-probe fallback in resolveActiveWorkflowRunIds.
    return detachedSize;
  }
}
