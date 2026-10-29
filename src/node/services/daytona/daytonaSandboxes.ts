import * as path from "path";
import type { DaytonaSandboxState } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
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
import { requireSandboxId, type DaytonaSandboxIds } from "./daytonaSandboxIds";
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

const DESTROYING_STATES = new Set<string>(DESTROYING_STATE_NAMES);

function isDestroyedState(raw: string | undefined): boolean {
  return raw !== undefined && DESTROYING_STATES.has(raw);
}

/** Collapse Daytona's ~20 sandbox states to the five Xum acts on; unknown values are errors. */
export function mapDaytonaSandboxState(raw: string | undefined): ObservedSandboxState {
  return (raw ? RAW_STATE_MAP[raw] : undefined) ?? "error";
}

// States from which `start` brings the sandbox back (stopped includes paused).
const STARTABLE_STATES = new Set<ObservedSandboxState>(["stopped", "archived"]);

function sandboxStateError(sandboxName: string, sandbox: DaytonaSandbox): DaytonaApiError {
  const reason = sandbox.errorReason ? `: ${sandbox.errorReason}` : "";
  return new DaytonaApiError(
    "server",
    `Daytona sandbox ${sandboxName} is in state ${sandbox.state ?? "unknown"}${reason}`
  );
}

function startTimeoutError(sandboxName: string, sandbox: DaytonaSandbox): DaytonaApiError {
  return new DaytonaApiError(
    "timeout",
    `Daytona sandbox ${sandboxName} did not start in time (last state: ${sandbox.state ?? "unknown"})`
  );
}

/**
 * One startAndWait step for an observed sandbox: done once started, start it (once) when it is
 * stopped or archived, otherwise keep waiting. Error states throw.
 */
function nextStartStep(
  sandboxName: string,
  sandbox: DaytonaSandbox,
  startRequested: boolean
): "done" | "start" | "wait" {
  const state = mapDaytonaSandboxState(sandbox.state);
  if (state === "started") return "done";
  if (state === "error") throw sandboxStateError(sandboxName, sandbox);
  // Start once: Daytona may report the old state for a poll or two after accepting it.
  if (!startRequested && STARTABLE_STATES.has(state)) return "start";
  return "wait";
}

