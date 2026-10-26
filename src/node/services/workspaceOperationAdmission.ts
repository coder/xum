/**
 * Archive admission of the renderer-initiated operations that are not sends: bash exec,
 * attachment staging, file-completion refreshes, forks, refine applies and MCP prompt
 * discoveries.
 *
 * Moved out of WorkspaceService without logic changes. WorkspaceService still runs each entry
 * guard and calls acquire() in the same synchronous block, and its archive, interrupt and
 * restart gates read the counts here. It keeps acquireMcpPromptDiscoveryAdmission() as a
 * public facade.
 */
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { PreflightCounter } from "@/node/services/preflightCounter";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceLifecycleGates } from "@/node/services/workspaceLifecycleGates";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

// Removal's join of MCP prompt discoveries it aborted (#4805); see abortAndJoinMcpPromptDiscoveries.
const MCP_PROMPT_DISCOVERY_JOIN_TIMEOUT_MS = 10_000;

export interface WorkspaceOperationAdmissionDeps {
  readonly config: Pick<Config, "loadConfigOrDefault">;
  /** The shared gates WorkspaceService sets around archive() and remove(). */
  readonly gates: WorkspaceLifecycleGates;
}

export class WorkspaceOperationAdmission {
  // In-flight renderer executeBash requests per workspace. Incremented in the same
  // synchronous block as executeBash's archivingWorkspaces check (mirroring
  // SendPreflight.sends) so archive admission and bash execution always observe each other:
  // an exec admitted first holds the archive gate open for its full duration, and an exec
  // entering after the gate armed is refused at entry.
  readonly exec = new PreflightCounter();
  // Same pairing for renderer attachment staging (writes into the checkout an archive may
  // capture/remove) and file-completion refreshes (run git through a runtime that could
  // re-wake a stopped Coder workspace). See PreflightCounter.acquire.
  readonly staging = new PreflightCounter();
  readonly fileCompletion = new PreflightCounter();
  // Same pairing for renderer MCP prompt discovery (workspace.mcp.prompts.list): it readies the
  // runtime (which can re-wake a stopped Coder workspace) and starts cached stdio servers inside
  // the checkout. See acquireMcpPromptDiscoveryAdmission. Each admitted discovery carries an
  // abort controller and a settlement so a removal can stop and join it (#4805).
  private readonly mcpPromptDiscoveries = new Map<
    string,
    Set<{ controller: AbortController; settled: Promise<void>; settle: () => void }>
  >();
  /**
   * In-flight forks counted per SOURCE workspace. A fork clones the source checkout and (for
   * SSH/Coder runtimes) shares its remote workspace, so a model-driven archive admitted
   * mid-fork could stop or snapshot the environment under the clone. Pairs with the archive
   * gates like the other preflight counters: a fork admitted first is visible to the sink
   * and the pre-interruption hold; one entering later observes archivingWorkspaces.
   */
  readonly fork = new PreflightCounter();
  /**
   * Held refine turn exclusions (acquireIdleTurnExclusion), per workspace. A /refine apply
   * writes approved skills into the checkout under it (#4965), so the archive gates count it
   * like the other preflight counters.
   */
  readonly refine = new PreflightCounter();

  constructor(private readonly deps: WorkspaceOperationAdmissionDeps) {}

  /**
   * Archive admission pairing for MCP prompt discovery (workspace.mcp.prompts.list), which
   * readies the runtime and starts cached stdio servers outside any stream. The guard check and
   * the counter increment run in one synchronous block, mirroring executeBash: a discovery
   * admitted first holds the archive gate open until the caller disposes the admission, and one
   * entering after the gate armed (or against an archived workspace) is refused with undefined.
   *
   * Removal refuses new discoveries too (#4760), and aborts and joins the ones admitted before
   * it started (#4805): the discovery must run under the returned signal.
   */
  acquireMcpPromptDiscoveryAdmission(
    workspaceId: string
  ): (Disposable & { signal: AbortSignal }) | undefined {
    if (this.refusesMcpPromptDiscovery(workspaceId)) {
      return undefined;
    }
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    const discovery = { controller: new AbortController(), settled, settle };
    let admitted = this.mcpPromptDiscoveries.get(workspaceId);
    if (admitted === undefined) {
      admitted = new Set();
      this.mcpPromptDiscoveries.set(workspaceId, admitted);
    }
    admitted.add(discovery);
    return {
      signal: discovery.controller.signal,
      [Symbol.dispose]: () => {
        const current = this.mcpPromptDiscoveries.get(workspaceId);
        current?.delete(discovery);
        if (current?.size === 0) this.mcpPromptDiscoveries.delete(workspaceId);
        discovery.settle();
      },
    };
  }

  /** True while the workspace is being archived or removed, or is archived. */
  private refusesMcpPromptDiscovery(workspaceId: string): boolean {
    if (this.deps.gates.archiving.has(workspaceId) || this.deps.gates.removing.has(workspaceId)) {
      return true;
    }
    const workspaceEntry = findWorkspaceEntry(this.deps.config.loadConfigOrDefault(), workspaceId);
    return (
      workspaceEntry != null &&
      isWorkspaceArchived(
        workspaceEntry.workspace.archivedAt,
        workspaceEntry.workspace.unarchivedAt
      )
    );
  }

  /**
   * #4805: a discovery admitted before a removal started can still publish stdio servers into
   * the checkout. Abort each one and wait for it to settle, so anything it published exists
   * before removal's stopServers runs. Bounded like the stream stop: a discovery that ignores
   * its abort must not pin the removal, so the removal logs and proceeds.
   */
  async abortAndJoinMcpPromptDiscoveries(workspaceId: string): Promise<void> {
    const admitted = [...(this.mcpPromptDiscoveries.get(workspaceId) ?? [])];
    if (admitted.length === 0) return;
    for (const discovery of admitted) discovery.controller.abort();
    const joined = await raceWithAbortAndTimeout(
      Promise.all(admitted.map((discovery) => discovery.settled)),
      { timeoutMs: MCP_PROMPT_DISCOVERY_JOIN_TIMEOUT_MS }
    );
    if (joined.kind !== "ok") {
      log.warn("Workspace removal: an admitted MCP prompt discovery did not settle after abort", {
        workspaceId,
        pending: admitted.length,
      });
    }
  }

  /**
   * Labels for the counted in-flight operations (bash exec, attachment staging, file
   * completion, fork, MCP prompt discovery, refine) that archive and interrupt gates
   * refuse on, in a fixed order so both gates report them alike.
   */
  inFlightOperationLabels(workspaceId: string): string[] {
    const counts: Array<[count: number, label: string]> = [
      [this.exec.count(workspaceId), "a bash command executing"],
      [this.staging.count(workspaceId), "an attachment transfer in progress"],
      [this.fileCompletion.count(workspaceId), "a file completion refresh in progress"],
      [this.fork.count(workspaceId), "a fork of this workspace in progress"],
      [
        this.mcpPromptDiscoveries.get(workspaceId)?.size ?? 0,
        "an MCP prompt discovery in progress",
      ],
      [this.refine.count(workspaceId), "a refine apply or publication in progress"],
    ];
    return counts.filter(([count]) => count > 0).map(([, label]) => label);
  }
}
