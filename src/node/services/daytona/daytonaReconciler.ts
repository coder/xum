import type { Workspace } from "@/common/types/project";
import { getDaytonaSandboxId, type RuntimeConfig } from "@/common/types/runtime";
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
    | "getSandboxState"
  >;
  /** Every workspace Xum knows, archived ones included (they still own their sandbox). */
  listWorkspaces: () => DaytonaWorkspaceRef[];
  /**
   * Streaming, or running a background job that has not exited: Daytona counts only SSH and
   * API traffic. May check a job over ssh, so it is only asked about a started sandbox.
   */
  isWorkspaceActive: (workspaceId: string) => boolean | Promise<boolean>;
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

function isStarted(sandbox: DaytonaSandbox): boolean {
  return mapDaytonaSandboxState(sandbox.state) === "started";
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
    let sandboxes: DaytonaSandbox[];
    try {
      sandboxes = await this.call(service.listInstanceSandboxes(), "listing Daytona sandboxes");
    } catch (error) {
      // Without the list Xum cannot map stored names to ids or see states: keepalive and
      // orphans wait for the next sweep instead of guessing.
      log.warn("Daytona reconcile: could not list sandboxes", { error: getErrorMessage(error) });
      return;
    }

    for (const ref of refs) {
      await this.keepAlive(ref, sandboxes);
    }
    await this.stopOrphans(sandboxes, refs);
  }

  private collectReferences(): Array<{ workspaceId: string; sandboxId: string }> {
    const refs: Array<{ workspaceId: string; sandboxId: string }> = [];
    for (const workspace of this.options.listWorkspaces()) {
      const sandboxId = getDaytonaSandboxId(workspace.runtimeConfig);
      if (sandboxId) refs.push({ workspaceId: workspace.workspaceId, sandboxId });
    }
    return refs;
  }

  private async keepAlive(
    ref: { workspaceId: string; sandboxId: string },
    sandboxes: DaytonaSandbox[]
  ): Promise<void> {
    const sandbox = await this.findActiveSandbox(ref, sandboxes);
    if (sandbox) await this.refreshActivityAndToken(ref.sandboxId, sandbox.id);
  }

  /** The sandbox of a workspace that is active, if the sandbox is known and started. */
  private async findActiveSandbox(
    ref: { workspaceId: string; sandboxId: string },
    sandboxes: DaytonaSandbox[]
  ): Promise<DaytonaSandbox | undefined> {
    // Xum stores a name for sandboxes it created; last-activity only takes the real id. An
    // attached sandbox carries no label of this install, so the list does not show it.
    const sandbox =
      sandboxes.find((sb) => sb.id === ref.sandboxId || sb.name === ref.sandboxId) ??
      (await this.lookUpSandbox(ref.sandboxId));
    // A stopped sandbox has nothing to keep alive, and checking its jobs over ssh would start it.
    if (!sandbox || !isStarted(sandbox)) return undefined;
    return (await this.isWorkspaceActive(ref.workspaceId)) ? sandbox : undefined;
  }

  private async isWorkspaceActive(workspaceId: string): Promise<boolean> {
    try {
      return await this.call(
        Promise.resolve(this.options.isWorkspaceActive(workspaceId)),
        "checking workspace activity"
      );
    } catch (error) {
      log.warn("Daytona reconcile: could not check workspace activity", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /** `storedId` is what the workspace config holds (tokens use it), `realId` the sandbox id. */
  private async refreshActivityAndToken(storedId: string, realId: string): Promise<void> {
    const service = this.options.daytonaService;
    try {
      await this.call(service.refreshActivity(realId), "refreshing activity");
    } catch (error) {
      log.warn("Daytona reconcile: activity refresh failed", {
        sandboxId: storedId,
        error: getErrorMessage(error),
      });
    }
    if (!service.hasExpiringSshToken(storedId)) return;
    try {
      await this.call(service.ensureSshAccess(storedId), "refreshing the ssh token");
    } catch (error) {
      log.warn("Daytona reconcile: ssh token refresh failed", {
        sandboxId: storedId,
        error: getErrorMessage(error),
      });
    }
  }

  private async lookUpSandbox(sandboxId: string): Promise<DaytonaSandbox | undefined> {
    try {
      const { sandbox } = await this.call(
        this.options.daytonaService.getSandboxState(sandboxId),
        "looking up a sandbox"
      );
      return sandbox;
    } catch (error) {
      log.warn("Daytona reconcile: could not look up a sandbox", {
        sandboxId,
        error: getErrorMessage(error),
      });
      return undefined;
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
