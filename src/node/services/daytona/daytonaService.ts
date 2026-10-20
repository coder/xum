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
import { log } from "@/node/services/log";
import {
  DaytonaApiError,
  DaytonaClient,
  isDaytonaNotFound,
  type DaytonaGatewayConfig,
  type DaytonaSandbox,
  type DaytonaSshAccess,
} from "./daytonaClient";

export const DAYTONA_LABEL_INSTANCE = "xum.instance";
export const DAYTONA_LABEL_WORKSPACE_ID = "xum.workspaceId";
export const DAYTONA_LABEL_PROJECT = "xum.project";

/** Tokens are minted for an hour and replaced once less than 15 minutes remain. */
export const DAYTONA_SSH_TOKEN_TTL_MINUTES = 60;
export const DAYTONA_SSH_TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;

export const DAYTONA_START_POLL_INTERVAL_MS = 2_000;

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
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaytonaStartAndWaitOptions {
  /** Called when Xum asks Daytona to start the sandbox (for a "Starting sandbox" status). */
  onStarting?: () => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(options: DaytonaServiceOptions) {
    this.credentialsStore = options.credentialsStore;
    this.rootDir = options.rootDir;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  getPublicConfig(): Promise<DaytonaPublicConfig> {
    return this.credentialsStore.getPublicConfig();
  }

  async setConfig(patch: DaytonaCredentialsPatch): Promise<DaytonaPublicConfig> {
    await this.credentialsStore.update(patch);
    // Tokens and gateway data belong to the old account or deployment.
    this.gatewayCache = undefined;
    this.tokens.clear();
    return this.credentialsStore.getPublicConfig();
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
          .filter((sandbox) => sandbox.state !== "destroyed" && sandbox.state !== "destroying")
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
      await this.sleep(
        Math.min(options.pollIntervalMs ?? DAYTONA_START_POLL_INTERVAL_MS, remaining)
      );
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
    await options.onNewToken?.(access);
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
