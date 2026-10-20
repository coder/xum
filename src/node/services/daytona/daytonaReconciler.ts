import type { Workspace } from "@/common/types/project";
import { isSSHRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { DaytonaSandbox } from "./daytonaClient";
import { mapDaytonaSandboxState, type DaytonaService } from "./daytonaService";

export const DAYTONA_RECONCILE_INTERVAL_MS = 60_000;
/** Each control-plane call gets this long; a hung call is logged and the sweep moves on. */
export const DAYTONA_RECONCILE_CALL_TIMEOUT_MS = 20_000;

export interface DaytonaWorkspaceRef {
  workspaceId: string;
  runtimeConfig: RuntimeConfig | undefined;
}

export interface DaytonaReconcilerOptions {
  daytonaService: Pick<
    DaytonaService,
    | "checkAvailability"
    | "listInstanceSandboxes"
    | "refreshActivity"
    | "stopSandbox"
    | "hasExpiringSshToken"
    | "ensureSshAccess"
  >;
  /** Every workspace Xum knows, archived ones included (they still own their sandbox). */
  listWorkspaces: () => DaytonaWorkspaceRef[];
  /** Streaming, or running a background job: Daytona counts only SSH and API traffic. */
  isWorkspaceActive: (workspaceId: string) => boolean;
  intervalMs?: number;
  callTimeoutMs?: number;
}

/**
 * Every workspace in the config, archived ones included: an archived workspace still owns its
 * (stopped) sandbox and unarchiving must find it, so the orphan sweep must not touch it.
 */
export function listDaytonaWorkspaceRefs(config: {
  projects: ReadonlyMap<
    string,
    { workspaces: ReadonlyArray<Pick<Workspace, "id" | "runtimeConfig">> }
  >;
}): DaytonaWorkspaceRef[] {
  const refs: DaytonaWorkspaceRef[] = [];
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (workspace.id)
        refs.push({ workspaceId: workspace.id, runtimeConfig: workspace.runtimeConfig });
    }
  }
  return refs;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One sweep a minute, safe to repeat, that keeps Daytona sandboxes in line with Xum:
 * - keepalive: refresh activity for sandboxes whose workspace is streaming or running a
 *   background job, so Daytona's 30-minute auto-stop does not cut off long agent work;
 * - token refresh: replace an active workspace's ssh token before it expires;
 * - orphans: STOP (never delete) started sandboxes labeled with this install's `xum.instance`
 *   that no workspace references. Deleting would lose work without a dirty check, and a
 *   stopped sandbox costs only storage.
 * The first sweep runs one interval after start: startup never waits on the control plane.
 */
export class DaytonaReconciler {
  private readonly options: DaytonaReconcilerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | undefined;

  constructor(options: DaytonaReconcilerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = this.sweep()
        .catch((error: unknown) => {
          log.warn("Daytona reconcile sweep failed", { error: getErrorMessage(error) });
        })
        .finally(() => {
          this.sweeping = undefined;
        });
    }, this.options.intervalMs ?? DAYTONA_RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<void> {
    const service = this.options.daytonaService;
    // No credentials: no Daytona workspaces can be reached, and nothing to reconcile.
    if (!(await service.checkAvailability()).available) return;

    const refs = this.collectReferences();
    let sandboxes: DaytonaSandbox[] | undefined;
    try {
      sandboxes = await this.call(service.listInstanceSandboxes(), "listing Daytona sandboxes");
    } catch (error) {
      // Keepalive still runs from config alone; orphans wait for the next sweep.
      log.warn("Daytona reconcile: could not list sandboxes", { error: getErrorMessage(error) });
    }

    for (const ref of refs) {
      if (!this.options.isWorkspaceActive(ref.workspaceId)) continue;
      await this.keepAlive(ref.sandboxId, sandboxes);
    }
    if (sandboxes) {
      await this.stopOrphans(sandboxes, refs);
    }
  }

  private collectReferences(): Array<{ workspaceId: string; sandboxId: string }> {
    const refs: Array<{ workspaceId: string; sandboxId: string }> = [];
    for (const workspace of this.options.listWorkspaces()) {
      const config = workspace.runtimeConfig;
      const sandboxId = isSSHRuntime(config) ? config.daytona?.sandboxId?.trim() : undefined;
      if (sandboxId) refs.push({ workspaceId: workspace.workspaceId, sandboxId });
    }
    return refs;
  }

  private async keepAlive(sandboxId: string, sandboxes: DaytonaSandbox[] | undefined) {
    const service = this.options.daytonaService;
    // Xum stores a name for sandboxes it created; last-activity only takes the real id.
    const listed = sandboxes?.find((sb) => sb.id === sandboxId || sb.name === sandboxId);
    try {
      await this.call(service.refreshActivity(listed?.id ?? sandboxId), "refreshing activity");
    } catch (error) {
      log.warn("Daytona reconcile: activity refresh failed", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
    if (!service.hasExpiringSshToken(sandboxId)) return;
    try {
      await this.call(service.ensureSshAccess(sandboxId), "refreshing the ssh token");
    } catch (error) {
      log.warn("Daytona reconcile: ssh token refresh failed", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
  }

  private async stopOrphans(
    sandboxes: DaytonaSandbox[],
    refs: Array<{ sandboxId: string }>
  ): Promise<void> {
    const referenced = new Set(refs.map((ref) => ref.sandboxId));
    for (const sandbox of sandboxes) {
      if (referenced.has(sandbox.id) || (sandbox.name && referenced.has(sandbox.name))) continue;
      // Only settled, running boxes: a starting one may belong to a creation in flight.
      if (mapDaytonaSandboxState(sandbox.state) !== "started") continue;
      log.info("Daytona reconcile: stopping an unreferenced sandbox", { sandboxId: sandbox.id });
      try {
        await this.call(
          this.options.daytonaService.stopSandbox(sandbox.id),
          "stopping an orphaned sandbox"
        );
      } catch (error) {
        log.warn("Daytona reconcile: could not stop an orphaned sandbox", {
          sandboxId: sandbox.id,
          error: getErrorMessage(error),
        });
      }
    }
  }

  private call<T>(promise: Promise<T>, what: string): Promise<T> {
    return withTimeout(
      promise,
      this.options.callTimeoutMs ?? DAYTONA_RECONCILE_CALL_TIMEOUT_MS,
      what
    );
  }
}
