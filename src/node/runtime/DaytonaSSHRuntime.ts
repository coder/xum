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
import { getXumHome } from "@/common/constants/paths";
import type { DaytonaSandboxConfig, DaytonaSandboxState } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { DaytonaApiError, type DaytonaSandbox } from "@/node/services/daytona/daytonaClient";
import {
  DAYTONA_LABEL_INSTANCE,
  DAYTONA_LABEL_WORKSPACE_ID,
  DAYTONA_START_TIMEOUT_MS,
  unsupportedDaytonaSandboxKind,
  type UnsupportedDaytonaSandboxKind,
  type DaytonaAccount,
  type DaytonaService,
} from "@/node/services/daytona/daytonaService";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { seedAgentHome, type AgentHomeSeedSources } from "./daytonaAgentHomeSeed";
import { expandTildeForSSH } from "./tildeExpansion";
import {
  redactChildStderr,
  redactDaytonaError,
  redactDaytonaPty,
  redactDaytonaTokens,
} from "./daytonaTokenRedaction";

/** The DaytonaService surface this runtime uses (tests pass an in-memory fake). */
export type DaytonaRuntimeService = Pick<
  DaytonaService,
  | "checkAvailability"
  | "getSandboxState"
  | "withAccountLease"
  | "getAccount"
  | "isAccountCurrent"
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
  | "invalidateSandboxReady"
  | "replaceRejectedSshToken"
  | "sshTokenGeneration"
  | "findSnapshot"
  | "getGatewayConfig"
  | "sandboxReferencesElsewhere"
  | "isAliasStoredElsewhere"
  | "withSandboxRemovalLock"
  | "waitUntilDestroyed"
  | "recordWorkspaceRemoval"
  | "releaseSshAccess"
  | "disownSandbox"
  | "recordSetupFailure"
  | "getSetupFailure"
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
const SETTINGS_CHANGED_DURING_SETUP =
  "Daytona settings changed while the sandbox was set up; create the workspace again";
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
 * What a failed setup may delete: "none" before any create, "created" after a create that
 * succeeded, "unknown" after a failed one. A failed create may still have created the sandbox
 * (a timeout, a 5xx), or the name may belong to another install's sandbox (a 409 when it was
 * taken after validateBeforePersist): only the labels tell, so they are checked first.
 */
type CreateOutcome = "none" | "created" | "unknown";

interface CreateAttempt {
  outcome: CreateOutcome;
  /** The labels the last create request carried. */
  labels?: Record<string, string>;
  /** The account the create requests went to: cleanup deletes there, whatever Settings say. */
  account?: DaytonaAccount;
}

type DeleteResult =
  | { success: true; deletedPath: string; notice?: string }
  | { success: false; error: string; leftoverPaths?: string[] };

type StatusEmitter = (phase: RuntimeStatusEvent["phase"], detail?: string) => void;

/**
 * What deleting a workspace does to its sandbox: "keep" it (another workspace, archived ones
 * included, still references it), "handOff" (keep it for workspaces that only attached it, so
 * Xum no longer deletes it), "release" only Xum's ssh access (the last workspace on an attached
 * sandbox), or "delete" it (the last workspace on a sandbox Xum created).
 */
type SandboxFate = "keep" | "handOff" | "release" | "delete";

/** A removal whose checkout step is done (or skipped), before its sandbox's fate is applied. */
interface RemovedCheckout {
  success: true;
  deletedPath: string;
  notice?: string;
}

/** `errorPrefix` leads a failure reported after the checkout was already deleted over SSH. */
interface SandboxRemoval {
  force: boolean;
  errorPrefix?: string;
}

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
    `Daytona sandbox "${sandboxId}" no longer exists (it was deleted outside Xum). ` +
    `Xum does not recreate it; delete this workspace or attach it to another sandbox.`
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
 * An unreported disk is left as it is: the snapshot's may be larger than the preset's, and
 * sending the preset would then be a shrink Daytona refuses, failing (and deleting) the sandbox.
 */
