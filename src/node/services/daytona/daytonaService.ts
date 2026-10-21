import * as path from "path";
import type {
  DaytonaListSandboxesResult,
  DaytonaListSnapshotsResult,
  DaytonaPublicConfig,
  DaytonaSandboxState,
  DaytonaSandboxSummary,
  DaytonaTestConnectionResult,
} from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  DaytonaCredentialsPatch,
  DaytonaCredentialsStore,
  DaytonaResolvedCredentials,
} from "@/node/config/daytonaCredentialsStore";
import { loadOrCreateInstallationId } from "@/node/config/installationIdentity";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { redactDaytonaTokens, rememberDaytonaToken } from "@/node/runtime/daytonaTokenRedaction";
import { getDaytonaSandboxId } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { sleepWithAbort } from "@/node/utils/abort";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  DaytonaApiError,
  DaytonaClient,
  isDaytonaNotFound,
  type DaytonaCreateSandboxRequest,
  type DaytonaGatewayConfig,
  type DaytonaResizeRequest,
  type DaytonaSandbox,
  type DaytonaSshAccess,
} from "./daytonaClient";
import type { DaytonaWorkspaceRef } from "./daytonaReconciler";

export const DAYTONA_LABEL_INSTANCE = "xum.instance";
export const DAYTONA_LABEL_WORKSPACE_ID = "xum.workspaceId";
export const DAYTONA_LABEL_PROJECT = "xum.project";

/** Tokens are minted for an hour and replaced once less than 15 minutes remain. */
export const DAYTONA_SSH_TOKEN_TTL_MINUTES = 60;
export const DAYTONA_SSH_TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;

export const DAYTONA_START_POLL_INTERVAL_MS = 2_000;

/** Upper bound for bringing a stopped or archived sandbox back (archived restores are slow). */
export const DAYTONA_START_TIMEOUT_MS = 180_000;

/**
 * How long a successful readiness check is trusted. Runtimes are recreated per stream start, so
 * the cache lives here, keyed by sandbox, rather than on a runtime instance.
 */
export const DAYTONA_READY_CACHE_MS = 60_000;
/** How long a delete waits for a sandbox Daytona is already destroying to go away. */
export const DAYTONA_DESTROY_WAIT_MS = 60_000;

const DESTROYING_STATES = new Set(["destroying", "destroyed"]);

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
  destroyed: "error",
  destroying: "error",
  unknown: "error",
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

export type DaytonaAvailability = { available: true } | { available: false; reason: string };

export interface DaytonaServiceOptions {
  credentialsStore: DaytonaCredentialsStore;
  /** Xum data root; holds the installation identity used for the `xum.instance` label. */
  rootDir: string;
  /** Defaults to a writer for the real `~/.ssh/config`; tests pass one aimed at a temp dir. */
  sshConfigWriter?: Pick<
    DaytonaSshConfigWriter,
    "writeSandbox" | "updateToken" | "removeSandbox" | "verifyResolvedConfig" | "readTokens"
  >;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Every workspace Xum knows, archived ones included: a sandbox Xum created is deleted only
   * with the last workspace that references it. Without it no sandbox counts as unreferenced.
   */
  listWorkspaces?: () => DaytonaWorkspaceRef[];
}

export interface DaytonaStartAndWaitOptions {
  /** Called when Xum asks Daytona to start the sandbox (for a "Starting sandbox" status). */
  onStarting?: () => void;
  signal?: AbortSignal;
}

export interface DaytonaEnsureReadyOptions {
  /** Called when the sandbox has to be started (it was stopped or archived). */
  onStarting?: () => void;
}

interface SandboxReadyRequest {
  promise: Promise<void>;
  onStarting: Set<() => void>;
  starting: boolean;
}

export interface DaytonaSshTokenOptions {
  /**
   * Runs after a fresh token is minted and before the previous one is revoked, so the caller
   * can point the ssh include file at the new token first and no new connection ever uses a
   * revoked token.
   */
  onNewToken?: (access: DaytonaSshAccess) => Promise<void>;
}

function toResultError(error: unknown): {
  ok: false;
  kind: DaytonaApiError["kind"];
  error: string;
} {
  if (error instanceof DaytonaApiError) {
    return { ok: false, kind: error.kind, error: error.message };
  }
  return { ok: false, kind: "server", error: getErrorMessage(error) };
}

