import * as path from "path";
import type { DaytonaSandboxState } from "@/common/orpc/schemas/daytona";
import { loadOrCreateInstallationId } from "@/node/config/installationIdentity";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import type { DaytonaAccount } from "./daytonaAccount";
import {
  DaytonaApiError,
  isDaytonaNotFound,
  type DaytonaClient,
  type DaytonaCreateSandboxRequest,
  type DaytonaResizeRequest,
  type DaytonaSandbox,
} from "./daytonaClient";
import {
  DAYTONA_READY_CACHE_MS,
  type DaytonaEnsureReadyOptions,
  type DaytonaReadiness,
} from "./daytonaReadiness";
import type { DaytonaSsh } from "./daytonaSsh";

export const DAYTONA_LABEL_INSTANCE = "xum.instance";

/** Why a delete of a sandbox the workspace says Xum created kept it (see deleteSandbox). */
export function notOwnedSandboxNotice(sandboxId: string): string {
  return (
    `Daytona sandbox "${sandboxId}" was kept: it does not carry this Xum install's ` +
    `"${DAYTONA_LABEL_INSTANCE}" label, so Xum does not treat it as its own.`
  );
}
export const DAYTONA_LABEL_WORKSPACE_ID = "xum.workspaceId";
export const DAYTONA_LABEL_PROJECT = "xum.project";

export const DAYTONA_START_POLL_INTERVAL_MS = 2_000;

/** Upper bound for bringing a stopped or archived sandbox back (archived restores are slow). */
export const DAYTONA_START_TIMEOUT_MS = 180_000;
/** How long a delete waits for a sandbox Daytona is already destroying to go away. */
export const DAYTONA_DESTROY_WAIT_MS = 60_000;

// Daytona documents "deleting" and "deleted"; "destroying" and "destroyed" are older spellings.
const DESTROYING_STATE_NAMES = ["deleting", "deleted", "destroying", "destroyed"] as const;
const DESTROYING_STATES = new Set<string>(DESTROYING_STATE_NAMES);

type ObservedSandboxState = Exclude<DaytonaSandboxState, "missing">;

const RAW_STATE_MAP: Record<string, ObservedSandboxState> = {
  creating: "starting",
  restoring: "starting",
  starting: "starting",
  pending_build: "starting",
  building_snapshot: "starting",
  pulling_snapshot: "starting",
  resizing: "starting",
  snapshotting: "starting",
  forking: "starting",
  resuming: "starting",
  // Going down, but not settled yet: transitional like the start states.
  stopping: "starting",
  archiving: "starting",
  pausing: "starting",
  started: "started",
  stopped: "stopped",
  paused: "stopped",
  archived: "archived",
  error: "error",
  build_failed: "error",
  unknown: "error",
  ...Object.fromEntries(DESTROYING_STATE_NAMES.map((state) => [state, "error" as const])),
};

/** Collapse Daytona's ~20 sandbox states to the five Xum acts on; unknown values are errors. */
export function mapDaytonaSandboxState(raw: string | undefined): ObservedSandboxState {
  return (raw ? RAW_STATE_MAP[raw] : undefined) ?? "error";
}

// States from which `start` brings the sandbox back (stopped includes paused).
const STARTABLE_STATES = new Set<ObservedSandboxState>(["stopped", "archived"]);

function sandboxStateError(sandboxId: string, sandbox: DaytonaSandbox): DaytonaApiError {
  const reason = sandbox.errorReason ? `: ${sandbox.errorReason}` : "";
  return new DaytonaApiError(
    "server",
    `Daytona sandbox ${sandboxId} is in state ${sandbox.state ?? "unknown"}${reason}`
  );
}

function startTimeoutError(sandboxId: string, sandbox: DaytonaSandbox): DaytonaApiError {
  return new DaytonaApiError(
    "timeout",
    `Daytona sandbox ${sandboxId} did not start in time (last state: ${sandbox.state ?? "unknown"})`
  );
}

