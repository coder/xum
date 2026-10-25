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

import { randomBytes } from "crypto";
import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  ExecOptions,
  InitLogger,
  RuntimeCreateFlags,
  RuntimeStatusEvent,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
} from "./Runtime";
import { isPermanentSSHFailure, isRuntimeTransportError, RuntimeError } from "./Runtime";
import type { SpawnResult } from "./RemoteRuntime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";
import {
  DAYTONA_DEFAULT_SIZE_PRESET_ID,
  DAYTONA_SIZE_PRESETS,
  findDaytonaSizePreset,
  toXumDaytonaHost,
  type DaytonaSizePreset,
} from "@/common/constants/daytona";
import type { DaytonaSandboxConfig, DaytonaSandboxState } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { DaytonaApiError, type DaytonaSandbox } from "@/node/services/daytona/daytonaClient";
import type {
  DaytonaAccount,
  UnsupportedDaytonaSandboxKind,
} from "@/node/services/daytona/daytonaAccount";
import type { DaytonaReadiness } from "@/node/services/daytona/daytonaReadiness";
import {
  DAYTONA_START_TIMEOUT_MS,
  type DaytonaSandboxes,
} from "@/node/services/daytona/daytonaSandboxes";
import type { DaytonaSsh } from "@/node/services/daytona/daytonaSsh";
import { log } from "@/node/services/log";
import {
  redactChildStderr,
  redactDaytonaError,
  redactDaytonaPty,
  redactDaytonaTokens,
} from "./daytonaTokenRedaction";

/** The DaytonaService parts this runtime uses (tests pass an in-memory fake). */
export interface DaytonaRuntimeService {
  account: Pick<DaytonaAccount, "checkAvailability" | "getDefaultTarget" | "findSnapshot">;
  readiness: Pick<
    DaytonaReadiness,
    "isSandboxReady" | "markSandboxReady" | "invalidateSandboxReady"
  >;
  ssh: Pick<
    DaytonaSsh,
    | "ensureSshAccess"
    | "replaceRejectedSshToken"
    | "sshTokenGeneration"
    | "gatewayGeneration"
    | "refreshGatewayAfterSshFailure"
    | "loadPersistedTokens"
    | "getGatewayConfig"
    | "releaseSshAccess"
  >;
  sandboxes: Pick<
    DaytonaSandboxes,
    | "getSandboxState"
    | "buildLabels"
    | "createSandbox"
    | "resizeSandbox"
    | "stopAndWait"
    | "startAndWait"
    | "deleteSandbox"
    | "ensureSandboxReady"
  >;
}

export interface DaytonaSSHRuntimeConfig extends SSHRuntimeConfig {
  daytona: DaytonaSandboxConfig;
}

export interface DaytonaSSHRuntimeOptions {
  projectPath?: string;
  workspaceName?: string;
  workspacePath?: string;
  /** Labels the created sandbox, so the reconciler can tell which workspace it belongs to. */
  workspaceId?: string;
}

/** Idle sandboxes stop after 30 minutes and archive after a day stopped; never auto-delete. */
const DAYTONA_AUTO_STOP_MINUTES = 30;
const DAYTONA_AUTO_ARCHIVE_MINUTES = 1440;
const DAYTONA_AUTO_DELETE_DISABLED = -1;

const SANDBOX_NAME_MAX_BRANCH_LENGTH = 40;
const UNSUPPORTED_SANDBOXES: Record<UnsupportedDaytonaSandboxKind, { label: string; why: string }> =
  {
    windows: {
      label: "Windows",
      why: "Xum sets up and runs a workspace over SSH with Linux shell commands, so it needs a Linux sandbox.",
    },
    gpu: {
      label: "GPU",
      why: "GPU sandboxes are ephemeral: Daytona deletes one when it stops, and a workspace's sandbox stops when idle, so its checkout would be lost.",
    },
  };

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

/**
 * Captured before an ssh command: a recovery acts only on what changed since. A refusal
 * replaces only the token this command used; a gateway another failure already followed is
 * not refetched again.
 */
interface SshAttempt {
  tokenGeneration: number;
  gatewayGeneration: number;
}

type DeleteResult =
  | { success: true; deletedPath: string }
  | { success: false; error: string; leftoverPaths?: string[] };

type StatusEmitter = (phase: RuntimeStatusEvent["phase"], detail?: string) => void;

const HOST_KEY_FAILURE = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join("\n");
}