function toSummary(sandbox: DaytonaSandbox): DaytonaSandboxSummary {
  return {
    id: sandbox.id,
    name: sandbox.name ?? sandbox.id,
    state: mapDaytonaSandboxState(sandbox.state),
    ...(sandbox.cpu !== undefined ? { cpu: sandbox.cpu } : {}),
    ...(sandbox.memory !== undefined ? { memoryGiB: sandbox.memory } : {}),
    ...(sandbox.disk !== undefined ? { diskGiB: sandbox.disk } : {}),
    ...(sandbox.snapshot ? { snapshot: sandbox.snapshot } : {}),
    ...(sandbox.target ? { target: sandbox.target } : {}),
  };
}

/**
 * Daytona lifecycle and credential access shared by the runtime, the reconciler and the
 * `daytona` oRPC namespace. One instance per Xum backend: it owns the per-sandbox SSH token
 * cache, so a second instance would mint (and revoke) tokens behind the first one's back.
 */
export class DaytonaService {
  private readonly credentialsStore: DaytonaCredentialsStore;
  private readonly rootDir: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private gatewayCache?: { apiUrl: string; config: DaytonaGatewayConfig };
  private readonly tokens = new Map<string, DaytonaSshAccess>();
  private readonly tokenRequests = new Map<string, Promise<DaytonaSshAccess>>();
  private readonly sshConfigWriter: NonNullable<DaytonaServiceOptions["sshConfigWriter"]>;
  /** Sandboxes whose include block and `~/.ssh/config` block this process has written. */
  private readonly sshConfigured = new Set<string>();
  private readonly readyAt = new Map<string, number>();
  private readonly readyRequests = new Map<string, SandboxReadyRequest>();
  /** Why the setup of a sandbox Xum created (and then deleted) failed, for later turns. */
  private readonly setupFailures = new Map<string, string>();
  private readonly listWorkspaces?: () => DaytonaWorkspaceRef[];
  /** Per sandbox: serializes "is this its last workspace" decisions. */
  private readonly removalLocks = new MutexMap<string>();
  /**
   * Per sandbox: workspaces whose removal passed its checks and deleted its checkout, but
   * that the workspace list may still show until the removal is persisted.
   */
  private readonly removedWorkspaces = new Map<string, Set<string>>();

  constructor(options: DaytonaServiceOptions) {
    this.credentialsStore = options.credentialsStore;
    this.rootDir = options.rootDir;
    this.sshConfigWriter =
      options.sshConfigWriter ?? new DaytonaSshConfigWriter({ xumHome: options.rootDir });
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.listWorkspaces = options.listWorkspaces;
  }

  /**
   * Tokens an earlier Xum process wrote to the include file. ssh keeps sending them until Xum
   * replaces them, so the redactor must know them; holding them also lets a replacement, a
   * settings change or an archive revoke them. The file has no expiry, so they are due for
   * refresh at once. Startup calls this before any ssh runs.
   */
  async loadPersistedTokens(): Promise<void> {
    for (const { sandboxId, token } of await this.sshConfigWriter.readTokens()) {
      rememberDaytonaToken(token);
      if (!this.tokens.has(sandboxId)) {
        this.tokens.set(sandboxId, { token, expiresAt: new Date(0).toISOString() });
      }
    }
  }

  getPublicConfig(): Promise<DaytonaPublicConfig> {
    return this.credentialsStore.getPublicConfig();
  }

  async setConfig(patch: DaytonaCredentialsPatch): Promise<DaytonaPublicConfig> {
    const previousClient = await this.getClientIfConfigured();
    await this.credentialsStore.update(patch);
    // Tokens and gateway data belong to the old account or deployment. Revoke the tokens with
    // the old credentials, which may not work for the new ones.
    const tokens = [...this.tokens];
    this.gatewayCache = undefined;
    this.tokens.clear();
    this.sshConfigured.clear();
    this.readyAt.clear();
    if (previousClient) {
      await Promise.all(
        tokens.map(([sandboxId, access]) =>
          this.revokeQuietly(previousClient, sandboxId, access.token)
        )
      );
    }
    return this.credentialsStore.getPublicConfig();
  }

  private async getClientIfConfigured(): Promise<DaytonaClient | undefined> {
    try {
      return (await this.getClient()).client;
    } catch (error) {
      log.debug("No Daytona client to revoke SSH tokens with", { error: getErrorMessage(error) });
      return undefined;
    }
  }