/**
 * One startAndWait step for an observed sandbox: done once started, start it (once) when it is
 * stopped or archived, otherwise keep waiting. Error states throw.
 */
function nextStartStep(
  sandboxId: string,
  sandbox: DaytonaSandbox,
  startRequested: boolean
): "done" | "start" | "wait" {
  const state = mapDaytonaSandboxState(sandbox.state);
  if (state === "started") return "done";
  if (state === "error") throw sandboxStateError(sandboxId, sandbox);
  // Start once: Daytona may report the old state for a poll or two after accepting it.
  if (!startRequested && STARTABLE_STATES.has(state)) return "start";
  return "wait";
}

export interface DaytonaSandboxesOptions {
  account: Pick<DaytonaAccount, "getClient" | "withAccountLease">;
  ssh: Pick<DaytonaSsh, "ensureSshAccess" | "releaseSshAccess">;
  readiness: DaytonaReadiness;
  /** Xum data root; holds the installation identity used for the `xum.instance` label. */
  rootDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface DaytonaStartAndWaitOptions {
  /** Called when Xum asks Daytona to start the sandbox (for a "Starting sandbox" status). */
  onStarting?: () => void;
  signal?: AbortSignal;
}

/** The sandboxes themselves: their state, start and stop, create and delete, and labels. */
export class DaytonaSandboxes {
  private readonly account: DaytonaSandboxesOptions["account"];
  private readonly ssh: DaytonaSandboxesOptions["ssh"];
  private readonly readiness: DaytonaReadiness;
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * When this process last proved a sandbox carries this install's label (never one that does
   * not). A turn reuses a proof within DAYTONA_READY_CACHE_MS, so a label someone else removed
   * is seen within that window and a healthy sandbox pays one label read per window. Dropped
   * with a delete, and with the account.
   */
  private readonly provenOwned = new Map<string, number>();
  private readonly ownershipRequests = new Map<string, Promise<"owned" | "notOwned" | "missing">>();
  /** Why a workspace's setup of the sandbox Xum created for it failed, for its later turns. */
  private readonly setupFailures = new Map<string, string>();

  constructor(options: DaytonaSandboxesOptions) {
    this.account = options.account;
    this.ssh = options.ssh;
    this.readiness = options.readiness;
    this.rootDir = options.rootDir;
    this.now = options.now;
    this.sleep = options.sleep;
  }

  /** The settings changed: a label proof read in the old account says nothing about the new one. */
  forgetOwnershipProofs(): void {
    this.provenOwned.clear();
  }

  recordSetupFailure(workspaceId: string, reason: string): void {
    this.setupFailures.set(workspaceId, reason);
  }

  getSetupFailure(workspaceId: string): string | undefined {
    return this.setupFailures.get(workspaceId);
  }

  /** The workspace was removed: its id never comes back. */
  clearSetupFailure(workspaceId: string): void {
    this.setupFailures.delete(workspaceId);
  }

  /** Stable per Xum install, so the reconciler only ever touches this install's sandboxes. */
  getInstanceId(): Promise<string> {
    return loadOrCreateInstallationId(this.rootDir);
  }

  async buildLabels(input: {
    workspaceId: string;
    projectPath: string;
  }): Promise<Record<string, string>> {
    return {
      [DAYTONA_LABEL_INSTANCE]: await this.getInstanceId(),
      [DAYTONA_LABEL_WORKSPACE_ID]: input.workspaceId,
      // The basename only: the full path would leak local directory names to Daytona.
      [DAYTONA_LABEL_PROJECT]: path.basename(input.projectPath),
    };
  }

  async listInstanceSandboxes(): Promise<DaytonaSandbox[]> {
    const { client } = await this.account.getClient();
    return client.listSandboxes({ [DAYTONA_LABEL_INSTANCE]: await this.getInstanceId() });
  }

  async getSandboxState(
    sandboxId: string
  ): Promise<{ state: DaytonaSandboxState; sandbox?: DaytonaSandbox }> {
    const { client } = await this.account.getClient();
    try {
      const sandbox = await client.getSandbox(sandboxId);
      return { state: mapDaytonaSandboxState(sandbox.state), sandbox };
    } catch (error) {
      if (isDaytonaNotFound(error)) return { state: "missing" };
      throw error;
    }
  }