/** The gateway refused the token (the ssh user name), e.g. one revoked outside Xum. */
function isTokenRejected(error: unknown): boolean {
  return (
    isRuntimeTransportError(error) &&
    isPermanentSSHFailure(error) &&
    !HOST_KEY_FAILURE.test(errorChainText(error))
  );
}

function sandboxMissingMessage(sandboxId: string): string {
  return (
    `Daytona sandbox "${sandboxId}" no longer exists. Archiving or removing the workspace ` +
    `that created it deletes it, and Xum does not recreate it; delete this workspace.`
  );
}

function redactingInitLogger(initLogger: InitLogger): InitLogger {
  return {
    ...initLogger,
    logStep: (line) => initLogger.logStep(redactDaytonaTokens(line)),
    logStdout: (line) => initLogger.logStdout(redactDaytonaTokens(line)),
    logStderr: (line) => initLogger.logStderr(redactDaytonaTokens(line)),
  };
}

function makeStatusEmitter(statusSink: EnsureReadyOptions["statusSink"]): StatusEmitter {
  return (phase, detail) => statusSink?.({ phase, runtimeType: "ssh", detail });
}

/**
 * As for Coder: a stopped or archived sandbox is never started for SSH cleanup, so its checks
 * are skipped. An unreadable state tries SSH, which fails rather than deleting unchecked work.
 */
function reachableForCleanup(state: string | undefined): boolean {
  return state !== "missing" && state !== "stopped" && state !== "archived";
}

function growsDisk(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return sandbox.disk !== undefined && sandbox.disk < preset.diskGiB;
}

/**
 * A running sandbox can only grow cpu and memory. An unreported value may be above the preset,
 * so it is resized stopped, where either direction is allowed.
 */
function shrinksCompute(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return (sandbox.cpu ?? Infinity) > preset.cpu || (sandbox.memory ?? Infinity) > preset.memoryGiB;
}

function changesCompute(sandbox: DaytonaSandbox, preset: DaytonaSizePreset): boolean {
  return sandbox.cpu !== preset.cpu || sandbox.memory !== preset.memoryGiB;
}

/**
 * IMPORTANT: extends SSHRuntime (rather than delegating) so code that checks
 * `runtime instanceof SSHRuntime` (PTY, tools, MCP, bash AI proxy) treats Daytona as SSH.
 */