  /**
   * Whether a workspace other than `workspaceId` (archived ones included) references the
   * sandbox. Fails closed, as referenced, when the workspace list or the caller's id is
   * unknown: a kept sandbox only costs storage (the reconciler stops it), a deleted one loses
   * the other workspace's work.
   */
  isSandboxReferencedElsewhere(sandboxId: string, workspaceId: string | undefined): boolean {
    if (!this.listWorkspaces || !workspaceId) return true;
    const removed = this.removedWorkspaces.get(sandboxId);
    return this.listWorkspaces().some(
      (ref) =>
        ref.workspaceId !== workspaceId &&
        !removed?.has(ref.workspaceId) &&
        getDaytonaSandboxId(ref.runtimeConfig) === sandboxId
    );
  }

  /** Run `fn` after every earlier removal decision for this sandbox has settled. */
  withSandboxRemovalLock<T>(sandboxId: string, fn: () => Promise<T>): Promise<T> {
    return this.removalLocks.withLock(sandboxId, fn);
  }

  /** The workspace no longer references the sandbox, even while the workspace list shows it. */
  recordWorkspaceRemoval(sandboxId: string, workspaceId: string): void {
    const removed = this.removedWorkspaces.get(sandboxId) ?? new Set<string>();
    removed.add(workspaceId);
    this.removedWorkspaces.set(sandboxId, removed);
  }

  recordSetupFailure(sandboxId: string, reason: string): void {
    this.setupFailures.set(sandboxId, reason);
  }

  getSetupFailure(sandboxId: string): string | undefined {
    return this.setupFailures.get(sandboxId);
  }

  async checkAvailability(): Promise<DaytonaAvailability> {
    const credentials = await this.credentialsStore.resolve();
    if (!credentials) {
      return {
        available: false,
        reason: "Set a Daytona API key in Settings > Runtimes (or DAYTONA_API_KEY)",
      };
    }
    return { available: true };
  }

  /** Throws a `not_configured` DaytonaApiError when no API key is set. */
  async getClient(): Promise<{ client: DaytonaClient; credentials: DaytonaResolvedCredentials }> {
    const credentials = await this.credentialsStore.resolve();
    if (!credentials) {
      throw new DaytonaApiError(
        "not_configured",
        "Daytona is not configured: set an API key in Settings > Runtimes"
      );
    }
    return {
      client: new DaytonaClient({
        apiUrl: credentials.apiUrl,
        apiKey: credentials.apiKey,
        fetch: this.fetchImpl,
      }),
      credentials,
    };
  }

  async getGatewayConfig(): Promise<DaytonaGatewayConfig> {
    const { client, credentials } = await this.getClient();
    if (this.gatewayCache?.apiUrl === credentials.apiUrl) return this.gatewayCache.config;
    const config = await client.getConfig();
    this.gatewayCache = { apiUrl: credentials.apiUrl, config };
    return config;
  }

  async testConnection(): Promise<DaytonaTestConnectionResult> {
    try {
      const { client } = await this.getClient();
      // The public endpoint proves the URL is a Daytona control plane; the second call the key.
      await client.getConfig();
      await client.verifyAuth();
      return { ok: true };
    } catch (error) {
      return toResultError(error);
    }
  }

  async listSandboxes(): Promise<DaytonaListSandboxesResult> {
    try {
      const { client } = await this.getClient();
      const sandboxes = await client.listSandboxes();
      return {
        ok: true,
        sandboxes: sandboxes
          .filter((sandbox) => !DESTROYING_STATES.has(sandbox.state ?? ""))
          .map(toSummary),
      };
    } catch (error) {
      return toResultError(error);
    }
  }

  async listSnapshots(): Promise<DaytonaListSnapshotsResult> {
    try {
      const { client } = await this.getClient();
      return { ok: true, snapshots: await client.listSnapshots() };
    } catch (error) {
      return toResultError(error);
    }
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
    const { client } = await this.getClient();
    return client.listSandboxes({ [DAYTONA_LABEL_INSTANCE]: await this.getInstanceId() });
  }