  /**
   * Bring a sandbox to `started` before `deadline` (epoch ms), starting it once if it is
   * stopped, paused or archived. Fails on error states, a missing sandbox, or the deadline.
   */
  async startAndWait(
    sandboxId: string,
    deadline: number,
    options: DaytonaStartAndWaitOptions = {}
  ): Promise<DaytonaSandbox> {
    const { client } = await this.account.getClient();
    let startRequested = false;
    for (;;) {
      options.signal?.throwIfAborted();
      const sandbox = await this.getSandboxForStart(client, sandboxId, options.signal);
      const step = nextStartStep(sandboxId, sandbox, startRequested);
      if (step === "done") return sandbox;
      if (step === "start") {
        options.onStarting?.();
        await client.startSandbox(sandboxId, options.signal);
        startRequested = true;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) throw startTimeoutError(sandboxId, sandbox);
      await this.sleep(Math.min(DAYTONA_START_POLL_INTERVAL_MS, remaining));
    }
  }

  private async getSandboxForStart(
    client: DaytonaClient,
    sandboxId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox> {
    try {
      return await client.getSandbox(sandboxId, signal);
    } catch (error) {
      if (isDaytonaNotFound(error)) {
        throw new DaytonaApiError(
          "not_found",
          `Daytona sandbox ${sandboxId} no longer exists (removed outside Xum?)`,
          404
        );
      }
      throw error;
    }
  }

  async createSandbox(request: DaytonaCreateSandboxRequest): Promise<DaytonaSandbox> {
    return (await this.account.getClient()).client.createSandbox(request);
  }

  async resizeSandbox(sandboxId: string, request: DaytonaResizeRequest): Promise<void> {
    const { client } = await this.account.getClient();
    this.readiness.invalidateSandboxReady(sandboxId);
    await client.resizeSandbox(sandboxId, request);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const { client } = await this.account.getClient();
    this.readiness.invalidateSandboxReady(sandboxId);
    await client.stopSandbox(sandboxId);
  }

  /**
   * Whether the sandbox is gone, waiting up to DAYTONA_DESTROY_WAIT_MS while Daytona destroys
   * it (a failed setup deletes its sandbox while a removal of the workspace may already run).
   * False for a sandbox in any other state, or one still being destroyed at the deadline.
   */
  async waitUntilDestroyed(sandboxId: string): Promise<boolean> {
    const { client } = await this.account.getClient();
    const deadline = this.now() + DAYTONA_DESTROY_WAIT_MS;
    for (;;) {
      const sandbox = await client.getSandbox(sandboxId).catch((error: unknown) => {
        if (isDaytonaNotFound(error)) return undefined;
        throw error;
      });
      if (!sandbox) return true;
      const remaining = deadline - this.now();
      if (!DESTROYING_STATES.has(sandbox.state ?? "") || remaining <= 0) return false;
      await this.sleep(Math.min(DAYTONA_START_POLL_INTERVAL_MS, remaining));
    }
  }

  /** Stop and wait until Daytona reports the sandbox stopped (a resize of disk needs that). */
  async stopAndWait(sandboxId: string, deadline: number): Promise<void> {
    await this.stopSandbox(sandboxId);
    const { client } = await this.account.getClient();
    for (;;) {
      const sandbox = await this.getSandboxForStart(client, sandboxId);
      const state = mapDaytonaSandboxState(sandbox.state);
      if (state === "stopped") return;
      if (state === "error") throw sandboxStateError(sandboxId, sandbox);
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new DaytonaApiError(
          "timeout",
          `Daytona sandbox ${sandboxId} did not stop in time (last state: ${sandbox.state ?? "unknown"})`
        );
      }
      await this.sleep(Math.min(DAYTONA_START_POLL_INTERVAL_MS, remaining));
    }
  }