export class DaytonaSSHRuntime extends SSHRuntime {
  private readonly daytonaConfig: DaytonaSandboxConfig;
  private readonly daytonaService: DaytonaRuntimeService;
  private readonly workspaceId?: string;
  /**
   * Set once ensureReady runs its checks on this instance. Only such a runtime (a turn's or a
   * terminal's) restarts a sandbox that stopped under it; UI and background runtimes never
   * start a billed sandbox.
   */
  private restartsStoppedSandbox = false;
  /** SSHRuntime keeps its own reference private; a replaced token needs its backoff reset. */
  private readonly sshTransport: SSHTransport;

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
    this.sshTransport = transport;
    this.daytonaService = daytonaService;
    this.workspaceId = options?.workspaceId;
  }

  private sandboxMissing(sandboxId: string): EnsureReadyResult {
    return {
      ready: false,
      error: sandboxMissingMessage(sandboxId),
      errorType: "runtime_not_ready",
    };
  }

  /** Keep cleanup hooks from starting a stopped (billed) sandbox through SSH. */
  async isRunningWithoutStart(_abortSignal: AbortSignal): Promise<boolean> {
    const sandboxId = this.daytonaConfig.sandboxId;
    return sandboxId ? this.isSandboxStarted(sandboxId) : false;
  }

  private async isSandboxStarted(sandboxId: string): Promise<boolean> {
    return (await this.readSandboxState(sandboxId)) === "started";
  }

  /** Undefined when the state cannot be read: callers treat that as not running. */
  private async readSandboxState(sandboxId: string): Promise<string | undefined> {
    try {
      return (await this.daytonaService.sandboxes.getSandboxState(sandboxId)).state;
    } catch (error) {
      log.warn("Could not read Daytona sandbox state; treating it as not running", {
        sandboxId,
        error: getErrorMessage(error),
      });
      return undefined;
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
    const emitStatus = makeStatusEmitter(options?.statusSink);
    // An external client reads the user's ssh config, which the cache does not cover: another
    // tool may have removed the managed block since. Only a full check writes it again.
    if (!options?.externalSshClient && this.daytonaService.readiness.isSandboxReady(sandboxId)) {
      return this.ensureReadyFromCache(options, emitStatus);
    }
    return this.ensureReadyUncached(sandboxId, options, emitStatus);
  }

  private async ensureReadyUncached(
    sandboxId: string,
    options: EnsureReadyOptions | undefined,
    emitStatus: StatusEmitter
  ): Promise<EnsureReadyResult> {
    emitStatus("checking");
    const failure = await this.bringSandboxUp(sandboxId, emitStatus, options?.signal);
    if (failure) return failure;
    const result = await this.markReadyIfRepoPresent(sandboxId, options, emitStatus);
    if (result.ready) this.restartsStoppedSandbox = true;
    return result;
  }

  /** The cache covers the sandbox, not this workspace's checkout: a fork shares the sandbox. */
  private async ensureReadyFromCache(
    options: EnsureReadyOptions | undefined,
    emitStatus: StatusEmitter
  ): Promise<EnsureReadyResult> {
    // Set before the probe: ensureReady is an explicit action, so a sandbox that stopped
    // within the cache is started again (recoverForRetry) instead of failing until it expires.
    this.restartsStoppedSandbox = true;
    const repoFailure = await this.checkRepo(options, emitStatus);
    if (repoFailure) return repoFailure;
    return { ready: true };
  }

  /**
   * Every ssh command to the sandbox goes through here: its stderr and errors are redacted
   * (the token is the ssh user name). A refused token is replaced, and a connection failure on
   * a turn's runtime whose sandbox stopped within the ready cache starts the sandbox again (or,
   * when it still runs, follows a gateway Daytona moved); either way the command is retried
   * once.
   */
  protected override async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    let result: SpawnResult;
    const sandboxId = this.daytonaConfig.sandboxId;
    const attempt = await this.prepareSshAttempt(sandboxId);
    try {
      result = await super.spawnRemoteProcess(fullCommand, options);
    } catch (error) {
      if (!(await this.recoverForRetry(error, attempt, options.abortSignal))) {
        throw redactDaytonaError(error);
      }
      try {
        result = await super.spawnRemoteProcess(fullCommand, options);
      } catch (retryError) {
        throw redactDaytonaError(retryError);
      }
    }
    redactChildStderr(result.process);
    const onExit = result.onExit;
    return {
      ...result,
      onExit: (exitCode, stderr) => {
        // The ready cache must not hide a sandbox that stopped: the next ensureReady checks.
        if (sandboxId && this.isTransportFailureExit(exitCode, stderr)) {
          this.daytonaService.readiness.invalidateSandboxReady(sandboxId);
        }
        onExit?.(exitCode, stderr);
      },
    };
  }

  /** What a recovery from this command's failure must compare against (see SshAttempt). */
  private async prepareSshAttempt(sandboxId: string | undefined): Promise<SshAttempt> {
    if (!sandboxId) return { tokenGeneration: 0, gatewayGeneration: 0 };
    // ssh may send a token an earlier process left in the include file: the redactor must
    // know it before ssh can quote it. Not every command runs after ensureReady.
    await this.daytonaService.ssh.loadPersistedTokens();
    return {
      tokenGeneration: this.daytonaService.ssh.sshTokenGeneration(sandboxId),
      gatewayGeneration: this.daytonaService.ssh.gatewayGeneration(),
    };
  }

  /**
   * True when the failure was fixed (a new token, or a restarted sandbox) and a retry may pass.
   * The sandbox state decides, not the error text: a stopped or deleted sandbox also answers
   * "Permission denied", so only a started sandbox gets a new token. Throws a clear error for
   * a sandbox deleted outside Xum.
   */
  private async recoverForRetry(
    error: unknown,
    attempt: SshAttempt,
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId || !isRuntimeTransportError(error) || abortSignal?.aborted) return false;
    const tokenRejected = isTokenRejected(error);
    // A UI or background runtime never starts the sandbox, so only a refused token is worth a look.
    if (!tokenRejected && !this.restartsStoppedSandbox) return false;
    this.daytonaService.readiness.invalidateSandboxReady(sandboxId);
    const state = await this.readStateAfterFailure(sandboxId);
    return this.recoverInState(sandboxId, state, { error, tokenRejected, attempt }, abortSignal);
  }

  private recoverInState(
    sandboxId: string,
    state: DaytonaSandboxState | undefined,
    failure: { error: unknown; tokenRejected: boolean; attempt: SshAttempt },
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    const { error, tokenRejected, attempt } = failure;
    if (state === "missing") {
      throw new RuntimeError(
        sandboxMissingMessage(sandboxId),
        "network",
        redactDaytonaError(error)
      );
    }
    if (state === "started") {
      // Only a runtime that may restart the sandbox gets here without a refused token.
      return tokenRejected
        ? this.replaceRejectedToken(sandboxId, attempt.tokenGeneration)
        : this.followMovedGateway(sandboxId, attempt.gatewayGeneration);
    }
    if (state === undefined || !this.restartsStoppedSandbox) return Promise.resolve(false);
    return this.restartSandbox(sandboxId, abortSignal);
  }

  private async replaceRejectedToken(sandboxId: string, tokenGeneration: number): Promise<boolean> {
    log.info("The Daytona gateway refused the ssh token; replacing it and retrying once", {
      sandboxId,
    });
    try {
      await this.daytonaService.ssh.replaceRejectedSshToken(sandboxId, tokenGeneration);
    } catch (replaceError) {
      log.warn("Could not replace the refused Daytona ssh token", {
        sandboxId,
        error: getErrorMessage(redactDaytonaError(replaceError)),
      });
      return false;
    }
    this.sshTransport.resetConnectionHealth?.();
    return true;
  }

  private async followMovedGateway(sandboxId: string, gatewayGeneration: number): Promise<boolean> {
    let moved: boolean;
    try {
      moved = await this.daytonaService.ssh.refreshGatewayAfterSshFailure(
        sandboxId,
        gatewayGeneration
      );
    } catch (refreshError) {
      log.warn("Could not refetch the Daytona gateway after an ssh failure", {
        sandboxId,
        error: getErrorMessage(redactDaytonaError(refreshError)),
      });
      return false;
    }
    if (!moved) return false;
    log.info("The Daytona gateway moved; retrying the command once", { sandboxId });
    // A host key failure against the old gateway may have marked the alias as failing for good.
    this.sshTransport.resetConnectionHealth?.();
    return true;
  }

  private async restartSandbox(
    sandboxId: string,
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    log.info("Daytona sandbox is not running; starting it and retrying the command once", {
      sandboxId,
    });
    const failure = await this.bringSandboxUp(sandboxId, () => undefined, abortSignal);
    if (failure && !failure.ready) {
      log.warn("Could not restart the Daytona sandbox", { sandboxId, error: failure.error });
      return false;
    }
    return true;
  }

  /** Undefined when the state cannot be read (then nothing is retried). */
  private async readStateAfterFailure(sandboxId: string): Promise<DaytonaSandboxState | undefined> {
    try {
      return (await this.daytonaService.sandboxes.getSandboxState(sandboxId)).state;
    } catch (stateError) {
      log.warn("Could not read Daytona sandbox state after an ssh failure", {
        sandboxId,
        error: getErrorMessage(stateError),
      });
      return undefined;
    }
  }

  /**
   * A terminal goes straight to ssh, so it brings the sandbox up first (a stopped or archived
   * sandbox starts, an expiring token is replaced). The user opened it, so starting the
   * billed sandbox is expected, as for a turn.
   */
  override async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    const ready = await this.ensureReady();
    if (!ready.ready) throw new Error(ready.error);
    return redactDaytonaPty(await super.createPtySession(params));
  }

  /** Init output (sync, git push, hook) can quote ssh's stderr, so it is redacted too. */
  override async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    try {
      const result = await super.initWorkspace({
        ...params,
        initLogger: redactingInitLogger(params.initLogger),
      });
      return result.error ? { ...result, error: redactDaytonaTokens(result.error) } : result;
    } catch (error) {
      throw redactDaytonaError(error);
    }
  }

  /** Start the sandbox if needed and refresh ssh access; a failure result, or undefined. */
  private async bringSandboxUp(
    sandboxId: string,
    emitStatus: StatusEmitter,
    signal: AbortSignal | undefined
  ): Promise<EnsureReadyResult | undefined> {
    try {
      await this.daytonaService.sandboxes.ensureSandboxReady(sandboxId, {
        onStarting: () => emitStatus("starting", "Starting sandbox..."),
        signal,
      });
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
    const repoFailure = await this.checkRepo(options, emitStatus);
    if (repoFailure) return repoFailure;
    this.daytonaService.readiness.markSandboxReady(sandboxId);
    emitStatus("ready");
    return { ready: true };
  }

  /** The failure when this workspace's checkout is missing or broken; reports ready otherwise. */
  private async checkRepo(
    options: EnsureReadyOptions | undefined,
    emitStatus: StatusEmitter
  ): Promise<EnsureReadyResult | undefined> {
    const repoCheck = await this.checkWorkspaceRepo(options);
    if (!repoCheck) return undefined;
    if (!repoCheck.ready) {
      emitStatus("error", repoCheck.error);
      return repoCheck;
    }
    emitStatus("ready");
    return undefined;
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
   * Fill in the sandbox identity after collision handling: Xum creates a sandbox with a fresh
   * name, and the default size when none was chosen.
   */
  async finalizeConfig(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<RuntimeConfig, string>> {
    if (!isSSHRuntime(config) || !config.daytona) {
      return Ok(config);
    }
    const availability = await this.daytonaService.account.checkAvailability();
    if (!availability.available) {
      return Err(availability.reason);
    }

    const daytona = config.daytona;
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
        // A creation request never reuses a sandbox, whatever a hand-edited config says.
        forked: undefined,
        cpu: preset.cpu,
        memoryGiB: preset.memoryGiB,
        diskGiB: preset.diskGiB,
      },
    });
  }

  /**
   * Check before persisting: credentials, a preset size (hand-edited configs included), a free
   * name and a snapshot Xum can use.
   */
  async validateBeforePersist(
    _finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<void, string>> {
    if (!isSSHRuntime(config) || !config.daytona) {
      return Ok(undefined);
    }
    const availability = await this.daytonaService.account.checkAvailability();
    if (!availability.available) {
      return Err(availability.reason);
    }
    const daytona = config.daytona;
    const sandboxId = daytona.sandboxId;
    if (!sandboxId) {
      return Err("Daytona sandbox id is required (should be set by finalizeConfig)");
    }
    return this.checkNewSandbox(sandboxId, daytona);
  }

  /** A sandbox Xum creates: a preset size, a free name, and a snapshot that is not Windows. */
  private async checkNewSandbox(
    sandboxId: string,
    daytona: DaytonaSandboxConfig
  ): Promise<Result<void, string>> {
    if (!findDaytonaSizePreset(daytona)) return Err(invalidSizeError());
    const nameFree = await this.checkNameFree(sandboxId);
    if (!nameFree.success) return nameFree;
    return daytona.snapshot
      ? this.checkSnapshotClass(daytona.snapshot)
      : this.checkDefaultSnapshotClass();
  }

  /**
   * "Daytona default" creates from the snapshot the deployment advertises, so a Windows or
   * inactive default is refused like a chosen one. A default the organization cannot look up
   * is Daytona's to resolve at create time, as when none is advertised.
   */
  private async checkDefaultSnapshotClass(): Promise<Result<void, string>> {
    let snapshot: string | undefined;
    try {
      snapshot = (await this.daytonaService.ssh.getGatewayConfig()).defaultSnapshot;
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    return snapshot ? this.checkSnapshotClass(snapshot, { missingOk: true }) : Ok(undefined);
  }

  private async checkNameFree(sandboxId: string): Promise<Result<void, string>> {
    let state: DaytonaSandboxState;
    try {
      state = (await this.daytonaService.sandboxes.getSandboxState(sandboxId)).state;
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    return state === "missing"
      ? Ok(undefined)
      : Err(`A Daytona sandbox named "${sandboxId}" already exists`);
  }

  /** Refused before any sandbox is created: a Windows snapshot makes a billed box setup fails on. */
  private async checkSnapshotClass(
    snapshot: string,
    options?: { missingOk: boolean }
  ): Promise<Result<void, string>> {
    let found: Awaited<ReturnType<DaytonaAccount["findSnapshot"]>>;
    try {
      found = await this.daytonaService.account.findSnapshot(snapshot);
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    // A stale choice (deleted after it was saved as a default) would fail every setup retry.
    if (!found) {
      if (options?.missingOk) return Ok(undefined);
      return Err(`Daytona snapshot "${snapshot}" was not found; pick another snapshot`);
    }
    if (found.unsupported) {
      const { label, why } = UNSUPPORTED_SANDBOXES[found.unsupported];
      return Err(`Daytona snapshot "${snapshot}" creates ${label} sandboxes. ${why}`);
    }
    return Ok(undefined);
  }

  /** The sandbox may not exist yet, so only compute the path (as Coder does). */
  override createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const workspacePath = this.getWorkspacePath(params.projectPath, params.directoryName);
    params.initLogger.logStep("Workspace path computed (Daytona provisioning will follow)");
    return Promise.resolve({ success: true, workspacePath });
  }

  /**
   * Provision the sandbox (unless forked), wait until it runs, configure ssh and prepare
   * the workspace directory. initWorkspace then runs the normal SSH
   * sync, worktree creation and init hook. If anything fails after the create request was
   * sent, the sandbox this call created is deleted again so it cannot linger and bill.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) {
      throw new Error("Daytona sandbox id is required (should be set by finalizeConfig)");
    }
    // A fork reuses its source's sandbox: create nothing (and so never delete it on failure).
    const creates = this.daytonaConfig.forked !== true;

    try {
      if (creates) {
        params.initLogger.logStep(`Creating Daytona sandbox "${sandboxId}"...`);
        await this.createSandbox(sandboxId, params);
        params.initLogger.logStep("Daytona sandbox created");
      }
      await this.connect(sandboxId, params);
      await this.prepareWorkspaceParentDirectory(params);
    } catch (error) {
      const errorMsg = redactDaytonaTokens(getErrorMessage(error));
      log.error("Daytona sandbox setup failed", { sandboxId, error: errorMsg });
      params.initLogger.logStderr(`Daytona sandbox setup failed: ${errorMsg}`);
      // A failed create may still have made the sandbox (a timeout, a 5xx); deleteSandbox keeps
      // one without this install's label.
      if (creates) await this.deleteCreatedSandbox(sandboxId, params.initLogger);
      throw new Error(`Daytona sandbox setup failed: ${errorMsg}`);
    }
  }

  /** Wait until the sandbox runs and write ssh access. */
  private async connect(sandboxId: string, params: WorkspaceInitParams): Promise<void> {
    const { initLogger, abortSignal } = params;
    initLogger.logStep("Waiting for the sandbox to start and configuring SSH...");
    await this.daytonaService.sandboxes.ensureSandboxReady(sandboxId, {
      onStarting: () => initLogger.logStep("Starting sandbox..."),
      signal: abortSignal,
    });
  }

  private async deleteCreatedSandbox(
    sandboxId: string,
    initLogger: WorkspaceInitParams["initLogger"]
  ): Promise<void> {
    try {
      initLogger.logStep(`Deleting the sandbox "${sandboxId}" this setup created...`);
      await this.daytonaService.sandboxes.deleteSandbox(sandboxId);
    } catch (error) {
      // The persisted workspace still names the sandbox; removing the workspace deletes it.
      const message = getErrorMessage(error);
      log.error("Failed to delete a Daytona sandbox after setup failed", {
        sandboxId,
        error: message,
      });
      initLogger.logStderr(
        `Failed to delete Daytona sandbox "${sandboxId}": ${message}. The sandbox is kept; ` +
          "removing this workspace deletes it."
      );
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
      labels: await this.daytonaService.sandboxes.buildLabels({
        workspaceId: this.workspaceId ?? sandboxId,
        projectPath: params.projectPath,
      }),
      ...(await this.resolveTarget()),
      autoStopInterval: DAYTONA_AUTO_STOP_MINUTES,
      autoArchiveInterval: DAYTONA_AUTO_ARCHIVE_MINUTES,
      autoDeleteInterval: DAYTONA_AUTO_DELETE_DISABLED,
    };
    try {
      await this.daytonaService.sandboxes.createSandbox({
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
    await this.daytonaService.sandboxes.createSandbox(base);
    await this.resizeToPreset(sandboxId, preset);
  }

  private async resolveTarget(): Promise<{ target?: string }> {
    const target =
      this.daytonaConfig.target ?? (await this.daytonaService.account.getDefaultTarget());
    return target ? { target } : {};
  }

  /**
   * A running sandbox can only grow cpu and memory; shrinking them or growing the disk needs a
   * stopped one. Disk never shrinks, so a larger snapshot disk is kept.
   */
  private async resizeToPreset(sandboxId: string, preset: DaytonaSizePreset): Promise<void> {
    const deadline = () => Date.now() + DAYTONA_START_TIMEOUT_MS;
    const sandbox = await this.daytonaService.sandboxes.startAndWait(sandboxId, deadline());
    const disk = growsDisk(sandbox, preset);
    const request = {
      cpu: preset.cpu,
      memory: preset.memoryGiB,
      ...(disk ? { disk: preset.diskGiB } : {}),
    };
    if (disk || shrinksCompute(sandbox, preset)) {
      await this.daytonaService.sandboxes.stopAndWait(sandboxId, deadline());
      await this.daytonaService.sandboxes.resizeSandbox(sandboxId, request);
    } else if (changesCompute(sandbox, preset)) {
      await this.daytonaService.sandboxes.resizeSandbox(sandboxId, request);
    }
    await this.daytonaService.sandboxes.startAndWait(sandboxId, deadline());
  }

  /**
   * Keep the inherited worktree fork: the child reuses the parent's sandbox (`forked`, so its
   * setup creates none, and its archive or removal never stops or deletes the sandbox). The
   * user asked for the fork, so a stopped or archived source sandbox is started first, as for
   * a terminal.
   */
  override async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const ready = await this.ensureReady();
    if (!ready.ready) return { success: false, error: ready.error, failureIsFatal: true };
    const result = await super.forkWorkspace(params);
    // Sub-agents must share the parent's sandbox: never fall back to creating a new one.
    if (!result.success) return { ...result, failureIsFatal: true };
    return {
      ...result,
      forkedRuntimeConfig: {
        type: "ssh" as const,
        ...this.getConfig(),
        daytona: { ...this.daytonaConfig, forked: true },
      },
    };
  }

  /**
   * Delete the workspace, and the sandbox too when this workspace created it (a fork only
   * deletes its checkout). The SSH dirty and unpushed checks run first on a running sandbox. As
   * for Coder, a stopped or archived one is never started for them, so its work goes unchecked.
   * Force skips the checks, and deletes the sandbox without SSH.
   */
  override async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean,
    options?: { keepBranch?: boolean }
  ): Promise<DeleteResult> {
    const sshDelete = () =>
      super.deleteWorkspace(projectPath, workspaceName, force, abortSignal, trusted, options);
    return this.deleteWorkspaceAndSandbox(
      this.getWorkspacePath(projectPath, workspaceName),
      force,
      sshDelete
    );
  }

  private async deleteWorkspaceAndSandbox(
    deletedPath: string,
    force: boolean,
    sshDelete: () => Promise<DeleteResult>
  ): Promise<DeleteResult> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) {
      log.warn("Daytona sandbox id not set, falling back to SSH-only deletion");
      return sshDelete();
    }
    const reachable = reachableForCleanup(await this.readSandboxState(sandboxId));
    if (this.daytonaConfig.forked === true) {
      return reachable
        ? this.deleteForkCheckout(sandboxId, deletedPath, force, sshDelete)
        : { success: true, deletedPath };
    }
    if (force || !reachable) return this.deleteOwnedSandbox(sandboxId, deletedPath);
    const sshResult = await sshDelete();
    return sshResult.success
      ? this.deleteOwnedSandbox(sandboxId, deletedPath, "SSH delete succeeded, but ")
      : sshResult;
  }

  /**
   * A fork's removal deletes only its checkout: the sandbox belongs to the workspace that
   * created it. A forced removal goes on when the checkout cannot be deleted.
   */
  private async deleteForkCheckout(
    sandboxId: string,
    deletedPath: string,
    force: boolean,
    sshDelete: () => Promise<DeleteResult>
  ): Promise<DeleteResult> {
    const result = await sshDelete();
    if (result.success || !force) return result;
    log.warn("Left a fork's checkout on its Daytona sandbox", { sandboxId, deletedPath });
    return { success: true, deletedPath };
  }

  private async deleteOwnedSandbox(
    sandboxId: string,
    deletedPath: string,
    errorPrefix?: string
  ): Promise<DeleteResult> {
    try {
      await this.daytonaService.sandboxes.deleteSandbox(sandboxId);
      return { success: true, deletedPath };
    } catch (error) {
      const message = getErrorMessage(error);
      log.error("Failed to delete Daytona sandbox", { sandboxId, error: message });
      return {
        success: false,
        error: errorPrefix
          ? `${errorPrefix}failed to delete Daytona sandbox: ${message}`
          : `Failed to delete Daytona sandbox: ${message}`,
        // A forced removal goes on without it: remove shows this as a warning to act on.
        leftoverPaths: [`Daytona sandbox "${sandboxId}"`],
      };
    }
  }
}