  async getSandboxState(
    sandboxId: string
  ): Promise<{ state: DaytonaSandboxState; sandbox?: DaytonaSandbox }> {
    const { client } = await this.getClient();
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
    const { client } = await this.getClient();
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

  /** The default target (region) from Settings > Runtimes, if one is set. */
  async getDefaultTarget(): Promise<string | undefined> {
    return (await this.credentialsStore.resolve())?.target;
  }

  async createSandbox(request: DaytonaCreateSandboxRequest): Promise<DaytonaSandbox> {
    const { client } = await this.getClient();
    return client.createSandbox(request);
  }

  async resizeSandbox(sandboxId: string, request: DaytonaResizeRequest): Promise<void> {
    const { client } = await this.getClient();
    this.readyAt.delete(sandboxId);
    await client.resizeSandbox(sandboxId, request);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const { client } = await this.getClient();
    this.readyAt.delete(sandboxId);
    await client.stopSandbox(sandboxId);
  }

  /**
   * Whether the sandbox is gone, waiting up to DAYTONA_DESTROY_WAIT_MS while Daytona destroys
   * it (a failed setup deletes its sandbox while a removal of the workspace may already run).
   * False for a sandbox in any other state, or one still being destroyed at the deadline.
   */
  async waitUntilDestroyed(sandboxId: string): Promise<boolean> {
    const { client } = await this.getClient();
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
    const { client } = await this.getClient();
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
   * Delete the sandbox and drop Xum's SSH access to it (token and include block). A sandbox
   * that is already gone counts as deleted.
   */
  async deleteSandbox(sandboxId: string): Promise<void> {
    const { client } = await this.getClient();
    // Revoke first: Daytona refuses to revoke a token of a sandbox that no longer exists.
    await this.releaseSshAccess(sandboxId);
    try {
      await client.deleteSandbox(sandboxId);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
    }
  }

  async refreshActivity(sandboxId: string): Promise<void> {
    const { client } = await this.getClient();
    await client.refreshActivity(sandboxId);
  }

  /** Whether a readiness check for this sandbox passed within DAYTONA_READY_CACHE_MS. */
  isSandboxReady(sandboxId: string): boolean {
    const at = this.readyAt.get(sandboxId);
    return at !== undefined && this.now() - at < DAYTONA_READY_CACHE_MS;
  }

  markSandboxReady(sandboxId: string): void {
    this.readyAt.set(sandboxId, this.now());
  }

  /** An ssh connection failed: the sandbox may have stopped within the ready cache. */
  invalidateSandboxReady(sandboxId: string): void {
    this.readyAt.delete(sandboxId);
  }

  /**
   * Bring the sandbox to `started` and make sure Xum can ssh into it (fresh token, include
   * block). Concurrent callers for one sandbox share a single request; each still gets its own
   * `onStarting` call. Throws a DaytonaApiError (`not_found` when the sandbox is gone).
   */
  ensureSandboxReady(sandboxId: string, options: DaytonaEnsureReadyOptions = {}): Promise<void> {
    const existing = this.readyRequests.get(sandboxId);
    if (existing) {
      if (options.onStarting) {
        existing.onStarting.add(options.onStarting);
        if (existing.starting) options.onStarting();
      }
      return existing.promise;
    }

    const request: SandboxReadyRequest = {
      promise: Promise.resolve(),
      onStarting: new Set(options.onStarting ? [options.onStarting] : []),
      starting: false,
    };
    request.promise = (async () => {
      await this.startAndWait(sandboxId, this.now() + DAYTONA_START_TIMEOUT_MS, {
        onStarting: () => {
          request.starting = true;
          for (const listener of request.onStarting) listener();
        },
      });
      await this.ensureSshAccess(sandboxId);
    })().finally(() => {
      this.readyRequests.delete(sandboxId);
    });
    this.readyRequests.set(sandboxId, request);
    return request.promise;
  }

  /**
   * A valid token in the include file for this sandbox. The first write in this process also
   * writes known_hosts and the `~/.ssh/config` block and checks that ssh resolves the token as
   * the user; a refresh rewrites only the include file.
   */
  async ensureSshAccess(sandboxId: string): Promise<void> {
    const gatewayConfig = await this.getGatewayConfig();
    const gateway = {
      host: gatewayConfig.sshGatewayHost,
      port: gatewayConfig.sshGatewayPort,
      hostKeys: gatewayConfig.sshGatewayHostKeys,
    };
    // A cached token was written by the mint that produced it, so only a mint writes files.
    const access = await this.getSshToken(sandboxId, {
      onNewToken: async ({ token }) => {
        if (this.sshConfigured.has(sandboxId)) {
          await this.sshConfigWriter.updateToken({ sandboxId, token, gateway });
          return;
        }
        await this.sshConfigWriter.writeSandbox({ sandboxId, token, gateway });
      },
    });
    if (this.sshConfigured.has(sandboxId)) return;
    // Outside the mint: when the user's ssh config shadows the token, a retry after they fix it
    // reuses this token (already written) instead of minting another one.
    await this.sshConfigWriter.verifyResolvedConfig(sandboxId, access.token);
    this.sshConfigured.add(sandboxId);
  }

  /**
   * The gateway refused the sandbox's token (revoked outside Xum, or one an earlier process
   * left): mint a new one and rewrite the include file. `failure` is the raw ssh error; when it
   * names a token other than the cached one, a concurrent command already replaced it.
   */
  async replaceRejectedSshToken(sandboxId: string, failure: string): Promise<void> {
    const cached = this.tokens.get(sandboxId);
    if (cached && !failure.includes(cached.token) && redactDaytonaTokens(failure) !== failure) {
      return;
    }
    this.readyAt.delete(sandboxId);
    // Due at once, so the next ensureSshAccess mints, writes, and revokes the refused one.
    if (cached) this.tokens.set(sandboxId, { ...cached, expiresAt: new Date(0).toISOString() });
    await this.ensureSshAccess(sandboxId);
  }

  /** Whether this process holds a token for the sandbox that is close to expiry. */
  hasExpiringSshToken(sandboxId: string): boolean {
    return this.tokens.has(sandboxId) && this.tokenNeedsRefresh(sandboxId);
  }

  /** Revoke the token and remove the sandbox's include block. */
  async releaseSshAccess(sandboxId: string): Promise<void> {
    this.sshConfigured.delete(sandboxId);
    this.readyAt.delete(sandboxId);
    await this.forgetSshToken(sandboxId);
    await this.sshConfigWriter.removeSandbox(sandboxId);
  }

  tokenNeedsRefresh(sandboxId: string): boolean {
    const cached = this.tokens.get(sandboxId);
    if (!cached) return true;
    const expiresAt = Date.parse(cached.expiresAt);
    return (
      !Number.isFinite(expiresAt) || expiresAt - this.now() < DAYTONA_SSH_TOKEN_REFRESH_MARGIN_MS
    );
  }

  /**
   * The cached SSH token for a sandbox, minting a new one when none is cached or it expires
   * within the refresh margin. Concurrent callers share one mint. The replaced token is revoked
   * after `onNewToken` resolves; a failed revoke is logged, since the token expires anyway.
   */
  async getSshToken(
    sandboxId: string,
    options: DaytonaSshTokenOptions = {}
  ): Promise<DaytonaSshAccess> {
    const cached = this.tokens.get(sandboxId);
    if (cached && !this.tokenNeedsRefresh(sandboxId)) return cached;
    const inFlight = this.tokenRequests.get(sandboxId);
    if (inFlight) return inFlight;

    const request = this.mintSshToken(sandboxId, cached, options).finally(() => {
      this.tokenRequests.delete(sandboxId);
    });
    this.tokenRequests.set(sandboxId, request);
    return request;
  }

  private async mintSshToken(
    sandboxId: string,
    previous: DaytonaSshAccess | undefined,
    options: DaytonaSshTokenOptions
  ): Promise<DaytonaSshAccess> {
    const { client } = await this.getClient();
    const access = await client.createSshAccess(sandboxId, DAYTONA_SSH_TOKEN_TTL_MINUTES);
    rememberDaytonaToken(access.token);
    try {
      await options.onNewToken?.(access);
    } catch (error) {
      // Nothing holds the new token any more: revoke it rather than leave it live.
      await this.revokeQuietly(client, sandboxId, access.token);
      throw error;
    }
    this.tokens.set(sandboxId, access);
    if (previous && previous.token !== access.token) {
      await this.revokeQuietly(client, sandboxId, previous.token);
    }
    return access;
  }

  /** Revoke and forget the cached token (workspace deleted or sandbox detached). */
  async forgetSshToken(sandboxId: string): Promise<void> {
    const cached = this.tokens.get(sandboxId);
    this.tokens.delete(sandboxId);
    if (!cached) return;
    const { client } = await this.getClient();
    await this.revokeQuietly(client, sandboxId, cached.token);
  }

  private async revokeQuietly(
    client: DaytonaClient,
    sandboxId: string,
    token: string
  ): Promise<void> {
    try {
      await client.revokeSshAccess(sandboxId, token);
    } catch (error) {
      // Never log the token itself.
      log.warn("Failed to revoke a Daytona SSH token; it expires on its own", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
  }
}