  /**
   * Delete a sandbox Xum created and drop Xum's SSH access to it (token and include block). A
   * sandbox that is already gone counts as deleted. `account` deletes it in the account it was
   * created in, even after the settings changed to another one.
   *
   * A workspace's config is not proof: a create of unknown outcome may have left it naming a
   * sandbox someone else holds. So only a sandbox with this install's label is
   * deleted; "notOwned" leaves it, and its access, to the caller.
   */
  async deleteSandbox(sandboxId: string): Promise<"deleted" | "notOwned"> {
    const { client } = await this.account.getClient();
    if ((await this.ownershipWith(client, sandboxId)) === "notOwned") return "notOwned";
    this.provenOwned.delete(sandboxId);
    // Revoke first: Daytona refuses to revoke a token of a sandbox that no longer exists.
    await this.ssh.releaseSshAccess(sandboxId);
    try {
      await client.deleteSandbox(sandboxId);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
    }
    return "deleted";
  }

  /**
   * Whether a sandbox a workspace says Xum created carries this install's label. Asked before
   * any step that changes it (a start, a checkout delete, a stop or a delete): a create of
   * unknown outcome may have left the workspace naming someone else's sandbox.
   */
  async sandboxOwnership(
    sandboxId: string,
    options: { reuseProof?: boolean; signal?: AbortSignal } = {}
  ): Promise<"owned" | "notOwned" | "missing"> {
    // Only a turn or terminal reuses a proof: removals and archives read the label again.
    if (!options.reuseProof)
      return this.ownershipWith((await this.account.getClient()).client, sandboxId);
    const provenAt = this.provenOwned.get(sandboxId);
    if (provenAt !== undefined && this.now() - provenAt < DAYTONA_READY_CACHE_MS) return "owned";
    // Concurrent checks share one read, so they reach the shared start together.
    const request = this.ownershipRequests.get(sandboxId) ?? this.proveOwnership(sandboxId);
    const raced = await raceWithAbortAndTimeout(request, { signal: options.signal });
    if (raced.kind !== "ok") throw new Error("Aborted");
    return raced.value;
  }

  private proveOwnership(sandboxId: string): Promise<"owned" | "notOwned" | "missing"> {
    const request = (async () => {
      const ownership = await this.ownershipWith(
        (await this.account.getClient()).client,
        sandboxId
      );
      if (ownership !== "owned") this.provenOwned.delete(sandboxId);
      else this.provenOwned.set(sandboxId, this.now());
      return ownership;
    })().finally(() => this.ownershipRequests.delete(sandboxId));
    this.ownershipRequests.set(sandboxId, request);
    return request;
  }

  private async ownershipWith(
    client: DaytonaClient,
    sandboxId: string
  ): Promise<"owned" | "notOwned" | "missing"> {
    let sandbox: DaytonaSandbox;
    try {
      sandbox = await client.getSandbox(sandboxId);
    } catch (error) {
      if (isDaytonaNotFound(error)) return "missing";
      throw error;
    }
    const owned = sandbox.labels?.[DAYTONA_LABEL_INSTANCE] === (await this.getInstanceId());
    return owned ? "owned" : "notOwned";
  }

  async refreshActivity(sandboxId: string): Promise<void> {
    const { client } = await this.account.getClient();
    await client.refreshActivity(sandboxId);
  }

  /**
   * Bring the sandbox to `started` and make sure Xum can ssh into it (fresh token, include
   * block). Concurrent callers for one sandbox share a single request; each still gets its own
   * `onStarting` call. Throws a DaytonaApiError (`not_found` when the sandbox is gone).
   */
  ensureSandboxReady(sandboxId: string, options: DaytonaEnsureReadyOptions = {}): Promise<void> {
    return this.readiness.join(sandboxId, options, (onStarting) =>
      this.account.withAccountLease(async () => {
        await this.startAndWait(sandboxId, this.now() + DAYTONA_START_TIMEOUT_MS, { onStarting });
        await this.ssh.ensureSshAccess(sandboxId);
      })
    );
  }
}
