/**
 * DaytonaSSHRuntime - SSH runtime for Daytona Cloud sandboxes, reached through Daytona's SSH
 * gateway. Mirrors CoderSSHRuntime: the sandbox is provisioned in postCreateSetup (after the
 * workspace metadata is persisted, so progress streams to the init log), and ensureReady starts
 * a stopped or archived sandbox on demand.
 *
 * Sandbox identity: Daytona accepts a sandbox name wherever it takes an id, so for a sandbox
 * Xum creates, finalizeConfig picks a unique name and stores it as `daytona.sandboxId`. The
 * host alias (`<sandboxId>.xum--daytona`) is then known before persist, like Coder's.
 */

import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  RuntimeCreateFlags,
  RuntimeStatusEvent,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
} from "./Runtime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import type { SSHTransport } from "./transports";
import {
  DAYTONA_DEFAULT_SIZE_PRESET_ID,
  DAYTONA_SIZE_PRESETS,
  findDaytonaSizePreset,
  toXumDaytonaHost,
  type DaytonaSizePreset,
} from "@/common/constants/daytona";
import { getXumHome } from "@/common/constants/paths";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { DaytonaApiError, type DaytonaSandbox } from "@/node/services/daytona/daytonaClient";
import {
  DAYTONA_START_TIMEOUT_MS,
  type DaytonaService,
} from "@/node/services/daytona/daytonaService";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { seedAgentHome, type AgentHomeSeedSources } from "./daytonaAgentHomeSeed";
import { expandTildeForSSH } from "./tildeExpansion";

/** The DaytonaService surface this runtime uses (tests pass an in-memory fake). */
export type DaytonaRuntimeService = Pick<
  DaytonaService,
  | "checkAvailability"
  | "getSandboxState"
  | "buildLabels"
  | "getDefaultTarget"
  | "createSandbox"
  | "resizeSandbox"
  | "stopAndWait"
  | "startAndWait"
  | "deleteSandbox"
  | "ensureSandboxReady"
  | "isSandboxReady"
  | "markSandboxReady"
>;

export interface DaytonaSSHRuntimeConfig extends SSHRuntimeConfig {
  daytona: DaytonaSandboxConfig;
}

export interface DaytonaSSHRuntimeOptions {
  projectPath?: string;
  workspaceName?: string;
  workspacePath?: string;
  /** Labels the created sandbox, so the reconciler can tell which workspace it belongs to. */
  workspaceId?: string;
  /** Host directories the agent home is seeded from (default: the Xum home and user home). */
  agentHomeSeedSources?: AgentHomeSeedSources;
}

/** Idle sandboxes stop after 30 minutes and archive after a day stopped; never auto-delete. */
const DAYTONA_AUTO_STOP_MINUTES = 30;
const DAYTONA_AUTO_ARCHIVE_MINUTES = 1440;
const DAYTONA_AUTO_DELETE_DISABLED = -1;

const SANDBOX_NAME_MAX_BRANCH_LENGTH = 40;

/** `xum-<branch>-<random>`: unique per creation, and readable in the Daytona dashboard. */
export function buildDaytonaSandboxName(branchName: string): string {
  const slug = branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SANDBOX_NAME_MAX_BRANCH_LENGTH)
    .replace(/-+$/g, "");
  const suffix = randomBytes(3).toString("hex");
  return slug ? `xum-${slug}-${suffix}` : `xum-${suffix}`;
}

/** No size set means the default preset; anything else must be exactly one preset. */
function resolveSizePreset(config: DaytonaSandboxConfig): DaytonaSizePreset | undefined {
  if (config.cpu === undefined && config.memoryGiB === undefined && config.diskGiB === undefined) {
    return DAYTONA_SIZE_PRESETS.find((preset) => preset.id === DAYTONA_DEFAULT_SIZE_PRESET_ID);
  }
  return findDaytonaSizePreset(config);
}