export interface DaytonaSandboxesOptions {
  account: Pick<DaytonaAccount, "getClient">;
  ssh: Pick<DaytonaSsh, "ensureSshAccess" | "releaseSshAccess">;
  readiness: DaytonaReadiness;
  ids: DaytonaSandboxIds;
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

/**
 * The sandboxes themselves: their state, start and stop, create and delete, and labels. Callers
 * name a workspace's sandbox by its `sandboxName`; requests go to the id recorded for it.
 */
export class DaytonaSandboxes {
  private readonly account: DaytonaSandboxesOptions["account"];
  private readonly ssh: DaytonaSandboxesOptions["ssh"];
  private readonly readiness: DaytonaReadiness;
  private readonly ids: DaytonaSandboxIds;
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DaytonaSandboxesOptions) {
    this.account = options.account;
    this.ssh = options.ssh;
    this.readiness = options.readiness;
    this.ids = options.ids;
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

  /** `missing` too for a sandbox with no recorded id: Xum never finished creating it. */
  async getSandboxState(
    sandboxName: string
  ): Promise<{ state: DaytonaSandboxState; sandbox?: DaytonaSandbox }> {
    const sandboxId = this.ids.get(sandboxName);
    if (!sandboxId) return { state: "missing" };
    const { client } = await this.account.getClient();
    const sandbox = await this.lookUp(client, sandboxId);
    return sandbox
      ? { state: mapDaytonaSandboxState(sandbox.state), sandbox }
      : { state: "missing" };
  }

  /**
   * The sandbox with this id or name, or undefined once it is gone. By id, Daytona keeps
   * answering for a deleted sandbox (state `deleting`, then `destroyed`), so those count as gone.
   */
  private async lookUp(
    client: DaytonaClient,
    idOrName: string,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox | undefined> {
    try {
      const sandbox = await client.getSandbox(idOrName, signal);
      return isDestroyedState(sandbox.state) ? undefined : sandbox;
    } catch (error) {
      if (isDaytonaNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Whether any sandbox has this name: a new sandbox needs a free one. */
  async isNameTaken(sandboxName: string): Promise<boolean> {
    const { client } = await this.account.getClient();
    try {
      await client.getSandbox(sandboxName);
      return true;
    } catch (error) {
      if (isDaytonaNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Bring a sandbox to `started` before `deadline` (epoch ms), starting it once if it is
   * stopped, paused or archived. Fails on error states, a missing sandbox, or the deadline.
   */
  async startAndWait(
    sandboxName: string,
    deadline: number,
    options: DaytonaStartAndWaitOptions = {}
  ): Promise<DaytonaSandbox> {
    const sandboxId = requireSandboxId(this.ids, sandboxName);
    const { client } = await this.account.getClient();
    let startRequested = false;
    for (;;) {
      options.signal?.throwIfAborted();
      const sandbox = await this.getSandboxForStart(client, sandboxName, sandboxId, options.signal);
      await this.assertOwned(sandbox, sandboxName);
      const step = nextStartStep(sandboxName, sandbox, startRequested);
      if (step === "done") return sandbox;
      if (step === "start") {
        options.onStarting?.();
        await client.startSandbox(sandboxId, options.signal);
        startRequested = true;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) throw startTimeoutError(sandboxName, sandbox);
      await this.sleep(Math.min(DAYTONA_START_POLL_INTERVAL_MS, remaining));
    }
  }

  private async getSandboxForStart(
    client: DaytonaClient,
    sandboxName: string,
    sandboxId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox> {
    const sandbox = await this.lookUp(client, sandboxId, signal);
    if (sandbox) return sandbox;
    throw new DaytonaApiError(
      "not_found",
      `Daytona sandbox ${sandboxName} no longer exists (removed outside Xum?)`,
      404
    );
  }

  /**
   * Create a sandbox named `request.name` and record its id on the workspace that names it. A
   * workspace removed during the create records nothing: its new sandbox is deleted again.
   */
  async createSandbox(
    request: DaytonaCreateSandboxRequest & { name: string }
  ): Promise<DaytonaSandbox> {
    const { client } = await this.account.getClient();
    const created = await client.createSandbox(request);
    let recorded: boolean;
    try {
      recorded = await this.ids.record(request.name, created.id);
    } catch (error) {
      await this.deleteUnrecorded(client, created.id, request.name);
      throw error;
    }
    if (!recorded) {
      await this.deleteUnrecorded(client, created.id, request.name);
      throw new Error(`the workspace of Daytona sandbox ${request.name} was removed during setup`);
    }
    return created;
  }

  private async deleteUnrecorded(
    client: DaytonaClient,
    sandboxId: string,
    sandboxName: string
  ): Promise<void> {
    try {
      await client.deleteSandbox(sandboxId);
    } catch (error) {
      log.error("Failed to delete a Daytona sandbox whose id Xum could not record", {
        sandboxName,
        error: getErrorMessage(error),
      });
    }
  }

  async resizeSandbox(sandboxName: string, request: DaytonaResizeRequest): Promise<void> {
    const sandboxId = requireSandboxId(this.ids, sandboxName);
    const { client } = await this.account.getClient();
    this.readiness.invalidateSandboxReady(sandboxName);
    await client.resizeSandbox(sandboxId, request);
  }

  /** Stop and wait until Daytona reports the sandbox stopped (a resize of disk needs that). */
  async stopAndWait(sandboxName: string, deadline: number): Promise<void> {
    const sandboxId = requireSandboxId(this.ids, sandboxName);
    const { client } = await this.account.getClient();
    this.readiness.invalidateSandboxReady(sandboxName);
    await client.stopSandbox(sandboxId);
    for (;;) {
      const sandbox = await this.getSandboxForStart(client, sandboxName, sandboxId);
      const state = mapDaytonaSandboxState(sandbox.state);
      if (state === "stopped") return;
      if (state === "error") throw sandboxStateError(sandboxName, sandbox);
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new DaytonaApiError(
          "timeout",
          `Daytona sandbox ${sandboxName} did not stop in time (last state: ${sandbox.state ?? "unknown"})`
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
  async deleteSandbox(sandboxName: string): Promise<void> {
    const { client } = await this.account.getClient();
    const sandbox = await this.findSandbox(client, sandboxName);
    // Revoke first: Daytona refuses to revoke a token of a sandbox that no longer exists.
    await this.ssh.releaseSshAccess(sandboxName);
    if (!sandbox) return;
    if (!(await this.carriesInstanceLabel(sandbox))) {
      log.warn("Keeping a Daytona sandbox without this install's label", { sandboxName });
      return;
    }
    try {
      await client.deleteSandbox(sandbox.id);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
    }
  }

  /**
   * The recorded id's sandbox. Without a record, the sandbox a create whose answer never came
   * (a timeout, a 5xx) may have made: found by its fresh name, and deleted only with this
   * install's label. A recorded sandbox that is gone is never looked up by name again.
   */
  private async findSandbox(
    client: DaytonaClient,
    sandboxName: string
  ): Promise<DaytonaSandbox | undefined> {
    return this.lookUp(client, this.ids.get(sandboxName) ?? sandboxName);
  }

  private async carriesInstanceLabel(sandbox: DaytonaSandbox): Promise<boolean> {
    return sandbox.labels?.[DAYTONA_LABEL_INSTANCE] === (await this.getInstanceId());
  }

  /**
   * Refuse to start a sandbox or give Xum ssh access to it without this install's label: its
   * label was removed, or a hand-edited config names a sandbox Xum did not create.
   */
  async assertOwned(sandbox: DaytonaSandbox, sandboxName: string): Promise<void> {
    if (await this.carriesInstanceLabel(sandbox)) return;
    throw new DaytonaApiError(
      "bad_request",
      `Daytona sandbox ${sandboxName} does not carry this Xum install's label, so Xum will not use it`
    );
  }

  /** By id: the reconciler passes the id of a sandbox in this install's label-filtered list. */
  async refreshActivity(sandboxId: string): Promise<void> {
    const { client } = await this.account.getClient();
    await client.refreshActivity(sandboxId);
  }

  /**
   * Bring the sandbox to `started` and make sure Xum can ssh into it (fresh token, include
   * block). Concurrent callers for one sandbox share a single request; only the first hears
   * `onStarting`. Throws a DaytonaApiError (`not_found` when the sandbox is gone).
   */
  ensureSandboxReady(sandboxName: string, options: DaytonaEnsureReadyOptions = {}): Promise<void> {
    return this.readiness.join(sandboxName, options, async (onStarting) => {
      await this.startAndWait(sandboxName, this.now() + DAYTONA_START_TIMEOUT_MS, { onStarting });
      await this.ssh.ensureSshAccess(sandboxName);
    });
  }
}
