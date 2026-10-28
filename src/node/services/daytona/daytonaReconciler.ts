import type { Workspace } from "@/common/types/project";
import { getDaytonaSandboxName, isSSHRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { DaytonaSandbox } from "./daytonaClient";
import type { DaytonaAccount } from "./daytonaAccount";
import { mapDaytonaSandboxState, type DaytonaSandboxes } from "./daytonaSandboxes";

export const DAYTONA_RECONCILE_INTERVAL_MS = 60_000;
/** Each control-plane call gets this long; a hung call is logged and the sweep moves on. */
export const DAYTONA_RECONCILE_CALL_TIMEOUT_MS = 20_000;

export interface DaytonaWorkspaceRef {
  workspaceId: string;
  runtimeConfig: RuntimeConfig | undefined;
}

export interface DaytonaReconcilerOptions {
  daytonaService: {
    account: Pick<DaytonaAccount, "checkAvailability">;
    sandboxes: Pick<DaytonaSandboxes, "listInstanceSandboxes" | "refreshActivity">;
  };
  listWorkspaces: () => DaytonaWorkspaceRef[];
  /**
   * Streaming, or running a background job that has not exited: Daytona counts only SSH and
   * API traffic. May check a job over ssh, so it is only asked about a started sandbox.
   */
  isWorkspaceActive: (workspaceId: string) => boolean | Promise<boolean>;
  intervalMs?: number;
  callTimeoutMs?: number;
}

export function listDaytonaWorkspaceRefs(config: {
  projects: ReadonlyMap<
    string,
    { workspaces: ReadonlyArray<Pick<Workspace, "id" | "runtimeConfig">> }
  >;
}): DaytonaWorkspaceRef[] {
  const refs: DaytonaWorkspaceRef[] = [];
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      refs.push({ workspaceId: workspace.id, runtimeConfig: workspace.runtimeConfig });
    }
  }
  return refs;
}

/** A workspace on a Daytona sandbox Xum created and recorded. */
export interface DaytonaSandboxRef {
  workspaceId: string;
  sandboxName: string;
  sandboxId: string;
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
 * One sweep a minute, safe to repeat, that refreshes activity for sandboxes whose workspace is
 * streaming or running a background job, so Daytona's 30-minute auto-stop does not cut off long
 * agent work. Sandboxes no workspace uses are left to Daytona's auto-stop. Tokens are not its
 * business: ensureReady replaces an expiring one, and a command a stale token fails is repaired
 * and retried, both under the sandbox's readiness request that a release waits for.
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
    if (!(await service.account.checkAvailability()).available) return;

    const refs = this.collectReferences();
    let sandboxes: DaytonaSandbox[];
    try {
      sandboxes = await this.call(
        service.sandboxes.listInstanceSandboxes(),
        "listing Daytona sandboxes"
      );
    } catch (error) {
      // Without the list Xum cannot see labels or states: keepalive waits for the next sweep
      // instead of guessing.
      log.warn("Daytona reconcile: could not list sandboxes", { error: getErrorMessage(error) });
      return;
    }

    for (const ref of refs) {
      await this.keepAlive(ref, sandboxes);
    }
  }

  private collectReferences(): DaytonaSandboxRef[] {
    const refs: DaytonaSandboxRef[] = [];
    for (const { workspaceId, runtimeConfig } of this.options.listWorkspaces()) {
      const sandboxName = getDaytonaSandboxName(runtimeConfig);
      const sandboxId = isSSHRuntime(runtimeConfig) ? runtimeConfig.daytona?.sandboxId : undefined;
      if (sandboxName && sandboxId) refs.push({ workspaceId, sandboxName, sandboxId });
    }
    return refs;
  }

  private async keepAlive(ref: DaytonaSandboxRef, sandboxes: DaytonaSandbox[]): Promise<void> {
    const sandbox = await this.findActiveSandbox(ref, sandboxes);
    if (!sandbox) return;
    try {
      await this.call(
        this.options.daytonaService.sandboxes.refreshActivity(sandbox.id),
        "refreshing activity"
      );
    } catch (error) {
      log.warn("Daytona reconcile: activity refresh failed", {
        sandboxName: ref.sandboxName,
        error: getErrorMessage(error),
      });
    }
  }

  /** The sandbox of a workspace that is active, if the sandbox is known and started. */
  private async findActiveSandbox(
    ref: DaytonaSandboxRef,
    sandboxes: DaytonaSandbox[]
  ): Promise<DaytonaSandbox | undefined> {
    // Only the label-filtered list counts: a sandbox without this install's label is not Xum's
    // to touch.
    const sandbox = sandboxes.find((sb) => sb.id === ref.sandboxId);
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

  private call<T>(promise: Promise<T>, what: string): Promise<T> {
    return withTimeout(
      promise,
      this.options.callTimeoutMs ?? DAYTONA_RECONCILE_CALL_TIMEOUT_MS,
      what
    );
  }
}