function invalidSizeError(): string {
  const sizes = DAYTONA_SIZE_PRESETS.map(
    (preset) => `${preset.label} (${preset.cpu} vCPU, ${preset.memoryGiB} GiB)`
  ).join(", ");
  return `Daytona sandbox size must be one of: ${sizes}`;
}

function isBadRequest(error: unknown): boolean {
  return error instanceof DaytonaApiError && error.kind === "bad_request";
}

/** Resolve with `promise`, or reject as soon as `signal` aborts (the shared work keeps going). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    );
  });
}

type DeleteResult = { success: true; deletedPath: string } | { success: false; error: string };

type StatusEmitter = (phase: RuntimeStatusEvent["phase"], detail?: string) => void;

function makeStatusEmitter(statusSink: EnsureReadyOptions["statusSink"]): StatusEmitter {
  return (phase, detail) => statusSink?.({ phase, runtimeType: "ssh", detail });
}

function growsDisk(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return sandbox.disk === undefined || sandbox.disk < preset.diskGiB;
}

/** A running sandbox can only grow cpu and memory. */
function shrinksCompute(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return (sandbox.cpu ?? 0) > preset.cpu || (sandbox.memory ?? 0) > preset.memoryGiB;
}

function changesCompute(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return sandbox.cpu !== preset.cpu || sandbox.memory !== preset.memoryGiB;
}

/**
 * IMPORTANT: extends SSHRuntime (rather than delegating) so code that checks
 * `runtime instanceof SSHRuntime` (PTY, tools, MCP, bash AI proxy) treats Daytona as SSH.
 */
export class DaytonaSSHRuntime extends SSHRuntime {
  private daytonaConfig: DaytonaSandboxConfig;
  private readonly daytonaService: DaytonaRuntimeService;
  private readonly workspaceId?: string;
  private readonly agentHomeSeedSources?: AgentHomeSeedSources;

  /** As Coder: the sandbox does not exist yet at create time, so skip host access. */
  readonly createFlags: RuntimeCreateFlags = {
    deferredRuntimeAccess: true,
    configLevelCollisionDetection: true,
  };

  constructor(
    config: DaytonaSSHRuntimeConfig,
    transport: SSHTransport,
    daytonaService: DaytonaRuntimeService,
    options?: DaytonaSSHRuntimeOptions
  ) {
    const sandboxId = config.daytona.sandboxId;
    super(
      {
        host: sandboxId ? toXumDaytonaHost(sandboxId) : config.host,
        srcBaseDir: config.srcBaseDir,
        bgOutputDir: config.bgOutputDir,
        identityFile: config.identityFile,
        port: config.port,
      },
      transport,
      options
    );
    this.daytonaConfig = config.daytona;
    this.daytonaService = daytonaService;
    this.workspaceId = options?.workspaceId;
    this.agentHomeSeedSources = options?.agentHomeSeedSources;
  }

  private sandboxMissing(sandboxId: string): EnsureReadyResult {
    return {
      ready: false,
      error:
        `Daytona sandbox "${sandboxId}" no longer exists (it was deleted outside Xum). ` +
        `Xum does not recreate it; delete this workspace or attach it to another sandbox.`,
      errorType: "runtime_not_ready",
    };
  }

