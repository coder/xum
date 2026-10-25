import * as path from "path";
import type { DaytonaSandboxState } from "@/common/orpc/schemas/daytona";
import { loadOrCreateInstallationId } from "@/node/config/installationIdentity";
import { log } from "@/node/services/log";
import type { DaytonaAccount } from "./daytonaAccount";
import {
  DaytonaApiError,
  isDaytonaNotFound,
  type DaytonaClient,
  type DaytonaCreateSandboxRequest,
  type DaytonaResizeRequest,
  type DaytonaSandbox,
} from "./daytonaClient";
import type { DaytonaEnsureReadyOptions, DaytonaReadiness } from "./daytonaReadiness";
import type { DaytonaSsh } from "./daytonaSsh";

export const DAYTONA_LABEL_INSTANCE = "xum.instance";
export const DAYTONA_LABEL_WORKSPACE_ID = "xum.workspaceId";
export const DAYTONA_LABEL_PROJECT = "xum.project";

export const DAYTONA_START_POLL_INTERVAL_MS = 2_000;

/** Upper bound for bringing a stopped or archived sandbox back (archived restores are slow). */
export const DAYTONA_START_TIMEOUT_MS = 180_000;

// Daytona documents "deleting" and "deleted"; "destroying" and "destroyed" are older spellings.
const DESTROYING_STATE_NAMES = ["deleting", "deleted", "destroying", "destroyed"] as const;

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
  account: Pick<DaytonaAccount, "getClient">;
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

  constructor(options: DaytonaSandboxesOptions) {
    this.account = options.account;
    this.ssh = options.ssh;
    this.readiness = options.readiness;
    this.rootDir = options.rootDir;
    this.now = options.now;
    this.sleep = options.sleep;
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
      await this.assertOwned(sandbox, sandboxId);
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
   * sandbox that is already gone counts as deleted.
   *
   * A workspace's config is not proof that Xum created the sandbox it names, so one without this
   * install's label is kept (only Xum's access to it goes) and logged.
   */
  async deleteSandbox(sandboxId: string): Promise<void> {
    const { client } = await this.account.getClient();
    const owned = await this.isOwned(client, sandboxId);
    // Revoke first: Daytona refuses to revoke a token of a sandbox that no longer exists.
    await this.ssh.releaseSshAccess(sandboxId);
    if (!owned) {
      log.warn("Keeping a Daytona sandbox without this install's label", { sandboxId });
      return;
    }
    try {
      await client.deleteSandbox(sandboxId);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
    }
  }

  /** A sandbox that is already gone counts as owned: its delete is a no-op. */
  private async isOwned(client: DaytonaClient, sandboxId: string): Promise<boolean> {
    let sandbox: DaytonaSandbox;
    try {
      sandbox = await client.getSandbox(sandboxId);
    } catch (error) {
      if (isDaytonaNotFound(error)) return true;
      throw error;
    }
    return this.carriesInstanceLabel(sandbox);
  }

  private async carriesInstanceLabel(sandbox: DaytonaSandbox): Promise<boolean> {
    return sandbox.labels?.[DAYTONA_LABEL_INSTANCE] === (await this.getInstanceId());
  }

  /**
   * Refuse to start a sandbox or give Xum ssh access to it without this install's label: its
   * label was removed, or another sandbox took the name after the workspace's was deleted.
   */
  async assertOwned(sandbox: DaytonaSandbox, sandboxId: string): Promise<void> {
    if (await this.carriesInstanceLabel(sandbox)) return;
    throw new DaytonaApiError(
      "bad_request",
      `Daytona sandbox ${sandboxId} does not carry this Xum install's label, so Xum will not use it`
    );
  }

  async refreshActivity(sandboxId: string): Promise<void> {
    const { client } = await this.account.getClient();
    await client.refreshActivity(sandboxId);
  }

  /**
   * Bring the sandbox to `started` and make sure Xum can ssh into it (fresh token, include
   * block). Concurrent callers for one sandbox share a single request; only the first hears
   * `onStarting`. Throws a DaytonaApiError (`not_found` when the sandbox is gone).
   */
  ensureSandboxReady(sandboxId: string, options: DaytonaEnsureReadyOptions = {}): Promise<void> {
    return this.readiness.join(sandboxId, options, async (onStarting) => {
      await this.startAndWait(sandboxId, this.now() + DAYTONA_START_TIMEOUT_MS, { onStarting });
      await this.ssh.ensureSshAccess(sandboxId);
    });
  }
}