/**
 * Only an active snapshot creates sandboxes (SnapshotState: building, pending, pulling,
 * snapshotting, inactive, error, build_failed, removing do not); none reported passes.
 */
function snapshotStateRefusal(snapshot: string, state: string | undefined): string | undefined {
  if (!state || state === "active") return undefined;
  const next =
    state === "inactive"
      ? "activate it in Daytona or pick another snapshot"
      : "pick another snapshot";
  return `Daytona snapshot "${snapshot}" is ${state}, not active; ${next}`;
}

/** Why an existing sandbox cannot be attached, before the workspace is persisted. */
function attachRefusal(
  sandboxId: string,
  state: DaytonaSandboxState,
  sandbox: DaytonaSandbox
): string | undefined {
  const unsupported = unsupportedDaytonaSandboxKind(sandbox);
  if (unsupported) {
    const { label, why } = UNSUPPORTED_SANDBOXES[unsupported];
    return `Daytona sandbox "${sandboxId}" is a ${label} sandbox. ${why}`;
  }
  // Setup's start never brings an error state up, so every retry would fail.
  if (state !== "error") return undefined;
  const reason = sandbox.errorReason ? ` (${sandbox.errorReason})` : "";
  return (
    `Daytona sandbox "${sandboxId}" is in state ${sandbox.state ?? "unknown"}${reason}, ` +
    "which Xum cannot start; pick another sandbox"
  );
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
  private readonly agentHomeSeedSources?: AgentHomeSeedSources;
  /**
   * Set once ensureReady passes on this instance. Only such a runtime (a turn's) restarts a
   * sandbox that stopped under it; UI and background runtimes never start a billed sandbox.
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
    this.agentHomeSeedSources = options?.agentHomeSeedSources;
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
      return (await this.daytonaService.getSandboxState(sandboxId)).state;
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
  override ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    return this.daytonaService.withAccountLease(async () => {
      const sandboxId = this.daytonaConfig.sandboxId;
      if (!sandboxId) {
        return {
          ready: false,
          error: "Daytona sandbox id not set",
          errorType: "runtime_not_ready",
        };
      }
      const setupFailure = this.setupFailureResult(sandboxId);
      if (setupFailure) return setupFailure;
      const emitStatus = makeStatusEmitter(options?.statusSink);
      if (this.daytonaService.isSandboxReady(sandboxId)) {
        return this.ensureReadyFromCache(options, emitStatus);
      }

      emitStatus("checking");
      const failure = await this.bringSandboxUp(sandboxId, emitStatus, options?.signal);
      if (failure) return failure;
      const result = await this.markReadyIfRepoPresent(sandboxId, options, emitStatus);
      if (result.ready) this.restartsStoppedSandbox = true;
      return result;
    });
  }

  private setupFailureResult(sandboxId: string): EnsureReadyResult | undefined {
    const setupFailure = this.daytonaService.getSetupFailure(sandboxId);
    if (!setupFailure) return undefined;
    return {
      ready: false,
      error:
        `Daytona sandbox setup failed: ${setupFailure}. Delete this workspace (which deletes ` +
        `any sandbox its setup left) and create a new one.`,
      errorType: "runtime_not_ready",
    };
  }

  /** The cache covers the sandbox, not this workspace's checkout: a fork shares the sandbox. */
  private async ensureReadyFromCache(
    options: EnsureReadyOptions | undefined,
    emitStatus: StatusEmitter
  ): Promise<EnsureReadyResult> {
    const repoFailure = await this.checkRepo(options, emitStatus);
    if (repoFailure) return repoFailure;
    this.restartsStoppedSandbox = true;
    return { ready: true };
  }

  /**
   * Every ssh command to the sandbox goes through here: its stderr and errors are redacted
   * (the token is the ssh user name). A refused token is replaced, and a connection failure on
   * a turn's runtime whose sandbox stopped within the ready cache starts the sandbox again;
   * either way the command is retried once.
   */
  protected override async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    let result: SpawnResult;
    const sandboxId = this.daytonaConfig.sandboxId;
    // Before the attempt: a refusal replaces only the token this command used.
    const tokenGeneration = sandboxId ? this.daytonaService.sshTokenGeneration(sandboxId) : 0;
    try {
      result = await super.spawnRemoteProcess(fullCommand, options);
    } catch (error) {
      if (!(await this.recoverForRetry(error, tokenGeneration, options.abortSignal))) {
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
          this.daytonaService.invalidateSandboxReady(sandboxId);
        }
        onExit?.(exitCode, stderr);
      },
    };
  }

  /**
   * True when the failure was fixed (a new token, or a restarted sandbox) and a retry may pass.
   * The sandbox state decides, not the error text: a stopped or deleted sandbox also answers
   * "Permission denied", so only a started sandbox gets a new token. Throws a clear error for
   * a sandbox deleted outside Xum.
   */
  private recoverForRetry(
    error: unknown,
    tokenGeneration: number,
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    return this.daytonaService.withAccountLease(async () => {
      const sandboxId = this.daytonaConfig.sandboxId;
      if (!sandboxId || !isRuntimeTransportError(error) || abortSignal?.aborted) return false;
      const tokenRejected = isTokenRejected(error);
      // A UI or background runtime never starts the sandbox, so only a refused token is worth a look.
      if (!tokenRejected && !this.restartsStoppedSandbox) return false;
      this.daytonaService.invalidateSandboxReady(sandboxId);
      const state = await this.readStateAfterFailure(sandboxId);
      return this.recoverInState(
        sandboxId,
        state,
        { error, tokenRejected, tokenGeneration },
        abortSignal
      );
    });
  }

  private recoverInState(
    sandboxId: string,
    state: DaytonaSandboxState | undefined,
    failure: { error: unknown; tokenRejected: boolean; tokenGeneration: number },
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    const { error, tokenRejected, tokenGeneration } = failure;
    if (state === "missing") {
      throw new RuntimeError(
        sandboxMissingMessage(sandboxId),
        "network",
        redactDaytonaError(error)
      );
    }
    if (state === "started") {
      return tokenRejected
        ? this.replaceRejectedToken(sandboxId, tokenGeneration)
        : Promise.resolve(false);
    }
    if (state === undefined || !this.restartsStoppedSandbox) return Promise.resolve(false);
    return this.restartSandbox(sandboxId, abortSignal);
  }

  private async replaceRejectedToken(sandboxId: string, tokenGeneration: number): Promise<boolean> {
    log.info("The Daytona gateway refused the ssh token; replacing it and retrying once", {
      sandboxId,
    });
    try {
      await this.daytonaService.replaceRejectedSshToken(sandboxId, tokenGeneration);
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
      return (await this.daytonaService.getSandboxState(sandboxId)).state;
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
      await this.daytonaService.ensureSandboxReady(sandboxId, {
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
    this.daytonaService.markSandboxReady(sandboxId);
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
        // A creation request never reuses a sandbox, whatever a hand-edited config says.
        forked: undefined,
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
    return daytona.shared === true
      ? this.checkSandboxIdentity(sandboxId, true)
      : this.checkNewSandbox(sandboxId, daytona);
  }

  /** A sandbox Xum creates: a preset size, a free name, and a snapshot that is not Windows. */
  private async checkNewSandbox(
    sandboxId: string,
    daytona: DaytonaSandboxConfig
  ): Promise<Result<void, string>> {
    if (!findDaytonaSizePreset(daytona)) return Err(invalidSizeError());
    const identity = await this.checkSandboxIdentity(sandboxId, false);
    if (!identity.success) return identity;
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
      snapshot = (await this.daytonaService.getGatewayConfig()).defaultSnapshot;
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    return snapshot ? this.checkSnapshotClass(snapshot, { missingOk: true }) : Ok(undefined);
  }

  /**
   * The sandbox to attach must exist and run Linux (Xum's setup and commands are POSIX shell
   * over ssh); the name for a new one must be free.
   */
  private async checkSandboxIdentity(
    sandboxId: string,
    attaching: boolean
  ): Promise<Result<void, string>> {
    let found: Awaited<ReturnType<DaytonaRuntimeService["getSandboxState"]>>;
    try {
      found = await this.daytonaService.getSandboxState(sandboxId);
    } catch (error) {
      return Err(`Could not reach Daytona: ${getErrorMessage(error)}`);
    }
    const exists = found.state !== "missing";
    if (attaching && found.sandbox) {
      const refusal = attachRefusal(sandboxId, found.state, found.sandbox);
      if (refusal) return Err(refusal);
    }
    if (attaching === exists) return Ok(undefined);
    return Err(
      attaching
        ? `Daytona sandbox "${sandboxId}" was not found`
        : `A Daytona sandbox named "${sandboxId}" already exists`
    );
  }

  /** Refused before any sandbox is created: a Windows snapshot makes a billed box setup fails on. */
  private async checkSnapshotClass(
    snapshot: string,
    options?: { missingOk: boolean }
  ): Promise<Result<void, string>> {
    let found: Awaited<ReturnType<DaytonaRuntimeService["findSnapshot"]>>;
    try {
      found = await this.daytonaService.findSnapshot(snapshot);
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
    const refusal = snapshotStateRefusal(snapshot, found.state);
    return refusal ? Err(refusal) : Ok(undefined);
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
  postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    return this.daytonaService.withAccountLease(() => this.provisionSandbox(params));
  }

  private async provisionSandbox(params: WorkspaceInitParams): Promise<void> {
    const sandboxId = this.daytonaConfig.sandboxId;
    if (!sandboxId) {
      throw new Error("Daytona sandbox id is required (should be set by finalizeConfig)");
    }
    // A fork reuses its source's sandbox: create nothing (and so never delete it on failure).
    const creates = this.daytonaConfig.shared !== true && this.daytonaConfig.forked !== true;

    const create: CreateAttempt = { outcome: "none" };
    try {
      if (creates) {
        params.initLogger.logStep(`Creating Daytona sandbox "${sandboxId}"...`);
        create.account = await this.daytonaService.getAccount();
        await this.createSandbox(sandboxId, params, create);
        this.throwIfSettingsChanged(create);
        params.initLogger.logStep("Daytona sandbox created");
      }
      await this.connectAndSeed(sandboxId, creates, params);
      await this.prepareWorkspaceDirectory(params);
      this.throwIfSettingsChanged(create);
    } catch (error) {
      // After a switch of account the step's own error (often "not found") would mislead.
      const errorMsg = this.settingsChanged(create)
        ? SETTINGS_CHANGED_DURING_SETUP
        : redactDaytonaTokens(getErrorMessage(error));
      log.error("Daytona sandbox setup failed", { sandboxId, error: errorMsg });
      params.initLogger.logStderr(`Daytona sandbox setup failed: ${errorMsg}`);
      if (creates) {
        // Later turns report this reason instead of "deleted outside Xum", and never use a
        // sandbox of that name that Xum did not create.
        this.daytonaService.recordSetupFailure(sandboxId, errorMsg);
      }
      if (create.outcome !== "none") {
        await this.deleteCreatedSandbox(sandboxId, create, params.initLogger);
      }
      throw new Error(`Daytona sandbox setup failed: ${errorMsg}`);
    }
  }

  /**
   * Readiness, ssh and the checkout use the current settings, so a setup that spans a change
   * would go on in another account (or deployment) than its sandbox's: it fails instead.
   */
  private settingsChanged(create: CreateAttempt): boolean {
    return create.account !== undefined && !this.daytonaService.isAccountCurrent(create.account);
  }

  private throwIfSettingsChanged(create: CreateAttempt): void {
    if (this.settingsChanged(create)) throw new Error(SETTINGS_CHANGED_DURING_SETUP);
  }

  /** Wait until the sandbox runs, write ssh access, and seed the home of a box Xum created. */
  private async connectAndSeed(
    sandboxId: string,
    seed: boolean,
    params: WorkspaceInitParams
  ): Promise<void> {
    const { initLogger, abortSignal } = params;
    initLogger.logStep("Waiting for the sandbox to start and configuring SSH...");
    await this.daytonaService.ensureSandboxReady(sandboxId, {
      onStarting: () => initLogger.logStep("Starting sandbox..."),
      signal: abortSignal,
    });
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
    create: CreateAttempt,
    initLogger: WorkspaceInitParams["initLogger"]
  ): Promise<void> {
    try {
      if (create.outcome === "unknown" && !(await this.carriesLabels(sandboxId, create))) {
        log.warn("Not deleting a Daytona sandbox this setup may not have created", { sandboxId });
        return;
      }
      initLogger.logStep(`Deleting the sandbox "${sandboxId}" this setup created...`);
      await this.daytonaService.deleteSandbox(sandboxId, create.account);
    } catch (error) {
      // The persisted workspace still names the sandbox, so the reconciler leaves it alone;
      // removing the workspace deletes it.
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

  /** After a create of unknown outcome: the sandbox has this install's and workspace's labels. */
  private async carriesLabels(sandboxId: string, create: CreateAttempt): Promise<boolean> {
    const { labels } = create;
    const { sandbox } = await this.daytonaService.getSandboxState(sandboxId, create.account);
    if (!sandbox || !labels) return false;
    return [DAYTONA_LABEL_INSTANCE, DAYTONA_LABEL_WORKSPACE_ID].every(
      (key) => labels[key] !== undefined && sandbox.labels?.[key] === labels[key]
    );
  }

  /** One create request; `create.outcome` tells postCreateSetup what a failure may delete. */
  private async requestCreate(
    request: Parameters<DaytonaRuntimeService["createSandbox"]>[0],
    create: CreateAttempt
  ): Promise<void> {
    create.outcome = "unknown";
    create.labels = request.labels;
    await this.daytonaService.createSandbox(request, create.account);
    create.outcome = "created";
  }

  /**
   * Create with the preset resources. Daytona rejects resources (HTTP 400) for snapshots with
   * fixed resources: then create with the snapshot's own size and resize to the preset.
   */
  private async createSandbox(
    sandboxId: string,
    params: WorkspaceInitParams,
    create: CreateAttempt
  ): Promise<void> {
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
      await this.requestCreate(
        { ...base, cpu: preset.cpu, memory: preset.memoryGiB, disk: preset.diskGiB },
        create
      );
      return;
    } catch (error) {
      if (!isBadRequest(error)) throw error;
      params.initLogger.logStep(
        `Daytona refused the size for this snapshot (${getErrorMessage(error)}); ` +
          `creating with the snapshot's size and resizing to ${preset.label}...`
      );
    }
    await this.requestCreate(base, create);
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
   * Keep the inherited worktree fork: the child reuses the parent's sandbox (`forked`, so its
   * setup creates none). Neither workspace is marked attached: deleting either keeps the
   * sandbox while the other references it, and the last one deletes it. The user asked for
   * the fork, so a stopped or archived source sandbox is started first, as for a terminal.
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
   * Delete the workspace, and the sandbox too when this is the last workspace on a sandbox
   * Xum created (see SandboxFate). The SSH dirty and unpushed checks always run first, so a
   * stopped or archived sandbox is started for them: unlike Coder, never delete unchecked work
   * to avoid a start. Force skips the checks.
   */
  override deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean,
    options?: { keepBranch?: boolean }
  ): Promise<DeleteResult> {
    return this.daytonaService.withAccountLease(() =>
      this.deleteWorkspaceAndSandbox(
        projectPath,
        workspaceName,
        force,
        abortSignal,
        trusted,
        options
      )
    );
  }

  private async deleteWorkspaceAndSandbox(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean,
    options?: { keepBranch?: boolean }
  ): Promise<DeleteResult> {
    const sandboxId = this.daytonaConfig.sandboxId;
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);
    const sshDelete = () =>
      super.deleteWorkspace(projectPath, workspaceName, force, abortSignal, trusted, options);

    if (!sandboxId) {
      log.warn("Daytona sandbox id not set, falling back to SSH-only deletion");
      return sshDelete();
    }

    const forced = force ? await this.forcedRemovalWithoutSsh(sandboxId, deletedPath) : undefined;
    if (forced) return forced;

    const prepared = await this.startForDeleteChecks(sandboxId, abortSignal);
    if (prepared === "missing") {
      log.debug("Daytona sandbox already gone, skipping SSH cleanup", { sandboxId });
      // Still drop the token and include block of a sandbox no other workspace uses.
      return this.settleSandbox(sandboxId, { success: true, deletedPath }, { force });
    }
    // A forced delete still tries the SSH cleanup; a normal one never skips the checks.
    if (prepared !== "ready" && !force) {
      return { success: false, error: prepared.error };
    }
    return this.settleAfterSshDelete(sandboxId, deletedPath, await sshDelete(), force);
  }

  /** A failed check (dirty or unpushed work) keeps the workspace and its sandbox. */
  private settleAfterSshDelete(
    sandboxId: string,
    deletedPath: string,
    sshResult: DeleteResult,
    force: boolean
  ): Promise<DeleteResult> {
    if (sshResult.success) {
      return this.settleSandbox(sandboxId, sshResult, {
        force,
        errorPrefix: "SSH delete succeeded, but ",
      });
    }
    if (!force) return Promise.resolve(sshResult);
    // Forced: the workspace goes anyway, so the sandbox is still released or handed off.
    const notice =
      `The checkout ${deletedPath} could not be deleted on Daytona sandbox "${sandboxId}" ` +
      `(${sshResult.error}); delete it there if you no longer need it.`;
    return this.settleSandbox(sandboxId, { success: true, deletedPath, notice }, { force });
  }

  /**
   * Force ("cancel creation" or an explicit force delete): the sandbox may not be reachable
   * yet, so delete it without SSH. A kept sandbox only loses this workspace's checkout.
   * Undefined when the forced removal still needs SSH (a started sandbox that stays).
   */
  private async forcedRemovalWithoutSsh(
    sandboxId: string,
    deletedPath: string
  ): Promise<DeleteResult | undefined> {
    const deleted = await this.forceDeleteLastReference(sandboxId, deletedPath);
    if (deleted) return deleted;
    // A forced removal skips the checks, so it never starts a stopped (billed) sandbox for
    // them: its checkout stays on the sandbox, which this removal keeps or releases.
    const state = await this.readSandboxState(sandboxId);
    if (state === "started") return undefined;
    const notice =
      state === "missing"
        ? undefined
        : `Daytona sandbox "${sandboxId}" was not running, so the checkout ${deletedPath} ` +
          "was left on it; delete it there if you no longer need it.";
    return this.settleSandbox(sandboxId, { success: true, deletedPath, notice }, { force: true });
  }

  /** The force path's sandbox delete, when this is the last workspace on a sandbox Xum created. */
  private forceDeleteLastReference(
    sandboxId: string,
    deletedPath: string
  ): Promise<DeleteResult | undefined> {
    return this.daytonaService.withSandboxRemovalLock(async () => {
      if ((await this.sandboxFateOnDelete(sandboxId)) !== "delete") return undefined;
      const result = await this.deleteOwnedSandbox(sandboxId, deletedPath, undefined);
      // Forced: the workspace goes whether or not the sandbox delete worked.
      this.recordRemoval();
      return result;
    });
  }

  private recordRemoval(): void {
    if (this.workspaceId) this.daytonaService.recordWorkspaceRemoval(this.workspaceId);
  }

  private async sandboxFateOnDelete(sandboxId: string): Promise<SandboxFate> {
    const owned = this.daytonaConfig.shared !== true;
    const others = await this.daytonaService.sandboxReferencesElsewhere(
      sandboxId,
      this.workspaceId
    );
    // An attached sandbox is the user's, even one Xum created for another workspace: Xum never
    // deletes it, since its checks cover only this workspace's checkout.
    if (others === "attached" && owned) return "handOff";
    if (others !== "none") return "keep";
    return owned ? "delete" : "release";
  }

  /**
   * The same dirty and unpushed checks deleteWorkspace runs, without deleting: archive with
   * the "delete" behavior uses it to decide between deleting and stopping the sandbox. A
   * stopped or archived sandbox is started for the check; a missing one has nothing to lose.
   */
  checkSandboxDeletable(
    projectPath: string,
    workspaceName: string,
    trusted: boolean | undefined
  ): Promise<Result<void, string>> {
    return this.daytonaService.withAccountLease(async () => {
      const sandboxId = this.daytonaConfig.sandboxId;
      if (!sandboxId) return Err("Daytona sandbox id is not set");
      const prepared = await this.startForDeleteChecks(sandboxId, undefined);
      if (prepared === "missing") return Ok(undefined);
      if (prepared !== "ready") return Err(prepared.error);
      try {
        const deletedPath = this.getWorkspacePath(projectPath, workspaceName);
        const check = await this.checkWorkspaceDeletable(deletedPath, false, trusted);
        if (check === "missing") return Ok(undefined);
        if (check !== "ok") return Err(check.error);
        return await this.checkNoUntrackedFiles(deletedPath);
      } catch (error) {
        return Err(`Failed to check workspace state: ${getErrorMessage(error)}`);
      }
    });
  }

  /**
   * Deleting the sandbox loses untracked files too, which the shared dirty check (made for
   * deleting one worktree) ignores. Only this archive path checks them; a failed check keeps
   * the sandbox.
   */
  private async checkNoUntrackedFiles(deletedPath: string): Promise<Result<void, string>> {
    const result = await execBuffered(
      this,
      `git -C ${this.quoteForRemote(deletedPath)} ls-files --others --exclude-standard`,
      { cwd: "/tmp", timeout: 30 }
    );
    if (result.exitCode !== 0) {
      return Err(`Failed to list files git does not track: ${result.stderr.trim()}`);
    }
    const files = result.stdout.split("\n").filter(Boolean);
    if (files.length === 0) return Ok(undefined);
    const shown = files.slice(0, 5).join(", ");
    return Err(`Workspace contains untracked files (${shown}${files.length > 5 ? ", ..." : ""})`);
  }

  /**
   * Fail closed: the workspace path is still the unresolved `~/...` default (deferred access
   * skips resolution at creation), and a "missing" checkout deletes the whole sandbox. So
   * resolve it on the sandbox first; a path that does not resolve to an absolute one throws,
   * which keeps the workspace and its sandbox.
   */
  protected override async checkWorkspaceDeletable(
    deletedPath: string,
    force: boolean,
    trusted: boolean | undefined,
    abortSignal?: AbortSignal
  ): Promise<"ok" | "missing" | { error: string }> {
    const resolvedPath = await this.resolvePath(deletedPath);
    if (!path.posix.isAbsolute(resolvedPath)) {
      throw new Error(`Could not resolve the workspace path ${deletedPath} on the sandbox`);
    }
    return super.checkWorkspaceDeletable(resolvedPath, force, trusted, abortSignal);
  }

  /**
   * Decide the sandbox's fate and act on it, one removal of this sandbox at a time: two
   * workspaces removed together (a workspace and its fork) would otherwise each see the other
   * and both keep it. Only a removal that got here (its checks passed and its checkout is
   * gone) is recorded, so a dirty, refused removal still holds the sandbox.
   */
  private settleSandbox(
    sandboxId: string,
    result: RemovedCheckout,
    removal: SandboxRemoval
  ): Promise<DeleteResult> {
    return this.daytonaService.withSandboxRemovalLock(async () => {
      const settled = await this.applySandboxFate(
        sandboxId,
        result,
        await this.sandboxFateOnDelete(sandboxId),
        removal
      );
      if (settled.success) this.recordRemoval();
      return settled;
    });
  }

  private async applySandboxFate(
    sandboxId: string,
    result: RemovedCheckout,
    fate: SandboxFate,
    removal: SandboxRemoval
  ): Promise<DeleteResult> {
    if (fate === "delete") {
      return this.deleteOwnedSandbox(sandboxId, result.deletedPath, removal.errorPrefix);
    }
    if (fate === "handOff") return this.handOffSandbox(sandboxId, result, removal);
    await this.releaseAccessOnDelete(sandboxId, fate);
    return result;
  }

  /**
   * Leave the sandbox to the workspace that attached it, no longer labeled as this install's:
   * still labeled, the orphan sweep would stop it once its last workspace goes. A failed
   * relabel fails a normal removal (a retry relabels it); a forced one goes on, so its notice
   * tells the user to drop the label.
   */
  private async handOffSandbox(
    sandboxId: string,
    result: RemovedCheckout,
    removal: SandboxRemoval
  ): Promise<DeleteResult> {
    const failure = await this.disownSandbox(sandboxId);
    if (failure && !removal.force) {
      const error = removal.errorPrefix ? `${removal.errorPrefix}${failure}` : `Xum ${failure}`;
      return { success: false, error };
    }
    await this.releaseAccessOnDelete(sandboxId, "handOff");
    const handOff =
      `Daytona sandbox "${sandboxId}" was kept for a workspace that attached it. Xum never ` +
      "deletes an attached sandbox, so it stays when that workspace is removed too; delete it " +
      "in Daytona when you no longer need it.";
    log.info(handOff, { workspaceId: this.workspaceId });
    const relabel =
      failure &&
      `Xum ${failure}. Remove its "${DAYTONA_LABEL_INSTANCE}" label in Daytona, or Xum stops ` +
        "the sandbox once no workspace uses it.";
    const notice = [result.notice, handOff, relabel].filter(Boolean).join(" ");
    return { ...result, notice };
  }

  /**
   * Access is per stored string (a sandbox's name or its id): a kept sandbox keeps it only
   * while another workspace stores the same one.
   */
  private async releaseAccessOnDelete(sandboxId: string, fate: SandboxFate): Promise<void> {
    const releases =
      fate === "release" ||
      !this.daytonaService.isAliasStoredElsewhere(sandboxId, this.workspaceId);
    if (!releases) return;
    try {
      await this.daytonaService.releaseSshAccess(sandboxId);
    } catch (error) {
      // The token expires within the hour; the workspace is gone either way.
      log.warn("Failed to release Daytona ssh access after deleting a workspace", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
  }

  /** Why Daytona would not drop this install's label from the sandbox; undefined once it did. */
  private async disownSandbox(sandboxId: string): Promise<string | undefined> {
    try {
      await this.daytonaService.disownSandbox(sandboxId);
      return undefined;
    } catch (error) {
      const message = getErrorMessage(error);
      log.error("Failed to hand off a Daytona sandbox", { sandboxId, error: message });
      return `could not mark Daytona sandbox "${sandboxId}" as no longer Xum-owned: ${message}`;
    }
  }

  /** Start the sandbox (if stopped or archived) so the dirty and unpushed checks can run. */
  private async startForDeleteChecks(
    sandboxId: string,
    abortSignal: AbortSignal | undefined
  ): Promise<"ready" | "missing" | { error: string }> {
    try {
      await this.daytonaService.ensureSandboxReady(sandboxId, { signal: abortSignal });
      return "ready";
    } catch (error) {
      if (error instanceof DaytonaApiError && error.kind === "not_found") return "missing";
      // A sandbox on its way out (a failed setup deleting it) has no work left to check.
      if (await this.isBeingDestroyed(sandboxId)) return "missing";
      return {
        error:
          `Could not start Daytona sandbox "${sandboxId}" to check for uncommitted work: ` +
          `${getErrorMessage(error)}`,
      };
    }
  }

  private async isBeingDestroyed(sandboxId: string): Promise<boolean> {
    try {
      return await this.daytonaService.waitUntilDestroyed(sandboxId);
    } catch (error) {
      log.warn("Could not read Daytona sandbox state before a delete", {
        sandboxId,
        error: getErrorMessage(error),
      });
      return false;
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
        // A forced removal goes on without it: remove shows this as a warning to act on.
        leftoverPaths: [`Daytona sandbox "${sandboxId}"`],
      };
    }
  }
}