  /** Keep cleanup hooks from starting a stopped (billed) sandbox through SSH. */
  async isRunningWithoutStart(_abortSignal: AbortSignal): Promise<boolean> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) return false;
    try {
      const { state } = await this.daytonaService.getSandboxState(sandboxId);
      return state === "started";
    } catch (error) {
      log.warn("Could not read Daytona sandbox state; treating it as not running", {
        sandboxId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Ready means started and reachable over ssh with a fresh token. A ready result is cached
   * per sandbox for 60 s (in the service: runtimes are recreated per stream), and concurrent
   * checks share one control-plane request. A sandbox removed outside Xum is reported, never
   * silently recreated.
   */
  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) {
      return {
        ready: false,
        error: "Daytona sandbox id not set",
        errorType: "runtime_not_ready",
      };
    }
    if (this.daytonaService.isSandboxReady(sandboxId)) {
      return { ready: true };
    }

    const emitStatus = makeStatusEmitter(options?.statusSink);
    emitStatus("checking");
    const failure = await this.bringSandboxUp(sandboxId, emitStatus, options?.signal);
    if (failure) return failure;
    return this.markReadyIfRepoPresent(sandboxId, options, emitStatus);
  }

  /** Start the sandbox if needed and refresh ssh access; a failure result, or undefined. */
  private async bringSandboxUp(
    sandboxId: string,
    emitStatus: StatusEmitter,
    signal: AbortSignal | undefined
  ): Promise<EnsureReadyResult | undefined> {
    try {
      await raceAbort(
        this.daytonaService.ensureSandboxReady(sandboxId, {
          onStarting: () => emitStatus("starting", "Starting sandbox..."),
        }),
        signal
      );
      return undefined;
    } catch (error) {
      emitStatus("error");
      return this.ensureReadyFailure(sandboxId, error, signal);
    }
  }

  private async markReadyIfRepoPresent(
    sandboxId: string,
    options: EnsureReadyOptions | undefined,
    emitStatus: StatusEmitter
  ): Promise<EnsureReadyResult> {
    const repoCheck = await this.checkWorkspaceRepo(options);
    if (repoCheck && !repoCheck.ready) {
      emitStatus("error", repoCheck.error);
      return repoCheck;
    }
    this.daytonaService.markSandboxReady(sandboxId);
    emitStatus("ready");
    return { ready: true };
  }

  private ensureReadyFailure(
    sandboxId: string,
    error: unknown,
    signal: AbortSignal | undefined
  ): EnsureReadyResult {
    if (signal?.aborted) {
      return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
    }
    if (error instanceof DaytonaApiError) {
      if (error.kind === "not_found") return this.sandboxMissing(sandboxId);
      if (error.kind === "not_configured" || error.kind === "unauthorized") {
        return { ready: false, error: error.message, errorType: "runtime_not_ready" };
      }
    }
    return {
      ready: false,
      error: `Failed to start Daytona sandbox: ${getErrorMessage(error)}`,
      errorType: "runtime_start_failed",
    };
  }

  /**
   * Fill in the sandbox identity after collision handling: a given `sandboxId` attaches to that
   * existing sandbox (shared, never deleted by Xum); none means Xum creates one with a fresh
   * name and the default size when none was chosen.
   */
  async finalizeConfig(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<RuntimeConfig, string>> {
    if (!isSSHRuntime(config) || !config.daytona) {
      return Ok(config);
    }
    const availability = await this.daytonaService.checkAvailability();
    if (!availability.available) {
      return Err(availability.reason);
    }

    const daytona = config.daytona;
    const existingId = daytona.sandboxId?.trim();
    if (existingId) {
      return Ok({
        ...config,
        host: toXumDaytonaHost(existingId),
        daytona: { ...daytona, sandboxId: existingId, shared: true },
      });
    }

    const preset = resolveSizePreset(daytona);
    if (!preset) {
      return Err(invalidSizeError());
    }
    const sandboxId = buildDaytonaSandboxName(finalBranchName);
    return Ok({
      ...config,
      host: toXumDaytonaHost(sandboxId),
      daytona: {
        ...daytona,
        sandboxId,
        shared: false,
        cpu: preset.cpu,
        memoryGiB: preset.memoryGiB,
        diskGiB: preset.diskGiB,
      },
    });
  }

  /**
   * Check before persisting: credentials, a preset size for new sandboxes (hand-edited
   * configs included), and that the sandbox to attach exists or the name to create is free.
   */
  async validateBeforePersist(
    _finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<void, string>> {
    if (!isSSHRuntime(config) || !config.daytona) {
      return Ok(undefined);
    }
    const availability = await this.daytonaService.checkAvailability();
    if (!availability.available) {
      return Err(availability.reason);
    }
    const daytona = config.daytona;
    const sandboxId = daytona.sandboxId;
    if (!sandboxId) {
      return Err("Daytona sandbox id is required (should be set by finalizeConfig)");
    }
    const attaching = daytona.shared === true;
    if (!attaching && !findDaytonaSizePreset(daytona)) {
      return Err(invalidSizeError());
    }
    return this.checkSandboxIdentity(sandboxId, attaching);
  }

  /** The sandbox to attach must exist; the name for a new one must be free. */
  private async checkSandboxIdentity(
    sandboxId: string,
    attaching: boolean
  ): Promise<Result<void, string>> {
    let exists: boolean;
    try {
      exists = (await this.daytonaService.getSandboxState(sandboxId)).state !== "missing";
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    if (attaching === exists) return Ok(undefined);
    return Err(
      attaching
        ? `Daytona sandbox "${sandboxId}" was not found`
        : `A Daytona sandbox named "${sandboxId}" already exists`
    );
  }

  /** The sandbox may not exist yet, so only compute the path (as Coder does). */
  override createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const workspacePath = this.getWorkspacePath(params.projectPath, params.directoryName);
    params.initLogger.logStep("Workspace path computed (Daytona provisioning will follow)");
    return Promise.resolve({ success: true, workspacePath });
  }

  /**
   * Provision the sandbox (unless attaching), wait until it runs, configure ssh, seed the
   * agent home and prepare the workspace directory. initWorkspace then runs the normal SSH
   * sync, worktree creation and init hook. If anything fails after the create request was
   * sent, the sandbox this call created is deleted again so it cannot linger and bill.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) {
      throw new Error("Daytona sandbox id is required (should be set by finalizeConfig)");
    }
    const creates = this.daytonaConfig.shared !== true;

    let createRequested = false;
    try {
      if (creates) {
        params.initLogger.logStep(`Creating Daytona sandbox "${sandboxId}"...`);
        createRequested = true;
        await this.createSandbox(sandboxId, params);
        params.initLogger.logStep("Daytona sandbox created");
      }
      await this.connectAndSeed(sandboxId, creates, params);
      await this.prepareWorkspaceDirectory(params);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      log.error("Daytona sandbox setup failed", { sandboxId, error: errorMsg });
      params.initLogger.logStderr(`Daytona sandbox setup failed: ${errorMsg}`);
      if (createRequested) {
        await this.deleteCreatedSandbox(sandboxId, params.initLogger);
      }
      throw new Error(`Daytona sandbox setup failed: ${errorMsg}`);
    }
  }

  /** Wait until the sandbox runs, write ssh access, and seed the home of a box Xum created. */
  private async connectAndSeed(
    sandboxId: string,
    seed: boolean,
    params: WorkspaceInitParams
  ): Promise<void> {
    const { initLogger, abortSignal } = params;
    initLogger.logStep("Waiting for the sandbox to start and configuring SSH...");
    await raceAbort(
      this.daytonaService.ensureSandboxReady(sandboxId, {
        onStarting: () => initLogger.logStep("Starting sandbox..."),
      }),
      abortSignal
    );
    if (!seed) return;
    initLogger.logStep("Copying agent hooks and global skills into the sandbox...");
    const count = await seedAgentHome(
      this,
      this.agentHomeSeedSources ?? { xumHome: getXumHome(), home: os.homedir() },
      abortSignal
    );
    initLogger.logStep(`Copied ${count} agent file(s)`);
  }

  /** git clone does not create the parent directory of the workspace. */
  private async prepareWorkspaceDirectory(params: WorkspaceInitParams): Promise<void> {
    params.initLogger.logStep("Preparing workspace directory...");
    const parentDir = path.posix.dirname(params.workspacePath);
    const mkdirResult = await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal: params.abortSignal,
    });
    if (mkdirResult.exitCode !== 0) {
      const errorMsg = mkdirResult.stderr || mkdirResult.stdout || "Unknown error";
      throw new Error(`Failed to prepare workspace directory: ${errorMsg}`);
    }
  }

  private async deleteCreatedSandbox(
    sandboxId: string,
    initLogger: WorkspaceInitParams["initLogger"]
  ): Promise<void> {
    try {
      initLogger.logStep(`Deleting the sandbox "${sandboxId}" this setup created...`);
      await this.daytonaService.deleteSandbox(sandboxId);
    } catch (error) {
      // The reconciler stops labeled, unreferenced sandboxes, so a leak here is bounded.
      const message = getErrorMessage(error);
      log.error("Failed to delete a Daytona sandbox after setup failed", {
        sandboxId,
        error: message,
      });
      initLogger.logStderr(`Failed to delete Daytona sandbox "${sandboxId}": ${message}`);
    }
  }

  /**
   * Create with the preset resources. Daytona rejects resources (HTTP 400) for snapshots with
   * fixed resources: then create with the snapshot's own size and resize to the preset.
   */
  private async createSandbox(sandboxId: string, params: WorkspaceInitParams): Promise<void> {
    const preset = resolveSizePreset(this.daytonaConfig);
    if (!preset) throw new Error(invalidSizeError());
    const base = {
      name: sandboxId,
      ...(this.daytonaConfig.snapshot ? { snapshot: this.daytonaConfig.snapshot } : {}),
      labels: await this.daytonaService.buildLabels({
        workspaceId: this.workspaceId ?? sandboxId,
        projectPath: params.projectPath,
      }),
      ...(await this.resolveTarget()),
      autoStopInterval: DAYTONA_AUTO_STOP_MINUTES,
      autoArchiveInterval: DAYTONA_AUTO_ARCHIVE_MINUTES,
      autoDeleteInterval: DAYTONA_AUTO_DELETE_DISABLED,
    };
    try {
      await this.daytonaService.createSandbox({
        ...base,
        cpu: preset.cpu,
        memory: preset.memoryGiB,
        disk: preset.diskGiB,
      });
      return;
    } catch (error) {
      if (!isBadRequest(error)) throw error;
      params.initLogger.logStep(
        `Daytona refused the size for this snapshot (${getErrorMessage(error)}); ` +
          `creating with the snapshot's size and resizing to ${preset.label}...`
      );
    }
    await this.daytonaService.createSandbox(base);
    await this.resizeToPreset(sandboxId, preset);
  }

  private async resolveTarget(): Promise<{ target?: string }> {
    const target = this.daytonaConfig.target ?? (await this.daytonaService.getDefaultTarget());
    return target ? { target } : {};
  }

  /**
   * A running sandbox can only grow cpu and memory; shrinking them or growing the disk needs a
   * stopped one. Disk never shrinks, so a larger snapshot disk is kept.
   */
  private async resizeToPreset(sandboxId: string, preset: DaytonaSizePreset): Promise<void> {
    const deadline = () => Date.now() + DAYTONA_START_TIMEOUT_MS;
    const sandbox = await this.daytonaService.startAndWait(sandboxId, deadline());
    const disk = growsDisk(sandbox, preset);
    const request = {
      cpu: preset.cpu,
      memory: preset.memoryGiB,
      ...(disk ? { disk: preset.diskGiB } : {}),
    };
    if (disk || shrinksCompute(sandbox, preset)) {
      await this.daytonaService.stopAndWait(sandboxId, deadline());
      await this.daytonaService.resizeSandbox(sandboxId, request);
    } else if (changesCompute(sandbox, preset)) {
      await this.daytonaService.resizeSandbox(sandboxId, request);
    }
    await this.daytonaService.startAndWait(sandboxId, deadline());
  }

  /**
   * Keep the inherited worktree fork (the child shares the parent's sandbox) and mark both
   * workspaces shared, so deleting either never deletes the sandbox under the other.
   */
  override async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const result = await super.forkWorkspace(params);
    // Sub-agents must share the parent's sandbox: never fall back to creating a new one.
    if (!result.success) return { ...result, failureIsFatal: true };

    const sharedDaytonaConfig = { ...this.daytonaConfig, shared: true };
    // So a postCreateSetup on this instance (for the fork) skips creating a sandbox.
    this.daytonaConfig = sharedDaytonaConfig;
    const sharedRuntimeConfig = {
      type: "ssh" as const,
      ...this.getConfig(),
      daytona: sharedDaytonaConfig,
    };
    return {
      ...result,
      forkedRuntimeConfig: sharedRuntimeConfig,
      sourceRuntimeConfig: sharedRuntimeConfig,
    };
  }

  /**
   * Delete the workspace; delete the sandbox too unless it is shared. The SSH dirty and
   * unpushed checks always run first, so a stopped or archived sandbox is started for them:
   * unlike Coder, never delete unchecked work to avoid a start. Force skips the checks.
   */
  override async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean,
    options?: { keepBranch?: boolean }
  ): Promise<DeleteResult> {
    const sandboxId = this.daytonaConfig.sandboxId;
    const shared = this.daytonaConfig.shared === true;
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);
    const sshDelete = () =>
      super.deleteWorkspace(projectPath, workspaceName, force, abortSignal, trusted, options);

    if (!sandboxId) {
      log.warn("Daytona sandbox id not set, falling back to SSH-only deletion");
      return sshDelete();
    }

    // Force ("cancel creation" or an explicit force delete): the sandbox may not be reachable
    // yet, so delete it without SSH. A shared sandbox only loses this workspace's checkout.
    if (force && !shared) {
      return this.deleteOwnedSandbox(sandboxId, deletedPath, undefined);
    }

    const prepared = await this.startForDeleteChecks(sandboxId, abortSignal);
    if (prepared === "missing") {
      return this.forgetMissingSandbox(sandboxId, deletedPath, shared);
    }
    // A forced delete still tries the SSH cleanup; a normal one never skips the checks.
    if (prepared !== "ready" && !force) {
      return { success: false, error: prepared.error };
    }
    return this.deleteAfterChecks(sandboxId, await sshDelete(), shared);
  }

  private forgetMissingSandbox(
    sandboxId: string,
    deletedPath: string,
    shared: boolean
  ): Promise<DeleteResult> {
    log.debug("Daytona sandbox already gone, skipping SSH cleanup", { sandboxId });
    // Still drop the token and include block of a sandbox this workspace owned.
    return shared
      ? Promise.resolve({ success: true, deletedPath })
      : this.deleteOwnedSandbox(sandboxId, deletedPath, undefined);
  }

  /** A failed check (dirty or unpushed work) keeps the workspace and its sandbox. */
  private deleteAfterChecks(
    sandboxId: string,
    sshResult: DeleteResult,
    shared: boolean
  ): Promise<DeleteResult> {
    if (!sshResult.success || shared) {
      return Promise.resolve(sshResult);
    }
    return this.deleteOwnedSandbox(sandboxId, sshResult.deletedPath, "SSH delete succeeded, but ");
  }

  /** Start the sandbox (if stopped or archived) so the dirty and unpushed checks can run. */
  private async startForDeleteChecks(
    sandboxId: string,
    abortSignal: AbortSignal | undefined
  ): Promise<"ready" | "missing" | { error: string }> {
    try {
      await raceAbort(this.daytonaService.ensureSandboxReady(sandboxId), abortSignal);
      return "ready";
    } catch (error) {
      if (error instanceof DaytonaApiError && error.kind === "not_found") return "missing";
      return {
        error:
          `Could not start Daytona sandbox "${sandboxId}" to check for uncommitted work: ` +
          `${getErrorMessage(error)}`,
      };
    }
  }

  private async deleteOwnedSandbox(
    sandboxId: string,
    deletedPath: string,
    errorPrefix: string | undefined
  ): Promise<DeleteResult> {
    try {
      await this.daytonaService.deleteSandbox(sandboxId);
      return { success: true, deletedPath };
    } catch (error) {
      const message = getErrorMessage(error);
      log.error("Failed to delete Daytona sandbox", { sandboxId, error: message });
      return {
        success: false,
        error: errorPrefix
          ? `${errorPrefix}failed to delete Daytona sandbox: ${message}`
          : `Failed to delete Daytona sandbox: ${message}`,
      };
    }
  }
}
