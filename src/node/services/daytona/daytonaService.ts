import { createHash } from "crypto";
import * as path from "path";
import type {
  DaytonaListSandboxesResult,
  DaytonaListSnapshotsResult,
  DaytonaPublicConfig,
  DaytonaSandboxState,
  DaytonaSandboxSummary,
  DaytonaTestConnectionResult,
} from "@/common/orpc/schemas/daytona";
import { toXumDaytonaHost } from "@/common/constants/daytona";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DaytonaConfigError,
  type DaytonaCredentialsPatch,
  type DaytonaCredentialsStore,
  type DaytonaResolvedCredentials,
} from "@/node/config/daytonaCredentialsStore";
import { loadOrCreateInstallationId } from "@/node/config/installationIdentity";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { retireSshConnections } from "@/node/runtime/transports";
import { rememberDaytonaToken } from "@/node/runtime/daytonaTokenRedaction";
import {
  getDaytonaSandboxId,
  isDedicatedDaytonaSandbox,
  type RuntimeConfig,
} from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { raceAbort, sleepWithAbort } from "@/node/utils/abort";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  DaytonaApiError,
  DaytonaClient,
  isDaytonaNotFound,
  type DaytonaCreateSandboxRequest,
  type DaytonaGatewayConfig,
  type DaytonaResizeRequest,
  type DaytonaSandbox,
  type DaytonaSnapshot,
  type DaytonaSshAccess,
} from "./daytonaClient";
import type { DaytonaWorkspaceRef } from "./daytonaReconciler";

/** A workspace whose runtime is on a given sandbox. */
export interface DaytonaWorkspaceOnSandbox {
  workspaceId: string;
  runtimeConfig: RuntimeConfig;
}

/** The ref with the sandbox string it stores, or none when it stores no sandbox. */
function onSandboxRef(
  ref: DaytonaWorkspaceRef
): Array<DaytonaWorkspaceOnSandbox & { stored: string }> {
  const stored = getDaytonaSandboxId(ref.runtimeConfig);
  return stored && ref.runtimeConfig
    ? [{ stored, workspaceId: ref.workspaceId, runtimeConfig: ref.runtimeConfig }]
    : [];
}

/** What another workspace stores as its sandbox, and whether it attached it. */
interface StoredSandboxRef {
  stored: string;
  attached: boolean;
  archived: boolean;
}

/**
 * Sandboxes (and the snapshots that create them) Xum never offers, creates or attaches:
 * - "windows" (Daytona's sandboxClass): Xum provisions and runs workspaces over ssh with POSIX
 *   shell commands, which cmd.exe and PowerShell do not run.
 * - "gpu" (a positive `gpu` count; Daytona's sandboxClass has no GPU value): Daytona deletes a
 *   GPU sandbox when it stops, and Xum lets workspaces auto-stop and stops one to grow its
 *   disk, so the checkout would be lost.
 */
export type UnsupportedDaytonaSandboxKind = "windows" | "gpu";

export function unsupportedDaytonaSandboxKind(item: {
  sandboxClass?: string | null;
  gpu?: number | null;
}): UnsupportedDaytonaSandboxKind | undefined {
  if (item.sandboxClass === "windows") return "windows";
  if ((item.gpu ?? 0) > 0) return "gpu";
  return undefined;
}

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
/**
 * How long Daytona's `/config` (gateway endpoint and host keys) is trusted. Daytona can move
 * its gateway or rotate its keys while Xum runs; a refetch that sees a change rewrites every
 * sandbox's ssh setup on its next use.
 */
export const DAYTONA_GATEWAY_CONFIG_TTL_MS = 5 * 60_000;
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

/** Only an active snapshot creates sandboxes; one with no reported state is taken as active. */
function isActiveSnapshot(snapshot: DaytonaSnapshot): boolean {
  return !snapshot.state || snapshot.state === "active";
}

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

/**
 * The client of the settings at one moment, stamped with their generation: work that must stay
 * in one Daytona account (a create and its cleanup) holds it across a settings change.
 */
export interface DaytonaAccount {
  client: DaytonaClient;
  generation: number;
}

export const DAYTONA_BUSY_MESSAGE =
  "Daytona is busy creating, starting, deleting or checking sandboxes. Save these settings " +
  "again when it is done.";

/** Wait until `promise` settles; its outcome belongs to whoever started it. */
async function settled(promise: Promise<unknown>): Promise<void> {
  await Promise.allSettled([promise]);
}

interface MintStamp {
  generation: number;
  release: number;
}

interface OutdatedMintInput {
  client: DaytonaClient;
  sandboxId: string;
  access: DaytonaSshAccess;
  stamp: MintStamp;
  options: DaytonaSshTokenOptions;
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
    | "writeSandbox"
    | "ensureManagedBlock"
    | "updateToken"
    | "repointGateway"
    | "removeSandbox"
    | "removeSandboxTokens"
    | "readTokens"
  >;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Every workspace Xum knows, archived ones included: a sandbox Xum created is deleted only
   * with the last workspace that references it. Without it no sandbox counts as unreferenced.
   */
  listWorkspaces?: () => DaytonaWorkspaceRef[];
  /** Defaults to retiring the pooled OpenSSH and ssh2 connections of the sandbox's alias. */
  retireSshConnections?: (sandboxId: string) => Promise<void>;
  /**
   * The archive behavior in Settings, for a removal that ends the last use of a sandbox an
   * archived owner left alone (see the archive hook). Without it such a removal keeps it as is.
   */
  getArchiveBehavior?: () => CoderWorkspaceArchiveBehavior;
}

export interface DaytonaStartAndWaitOptions {
  /** Called when Xum asks Daytona to start the sandbox (for a "Starting sandbox" status). */
  onStarting?: () => void;
  signal?: AbortSignal;
}

export interface DaytonaEnsureReadyOptions {
  /** Called when the sandbox has to be started (it was stopped or archived). */
  onStarting?: () => void;
  /** Stops this caller's wait (and its onStarting calls); the shared request goes on. */
  signal?: AbortSignal;
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

function toSshGateway(config: DaytonaGatewayConfig) {
  return {
    host: config.sshGatewayHost,
    port: config.sshGatewayPort,
    hostKeys: config.sshGatewayHostKeys,
  };
}

/** The account credentials select, hashed so this cache holds no key; "" when none is set. */
function fingerprintAccount(credentials: DaytonaResolvedCredentials | null): string {
  if (!credentials) return "";
  return createHash("sha256")
    .update(JSON.stringify([credentials.apiUrl, credentials.apiKey]))
    .digest("hex");
}

/** What the ssh setup depends on; key order from Daytona is not significant. */
function gatewayIdentity(config: DaytonaGatewayConfig): string {
  const { host, port, hostKeys } = toSshGateway(config);
  return JSON.stringify([host, port, [...hostKeys].sort()]);
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
  /** See gatewayGeneration. */
  private gatewayMoves = 0;
  private gatewayCache?: {
    apiUrl: string;
    generation: number;
    fetchedAt: number;
    config: DaytonaGatewayConfig;
  };
  private gatewayRequest?: {
    apiUrl: string;
    generation: number;
    promise: Promise<DaytonaGatewayConfig>;
  };
  private readonly tokens = new Map<string, DaytonaSshAccess>();
  /** Bumped (unique per process) whenever a sandbox's cached token becomes another one. */
  private readonly tokenGenerations = new Map<string, number>();
  private lastTokenGeneration = 0;
  private readonly tokenRequests = new Map<string, Promise<DaytonaSshAccess>>();
  /** Bumped by every settings change, so a mint that spans one can tell. */
  private credentialsGeneration = 0;
  /**
   * A hash of the account (API URL and key) last resolved. Another Xum process sharing this
   * root may save other credentials; the store's lock does not tell this one, so a resolve
   * that sees another account retires what this process cached for the old one.
   */
  private accountFingerprint?: string;
  /**
   * The credentials last resolved. While an account lease or this process's settings save
   * runs, every resolve returns these, so an operation never mixes two accounts when another
   * process saves new ones mid-way; the first resolve once idle reads the store again.
   */
  private credentialsSnapshot?: { credentials: DaytonaResolvedCredentials | null };
  /** Operations running under withAccountLease; setConfig refuses while any runs. */
  private accountLeases = 0;
  /** The settings read a lease claimed while idle runs first. */
  private idleRefresh?: Promise<void>;
  /** The settings change being saved; new leases wait for it. */
  private settingsChange?: Promise<DaytonaPublicConfig>;
  /** Per sandbox: bumped by every release of its SSH access, so a mint that spans one can tell. */
  private readonly accessReleases = new Map<string, number>();
  private readonly sshConfigWriter: NonNullable<DaytonaServiceOptions["sshConfigWriter"]>;
  private readonly retireSshConnections: NonNullable<DaytonaServiceOptions["retireSshConnections"]>;
  /** Sandboxes whose include block and `~/.ssh/config` block this process has written. */
  private readonly sshConfigured = new Set<string>();
  private readonly readyAt = new Map<string, number>();
  /** Whether the include file was read once, seeding the tokens an earlier process left. */
  private persistedTokensLoaded = false;
  private readonly readyRequests = new Map<string, SandboxReadyRequest>();
  /**
   * When this process last proved a sandbox carries this install's label (never one that does
   * not). A turn reuses a proof within DAYTONA_READY_CACHE_MS, so a label someone else removed
   * is seen within that window and a healthy sandbox pays one label read per window. Dropped
   * with a delete or a handoff, and with the account.
   */
  private readonly provenOwned = new Map<string, number>();
  private readonly ownershipRequests = new Map<string, Promise<"owned" | "notOwned" | "missing">>();
  /** Why the setup of a sandbox Xum created (and then deleted) failed, for later turns. */
  private readonly setupFailures = new Map<string, string>();
  private readonly listWorkspaces?: () => DaytonaWorkspaceRef[];
  readonly getArchiveBehavior: () => CoderWorkspaceArchiveBehavior;
  /**
   * Serializes "is this its last workspace" decisions. One key for every sandbox: workspaces
   * may name one sandbox by its name or by its id, so a per-string key would not serialize them.
   */
  private readonly removalLocks = new MutexMap<string>();
  /**
   * Workspaces whose removal passed its checks and deleted its checkout, but that the
   * workspace list may still show until the removal is persisted, by that removal's
   * pendingRemoval marker. A removal that then fails (deregistration rejects) releases its
   * marker, and a retry claims a new one: either way the record no longer applies, so the
   * still registered workspace counts as a reference again.
   */
  private readonly removedWorkspaces = new Map<string, string>();

  constructor(options: DaytonaServiceOptions) {
    this.credentialsStore = options.credentialsStore;
    this.rootDir = options.rootDir;
    this.sshConfigWriter =
      options.sshConfigWriter ?? new DaytonaSshConfigWriter({ xumHome: options.rootDir });
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.listWorkspaces = options.listWorkspaces;
    this.getArchiveBehavior = options.getArchiveBehavior ?? (() => "keep");
    this.retireSshConnections =
      options.retireSshConnections ??
      ((sandboxId) => retireSshConnections({ host: toXumDaytonaHost(sandboxId) }));
  }

  /**
   * Register every token the include file holds now with the redactor. The file is shared by
   * every Xum backend on this root, and ssh sends whatever token it holds: one an earlier
   * process left (ssh keeps sending it until Xum replaces it) or one another backend wrote
   * since. So every ssh to a sandbox (ensureSshAccess, the runtime's commands) reads it first,
   * and a failed read fails that ssh. Startup reads it too but goes on when the read fails.
   * A missing file holds nothing.
   */
  async loadPersistedTokens(): Promise<void> {
    await this.readIncludeFileTokens();
  }

  private async readIncludeFileTokens(): Promise<Map<string, string>> {
    let entries: Array<{ sandboxId: string; token: string }>;
    try {
      entries = await this.sshConfigWriter.readTokens();
    } catch (error) {
      log.warn("Could not read the Daytona ssh tokens in the include file", {
        error: getErrorMessage(error),
      });
      throw error;
    }
    const tokens = new Map<string, string>();
    for (const { sandboxId, token } of entries) {
      rememberDaytonaToken(token);
      tokens.set(sandboxId, token);
      // An earlier process's tokens: holding them lets a replacement, a settings change or an
      // archive revoke them. The file has no expiry, so they are due for refresh at once.
      if (!this.persistedTokensLoaded && !this.tokens.has(sandboxId)) {
        this.cacheNewToken(sandboxId, { token, expiresAt: new Date(0).toISOString() });
      }
    }
    this.persistedTokensLoaded = true;
    return tokens;
  }

  /**
   * This process's view of the include file goes stale when another backend edits it: one
   * that released the sandbox's access removed the alias (write it again), one that minted
   * wrote its own token (hold that one, which ssh now sends). Skipped when this process
   * changed the sandbox's access during the read, which then may predate its own write.
   */
  private async revalidateSshAccess(sandboxId: string): Promise<void> {
    const generation = this.sshTokenGeneration(sandboxId);
    const releases = this.accessReleases.get(sandboxId);
    const fileToken = (await this.readIncludeFileTokens()).get(sandboxId);
    const unchanged =
      generation === this.sshTokenGeneration(sandboxId) &&
      releases === this.accessReleases.get(sandboxId);
    if (!unchanged) return;
    if (this.sshConfigured.has(sandboxId)) this.followIncludeFile(sandboxId, fileToken);
    else this.holdFirstSeenToken(sandboxId, fileToken);
  }

  private followIncludeFile(sandboxId: string, fileToken: string | undefined): void {
    const cached = this.tokens.get(sandboxId);
    if (fileToken === undefined) {
      this.sshConfigured.delete(sandboxId);
      this.readyAt.delete(sandboxId);
      // Due at once: the mint writes the alias again and revokes this token.
      if (cached) this.tokens.set(sandboxId, { ...cached, expiresAt: new Date(0).toISOString() });
      return;
    }
    // Its expiry is unknown; it was minted after this process's, so that expiry is a bound.
    if (cached && cached.token !== fileToken) {
      this.cacheNewToken(sandboxId, { token: fileToken, expiresAt: cached.expiresAt });
    }
  }

  /**
   * Another backend set the sandbox up first: held as due at once, the mint about to run
   * replaces and revokes it (that backend's next command is refused and mints its own). Only
   * for the sandbox this process is about to use: holding another backend's tokens for others
   * would revoke them, live, on a settings change here.
   */
  private holdFirstSeenToken(sandboxId: string, fileToken: string | undefined): void {
    if (fileToken === undefined || this.tokens.has(sandboxId)) return;
    this.cacheNewToken(sandboxId, { token: fileToken, expiresAt: new Date(0).toISOString() });
  }

  getPublicConfig(): Promise<DaytonaPublicConfig> {
    return this.credentialsStore.getPublicConfig();
  }

  /**
   * Run a Daytona operation that makes more than one control-plane call, or acts on what an
   * earlier one returned (create and set up, delete after its checks, start and mint, archive,
   * a reconcile sweep), against one account. setConfig refuses while any runs, so none spans a
   * settings change; one that starts while a change is saved waits for it. Leases nest.
   */
  async withAccountLease<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      while (this.settingsChange) await settled(this.settingsChange);
      // A held lease pins the account; the outer one must not pin a stale snapshot, so it
      // first takes what another Xum process may have saved since this one last read.
      if (this.accountLeases > 0) break;
      // Shared, so concurrent claimers resume (and start their operations) in call order.
      this.idleRefresh ??= this.refreshIdleCredentials().finally(() => {
        this.idleRefresh = undefined;
      });
      await this.idleRefresh;
      // No await between this check and the claim (as in setConfig).
      if (!this.settingsChange) break;
    }
    this.accountLeases++;
    try {
      return await fn();
    } finally {
      this.accountLeases--;
    }
  }

  /** Refused at once (DaytonaConfigError, shown in Settings) while a lease is held. */
  async setConfig(patch: DaytonaCredentialsPatch): Promise<DaytonaPublicConfig> {
    while (this.settingsChange) await settled(this.settingsChange);
    // No await between this check and the assignment: a lease cannot start in between.
    if (this.accountLeases > 0) throw new DaytonaConfigError(DAYTONA_BUSY_MESSAGE);
    const change = this.applyConfig(patch);
    this.settingsChange = change;
    try {
      return await change;
    } finally {
      if (this.settingsChange === change) this.settingsChange = undefined;
    }
  }

  private async applyConfig(patch: DaytonaCredentialsPatch): Promise<DaytonaPublicConfig> {
    const previousClient = await this.getClientIfConfigured();
    await this.credentialsStore.update(patch);
    this.credentialsSnapshot = await this.readSavedCredentials();
    this.accountFingerprint =
      this.credentialsSnapshot && fingerprintAccount(this.credentialsSnapshot.credentials);
    // Revoke the old account's tokens with the old credentials, which may not work for the
    // new ones.
    const tokens = await this.retireAccountCaches();
    if (previousClient) {
      await Promise.all(
        tokens.map(([sandboxId, access]) =>
          this.revokeQuietly(previousClient, sandboxId, access.token)
        )
      );
    }
    return this.credentialsStore.getPublicConfig();
  }

  /**
   * Tokens and gateway data belong to the old account or deployment. A mint in flight
   * finishes under the old settings: it sees the bump and starts over. Returns the tokens
   * dropped, for the caller to revoke.
   */
  private async retireAccountCaches(
    beforeRetiringConnections?: (tokens: Array<[string, DaytonaSshAccess]>) => Promise<void>
  ): Promise<Array<[string, DaytonaSshAccess]>> {
    this.credentialsGeneration++;
    this.provenOwned.clear();
    const tokens = [...this.tokens];
    const connected = this.sandboxesWithSsh();
    this.gatewayCache = undefined;
    this.tokens.clear();
    this.sshConfigured.clear();
    this.readyAt.clear();
    await beforeRetiringConnections?.(tokens);
    await this.retirePooledSsh(connected);
    return tokens;
  }

  private async readSavedCredentials(): Promise<
    { credentials: DaytonaResolvedCredentials | null } | undefined
  > {
    try {
      return { credentials: await this.credentialsStore.resolve() };
    } catch (error) {
      log.debug("Could not read the saved Daytona settings", { error: getErrorMessage(error) });
      return undefined;
    }
  }

  /**
   * Another Xum process saved credentials of another account: drop this process's caches of
   * the old one. Its tokens are not revoked: they expire, and the old key may be gone.
   */
  private async noticeAccount(credentials: DaytonaResolvedCredentials | null): Promise<void> {
    // This process's own save sets the fingerprint and retires (and revokes) itself.
    if (this.settingsChange) return;
    const fingerprint = fingerprintAccount(credentials);
    const previous = this.accountFingerprint;
    this.accountFingerprint = fingerprint;
    if (previous === undefined || previous === fingerprint) return;
    log.info("Daytona settings changed in another Xum process; dropping cached SSH access");
    await this.retireAccountCaches((tokens) => this.removeOldAccountAliases(tokens));
  }

  /**
   * The old account's tokens cannot be revoked here, so their aliases leave the shared include
   * file before the connections are retired (as releaseSshAccess does): a fresh ssh from an
   * alias would otherwise keep reaching the old sandbox until the token expires. Only blocks
   * still holding this process's token go: the other backend may have rewritten an alias.
   */
  private async removeOldAccountAliases(tokens: Array<[string, DaytonaSshAccess]>) {
    try {
      await this.sshConfigWriter.removeSandboxTokens(
        tokens.map(([sandboxId, access]) => ({ sandboxId, token: access.token }))
      );
    } catch (error) {
      log.warn("Could not remove the old Daytona account's ssh aliases", {
        error: getErrorMessage(error),
      });
    }
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
   * sandbox. Daytona takes a sandbox's name or its id, and both get stored: Xum keeps the name
   * of a sandbox it created, the attach picker the id. So when another workspace stores a
   * different string, the sandbox is looked up and matched by both. Fails closed, as
   * referenced, when the workspace list, the caller's id or the lookup is unavailable: a kept
   * sandbox only costs storage (the reconciler stops it), a deleted one loses the other
   * workspace's work. A sandbox that is already gone has no references left to protect.
   */
  async isSandboxReferencedElsewhere(
    sandboxId: string,
    workspaceId: string | undefined
  ): Promise<boolean> {
    return (await this.sandboxReferencesElsewhere(sandboxId, workspaceId)) !== "none";
  }

  /**
   * Who else references the sandbox, matched as in isSandboxReferencedElsewhere: "none",
   * "attached" (only workspaces that attached it, through which Xum never deletes it), or
   * "other" (a workspace that may delete it, or a failed lookup).
   */
  async sandboxReferencesElsewhere(
    sandboxId: string,
    workspaceId: string | undefined
  ): Promise<"none" | "attached" | "other"> {
    if (!this.listWorkspaces || !workspaceId) return "other";
    const others = this.refsStoredElsewhere(this.listWorkspaces(), workspaceId);
    if (others.length === 0) return "none";
    const matched = await this.refsMatchingSandbox(sandboxId, others);
    if (!matched) return "other";
    if (matched.length === 0) return "none";
    return matched.every((ref) => ref.attached) ? "attached" : "other";
  }

  /**
   * For archive: whether another workspace still works in the sandbox ("active"), only
   * archived ones reference it ("archived", or "archivedOwner" when one of them is a workspace
   * whose sandbox Xum created, whose archive left the sandbox alone), or none does. Matched and
   * failing closed (as "active") like sandboxReferencesElsewhere; removal still counts
   * archived workspaces.
   */
  async sandboxUseElsewhere(
    sandboxId: string,
    workspaceId: string | undefined
  ): Promise<"none" | "archived" | "archivedOwner" | "active"> {
    if (!this.listWorkspaces || !workspaceId) return "active";
    const others = this.refsStoredElsewhere(this.listWorkspaces(), workspaceId);
    if (others.length === 0) return "none";
    const matched = await this.refsMatchingSandbox(sandboxId, others);
    if (!matched) return "active";
    if (matched.length === 0) return "none";
    if (!matched.every((ref) => ref.archived)) return "active";
    return matched.some((ref) => !ref.attached) ? "archivedOwner" : "archived";
  }

  /**
   * The other workspaces on the sandbox (archived ones and borrowed checkouts included), for
   * checks that must cover every job in it. Matched as in sandboxReferencesElsewhere; undefined
   * when the workspace list, the caller's id or the lookup is unavailable.
   */
  async otherWorkspacesOnSandbox(
    sandboxId: string,
    workspaceId: string | undefined
  ): Promise<DaytonaWorkspaceOnSandbox[] | undefined> {
    if (!this.listWorkspaces || !workspaceId) return undefined;
    const others = this.listWorkspaces().flatMap((ref) =>
      ref.workspaceId === workspaceId || this.isRemovalInFlight(ref) ? [] : onSandboxRef(ref)
    );
    if (others.length === 0) return [];
    const matched = await this.refsMatchingSandbox(sandboxId, others);
    return matched?.map((ref) => ({
      workspaceId: ref.workspaceId,
      runtimeConfig: ref.runtimeConfig,
    }));
  }

  /** The refs that store this sandbox by its name or its id; undefined when the lookup fails. */
  private async refsMatchingSandbox<T extends { stored: string }>(
    sandboxId: string,
    refs: T[]
  ): Promise<T[] | undefined> {
    const aliases = refs.every((ref) => ref.stored === sandboxId)
      ? new Set([sandboxId])
      : await this.sandboxAliases(sandboxId);
    return aliases && refs.filter((ref) => ref.stored === sandboxId || aliases.has(ref.stored));
  }

  /**
   * Whether a workspace other than `workspaceId` stores exactly this string as its sandbox:
   * Xum's ssh access (token, include block) is per stored string. True (keep the access) when
   * the workspace list or the caller's id is unavailable.
   */
  isAliasStoredElsewhere(alias: string, workspaceId: string | undefined): boolean {
    if (!this.listWorkspaces || !workspaceId) return true;
    return this.refsStoredElsewhere(this.listWorkspaces(), workspaceId).some(
      (ref) => ref.stored === alias
    );
  }

  /**
   * What the other workspaces (removals in flight and borrowed checkouts excluded) store as
   * their sandbox.
   */
  private refsStoredElsewhere(
    refs: DaytonaWorkspaceRef[],
    workspaceId: string
  ): StoredSandboxRef[] {
    return refs.flatMap((ref) => {
      const stored = getDaytonaSandboxId(ref.runtimeConfig);
      const counts =
        ref.workspaceId !== workspaceId &&
        !this.isRemovalInFlight(ref) &&
        ref.borrowsCheckout !== true;
      return counts && stored
        ? [
            {
              stored,
              attached: !isDedicatedDaytonaSandbox(ref.runtimeConfig),
              archived: ref.archived === true,
            },
          ]
        : [];
    });
  }

  private isRemovalInFlight(ref: DaytonaWorkspaceRef): boolean {
    return (
      ref.pendingRemovalId !== undefined &&
      this.removedWorkspaces.get(ref.workspaceId) === ref.pendingRemovalId
    );
  }

  /** The sandbox's id and name (empty when it is gone); undefined when the lookup fails. */
  private async sandboxAliases(sandboxId: string): Promise<Set<string> | undefined> {
    try {
      const { sandbox } = await this.getSandboxState(sandboxId);
      return new Set([sandbox?.id, sandbox?.name].filter((alias): alias is string => !!alias));
    } catch (error) {
      log.warn("Could not look up a Daytona sandbox to match its references", {
        sandboxId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /** Run `fn` after every earlier removal decision has settled. */
  withSandboxRemovalLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.removalLocks.withLock("daytona-sandbox-removal", fn);
  }

  /**
   * The workspace no longer references its sandbox while its current removal is in flight,
   * even though the workspace list still shows it. A listed workspace without a removal
   * marker is not recorded: it keeps counting, which can only keep a sandbox.
   */
  recordWorkspaceRemoval(workspaceId: string): void {
    const ref = this.listWorkspaces?.().find((entry) => entry.workspaceId === workspaceId);
    if (ref?.pendingRemovalId) this.removedWorkspaces.set(workspaceId, ref.pendingRemovalId);
  }

  recordSetupFailure(sandboxId: string, reason: string): void {
    this.setupFailures.set(sandboxId, reason);
  }

  getSetupFailure(sandboxId: string): string | undefined {
    return this.setupFailures.get(sandboxId);
  }

  async checkAvailability(): Promise<DaytonaAvailability> {
    let credentials: DaytonaResolvedCredentials | null;
    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      if (!(error instanceof DaytonaApiError)) throw error;
      return { available: false, reason: error.message };
    }
    if (!credentials) {
      return {
        available: false,
        reason: "Set a Daytona API key in Settings > Runtimes (or DAYTONA_API_KEY)",
      };
    }
    return { available: true };
  }

  /** The idle read before a lease; unusable settings fail the lease's own first call. */
  private async refreshIdleCredentials(): Promise<void> {
    try {
      await this.resolveCredentials();
    } catch (error) {
      log.debug("Could not read the Daytona settings before an operation", {
        error: getErrorMessage(error),
      });
      // The lease must not pin the account this process used before: unusable settings must
      // make Daytona unusable, so its first resolve reads them again and fails.
      this.credentialsSnapshot = undefined;
    }
  }

  /** Unusable settings (an http DAYTONA_API_URL) throw a `not_configured` DaytonaApiError. */
  private async resolveCredentials(): Promise<DaytonaResolvedCredentials | null> {
    const pinned = () =>
      (this.accountLeases > 0 || this.settingsChange !== undefined) && this.credentialsSnapshot;
    const held = pinned();
    if (held) return held.credentials;
    try {
      const credentials = await this.credentialsStore.resolve();
      // A lease or save that started during the read keeps the account it started with.
      const heldNow = pinned();
      if (heldNow) return heldNow.credentials;
      this.credentialsSnapshot = { credentials };
      await this.noticeAccount(credentials);
      return credentials;
    } catch (error) {
      if (error instanceof DaytonaConfigError) {
        throw new DaytonaApiError("not_configured", error.message);
      }
      throw error;
    }
  }

  /** Throws a `not_configured` DaytonaApiError when no API key is set. */
  async getClient(): Promise<{ client: DaytonaClient; credentials: DaytonaResolvedCredentials }> {
    const credentials = await this.resolveCredentials();
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

  /** Stamped before the lookup, so a change during it reads as a change. */
  async getAccount(): Promise<DaytonaAccount> {
    const generation = this.credentialsGeneration;
    const { client } = await this.getClient();
    return { client, generation };
  }

  /** Whether the settings changed since `account` was taken. */
  isAccountCurrent(account: DaytonaAccount): boolean {
    return account.generation === this.credentialsGeneration;
  }

  private async clientOf(account: DaytonaAccount | undefined): Promise<DaytonaClient> {
    return account?.client ?? (await this.getClient()).client;
  }

  /** `force` refetches a cached `/config` that is still fresh (an in-flight fetch is shared). */
  async getGatewayConfig(options: { force?: boolean } = {}): Promise<DaytonaGatewayConfig> {
    const generation = this.credentialsGeneration;
    const { client, credentials } = await this.getClient();
    const cached = this.cachedGateway(credentials.apiUrl, generation);
    if (cached && !options.force && this.now() - cached.fetchedAt < DAYTONA_GATEWAY_CONFIG_TTL_MS) {
      return cached.config;
    }
    return this.sharedGatewayRefresh(client, credentials.apiUrl, generation, cached);
  }

  /**
   * Concurrent lookups share one refresh: a reply that started earlier and arrived last would
   * otherwise publish the old gateway over the new one.
   */
  private sharedGatewayRefresh(
    client: DaytonaClient,
    apiUrl: string,
    generation: number,
    cached: ReturnType<DaytonaService["cachedGateway"]>
  ): Promise<DaytonaGatewayConfig> {
    const inFlight = this.gatewayRequest;
    if (inFlight?.apiUrl === apiUrl && inFlight.generation === generation) {
      return inFlight.promise;
    }
    const promise = this.refreshGateway(client, apiUrl, generation, cached).finally(() => {
      if (this.gatewayRequest?.promise === promise) this.gatewayRequest = undefined;
    });
    this.gatewayRequest = { apiUrl, generation, promise };
    return promise;
  }

  private async refreshGateway(
    client: DaytonaClient,
    apiUrl: string,
    generation: number,
    cached: ReturnType<DaytonaService["cachedGateway"]>
  ): Promise<DaytonaGatewayConfig> {
    const config = await client.getConfig();
    // Fetched across a settings change: never cache it for lookups under the new settings.
    if (this.credentialsGeneration !== generation) return config;
    const moved = cached && gatewayIdentity(cached.config) !== gatewayIdentity(config);
    this.gatewayCache = { apiUrl, generation, fetchedAt: this.now(), config };
    if (moved) {
      await this.retireSshSetup(config);
      this.gatewayMoves++;
    }
    return config;
  }

  /** Bumped once a moved gateway's ssh setup was rewritten; capture it before an ssh command. */
  gatewayGeneration(): number {
    return this.gatewayMoves;
  }

  /**
   * An ssh command to a started sandbox failed with neither a refused token nor a stop: Daytona
   * may have moved its gateway or rotated its host keys within the `/config` cache. True when
   * the gateway changed since `attemptGeneration` (refetching `/config` unless a concurrent
   * failure already found the move) and the sandbox's ssh setup now points at the new one.
   */
  async refreshGatewayAfterSshFailure(
    sandboxId: string,
    attemptGeneration: number
  ): Promise<boolean> {
    if (this.gatewayMoves === attemptGeneration) await this.getGatewayConfig({ force: true });
    if (this.gatewayMoves === attemptGeneration) return false;
    await this.ensureSshAccess(sandboxId);
    return true;
  }

  /** The cached `/config` of these settings, fresh or not. */
  private cachedGateway(apiUrl: string, generation: number) {
    const cached = this.gatewayCache;
    return cached?.apiUrl === apiUrl && cached.generation === generation ? cached : undefined;
  }

  /**
   * Daytona moved its gateway or rotated its host keys: every include block and the
   * known_hosts pins are stale. Each sandbox's next ssh access mints a token, which rewrites
   * its whole ssh setup and revokes the old token.
   *
   * Install first, retire last: a command connecting while the old connections are retired
   * then reads the new files and caches, so no connection to the old gateway outlives this.
   * Retiring first left a window in which a turn reconnected from the stale setup.
   */
  private async retireSshSetup(config: DaytonaGatewayConfig): Promise<void> {
    const sandboxIds = this.sandboxesWithSsh();
    this.sshConfigured.clear();
    this.readyAt.clear();
    for (const [sandboxId, access] of this.tokens) {
      this.tokens.set(sandboxId, { ...access, expiresAt: new Date(0).toISOString() });
    }
    try {
      await this.sshConfigWriter.repointGateway(toSshGateway(config));
    } catch (error) {
      // Each sandbox's next ssh access rewrites its setup anyway.
      log.warn("Could not repoint the Daytona ssh setup at the moved gateway", {
        error: getErrorMessage(error),
      });
    }
    await this.retirePooledSsh(sandboxIds);
  }

  private sandboxesWithSsh(): string[] {
    return [...new Set([...this.tokens.keys(), ...this.sshConfigured])];
  }

  /**
   * Pooled ssh connections (OpenSSH ControlMasters, ssh2 clients) outlive the include file
   * they were opened with: without this, later commands keep reaching the old deployment.
   */
  private async retirePooledSsh(sandboxIds: string[]): Promise<void> {
    await Promise.all(
      sandboxIds.map(async (sandboxId) => {
        try {
          await this.retireSshConnections(sandboxId);
        } catch (error) {
          log.warn("Could not retire the pooled ssh connections of a Daytona sandbox", {
            sandboxId,
            error: getErrorMessage(error),
          });
        }
      })
    );
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
          // Error states (destroyed and destroying included) cannot be started or attached.
          .filter(
            (sandbox) =>
              mapDaytonaSandboxState(sandbox.state) !== "error" &&
              !unsupportedDaytonaSandboxKind(sandbox)
          )
          .map(toSummary),
      };
    } catch (error) {
      return toResultError(error);
    }
  }

  async listSnapshots(): Promise<DaytonaListSnapshotsResult> {
    try {
      const { client } = await this.getClient();
      const snapshots = await client.listSnapshots();
      return {
        ok: true,
        snapshots: snapshots
          .filter((s) => !unsupportedDaytonaSandboxKind(s) && isActiveSnapshot(s))
          .map(({ name }) => ({ name })),
      };
    } catch (error) {
      return toResultError(error);
    }
  }

  /**
   * The snapshot named `name`, with the unsupported kind of sandbox it creates (if any) and its state; undefined when
   * Daytona has none by that name. The list is the fallback for one the lookup does not find
   * by name (it serves the snapshot picker).
   */
  async findSnapshot(
    name: string
  ): Promise<{ unsupported?: UnsupportedDaytonaSandboxKind; state?: string } | undefined> {
    const { client } = await this.getClient();
    let snapshot: DaytonaSnapshot | undefined;
    try {
      snapshot = await client.getSnapshot(name);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
      snapshot = (await client.listSnapshots()).find((listed) => listed.name === name);
    }
    return (
      snapshot && {
        unsupported: unsupportedDaytonaSandboxKind(snapshot),
        ...(snapshot.state ? { state: snapshot.state } : {}),
      }
    );
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
    sandboxId: string,
    account?: DaytonaAccount
  ): Promise<{ state: DaytonaSandboxState; sandbox?: DaytonaSandbox }> {
    const client = await this.clientOf(account);
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
    return (await this.resolveCredentials())?.target;
  }

  async createSandbox(
    request: DaytonaCreateSandboxRequest,
    account?: DaytonaAccount
  ): Promise<DaytonaSandbox> {
    return (await this.clientOf(account)).createSandbox(request);
  }

  async resizeSandbox(sandboxId: string, request: DaytonaResizeRequest): Promise<void> {
    const { client } = await this.getClient();
    this.readyAt.delete(sandboxId);
    await client.resizeSandbox(sandboxId, request);
  }

  /**
   * Hand a sandbox Xum created to the user: drop this install's label, which is what makes the
   * reconciler stop it once no workspace references it.
   */
  async disownSandbox(sandboxId: string): Promise<void> {
    const { client } = await this.getClient();
    this.provenOwned.delete(sandboxId);
    const labels = (await client.getSandbox(sandboxId)).labels ?? {};
    if (!(DAYTONA_LABEL_INSTANCE in labels)) return;
    const kept = Object.entries(labels).filter(([key]) => key !== DAYTONA_LABEL_INSTANCE);
    await client.replaceLabels(sandboxId, Object.fromEntries(kept));
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
   * Delete a sandbox Xum created and drop Xum's SSH access to it (token and include block). A
   * sandbox that is already gone counts as deleted. `account` deletes it in the account it was
   * created in, even after the settings changed to another one.
   *
   * A workspace's `shared: false` is not proof: a create of unknown outcome may have left it
   * naming a sandbox someone else holds. So only a sandbox with this install's label is
   * deleted; "notOwned" leaves it, and its access, to the caller.
   */
  async deleteSandbox(
    sandboxId: string,
    account?: DaytonaAccount
  ): Promise<"deleted" | "notOwned"> {
    const client = await this.clientOf(account);
    if ((await this.ownershipWith(client, sandboxId)) === "notOwned") return "notOwned";
    this.provenOwned.delete(sandboxId);
    // Revoke first: Daytona refuses to revoke a token of a sandbox that no longer exists.
    await this.releaseSshAccess(sandboxId);
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
    if (!options.reuseProof) return this.ownershipWith((await this.getClient()).client, sandboxId);
    const provenAt = this.provenOwned.get(sandboxId);
    if (provenAt !== undefined && this.now() - provenAt < DAYTONA_READY_CACHE_MS) return "owned";
    // Concurrent checks share one read, so they reach the shared start together.
    const request = this.ownershipRequests.get(sandboxId) ?? this.proveOwnership(sandboxId);
    return raceAbort(request, options.signal);
  }

  private proveOwnership(sandboxId: string): Promise<"owned" | "notOwned" | "missing"> {
    const generation = this.credentialsGeneration;
    const request = (async () => {
      const ownership = await this.ownershipWith((await this.getClient()).client, sandboxId);
      // A proof from before a settings change belongs to the old account.
      if (ownership !== "owned") this.provenOwned.delete(sandboxId);
      else if (generation === this.credentialsGeneration)
        this.provenOwned.set(sandboxId, this.now());
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
    const request = this.readyRequests.get(sandboxId) ?? this.startReadyRequest(sandboxId);
    const { onStarting, signal } = options;
    if (!onStarting || signal?.aborted) return raceAbort(request.promise, signal);
    // Per waiter, so the same callback passed twice is two waiters.
    const listener = () => onStarting();
    request.onStarting.add(listener);
    if (request.starting) listener();
    // A waiter that stopped waiting (cancelled) hears no later start: nothing would report its end.
    return raceAbort(request.promise, signal).finally(() => request.onStarting.delete(listener));
  }

  private startReadyRequest(sandboxId: string): SandboxReadyRequest {
    const request: SandboxReadyRequest = {
      promise: Promise.resolve(),
      onStarting: new Set(),
      starting: false,
    };
    request.promise = this.withAccountLease(async () => {
      await this.startAndWait(sandboxId, this.now() + DAYTONA_START_TIMEOUT_MS, {
        onStarting: () => {
          request.starting = true;
          for (const listener of request.onStarting) listener();
        },
      });
      await this.ensureSshAccess(sandboxId);
    }).finally(() => {
      this.readyRequests.delete(sandboxId);
    });
    this.readyRequests.set(sandboxId, request);
    return request;
  }

  /**
   * A valid token in the include file for this sandbox. The first write in this process also
   * writes known_hosts and the `~/.ssh/config` block; a refresh rewrites only the include file.
   * The `~/.ssh/config` block is checked every time: another tool may have removed it while a
   * cached token stays fresh, and an external editor needs it to resolve the alias.
   */
  ensureSshAccess(sandboxId: string): Promise<void> {
    return this.withAccountLease(async () => {
      await this.revalidateSshAccess(sandboxId);
      // Fails before a mint when the control plane cannot say where the gateway is.
      await this.getGatewayConfig();
      // A cached token was written by the mint that produced it, so only a mint writes files.
      await this.getSshToken(sandboxId, {
        onNewToken: async ({ token }) => {
          // Looked up after the mint, so a settings change before it cannot pair this token with
          // the old deployment's gateway; one after it makes the mint start over.
          const gateway = toSshGateway(await this.getGatewayConfig());
          if (this.sshConfigured.has(sandboxId)) {
            await this.sshConfigWriter.updateToken({ sandboxId, token, gateway });
            return;
          }
          await this.sshConfigWriter.writeSandbox({ sandboxId, token, gateway });
        },
      });
      await this.sshConfigWriter.ensureManagedBlock();
      this.sshConfigured.add(sandboxId);
    });
  }

  /**
   * Which token the sandbox's ssh commands use now. Capture it before a command: if the gateway
   * refuses that command's token, pass it to replaceRejectedSshToken.
   */
  sshTokenGeneration(sandboxId: string): number {
    return this.tokenGenerations.get(sandboxId) ?? 0;
  }

  private cacheNewToken(sandboxId: string, access: DaytonaSshAccess): void {
    this.tokens.set(sandboxId, access);
    this.tokenGenerations.set(sandboxId, ++this.lastTokenGeneration);
  }

  /**
   * The gateway refused the token of a command that started at `attemptGeneration` (revoked
   * outside Xum, or one an earlier process left): mint a new one and rewrite the include file.
   * Nothing to do when the token changed since: a concurrent command already replaced it, and
   * the current one must stay live. The generation, not the ssh error, decides: the OpenSSH
   * pool redacts the token from its errors.
   */
  async replaceRejectedSshToken(sandboxId: string, attemptGeneration: number): Promise<void> {
    if (this.sshTokenGeneration(sandboxId) !== attemptGeneration) return;
    const cached = this.tokens.get(sandboxId);
    this.readyAt.delete(sandboxId);
    // Due at once, so the next ensureSshAccess mints, writes, and revokes the refused one.
    if (cached) this.tokens.set(sandboxId, { ...cached, expiresAt: new Date(0).toISOString() });
    await this.ensureSshAccess(sandboxId);
  }

  /** Whether this process holds a token for the sandbox that is close to expiry. */
  hasExpiringSshToken(sandboxId: string): boolean {
    return this.tokens.has(sandboxId) && this.tokenNeedsRefresh(sandboxId);
  }

  /**
   * Settle the readiness request in flight for this sandbox, if any. Its start and mint would
   * otherwise land after a stop or a release and undo it. Bounded by the start timeout; its
   * failure belongs to its own callers, so it is only logged here.
   */
  async waitForSandboxReadiness(sandboxId: string): Promise<void> {
    const request = this.readyRequests.get(sandboxId);
    if (!request) return;
    try {
      await request.promise;
    } catch (error) {
      log.warn("Daytona sandbox readiness failed while another operation waited for it", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
  }

  /** Revoke the token and remove the sandbox's include block. */
  async releaseSshAccess(sandboxId: string): Promise<void> {
    await this.waitForSandboxReadiness(sandboxId);
    // A mint in flight sees the bump and drops its token instead of writing it back.
    this.accessReleases.set(sandboxId, (this.accessReleases.get(sandboxId) ?? 0) + 1);
    this.sshConfigured.delete(sandboxId);
    this.readyAt.delete(sandboxId);
    await this.forgetSshToken(sandboxId);
    await this.sshConfigWriter.removeSandbox(sandboxId);
    // A revoked token does not end sessions it opened: pooled connections and the bash AI
    // proxy's reverse forward would keep reaching the sandbox. Retired only once the include
    // block is gone, so nothing reconnects from it.
    await this.retirePooledSsh([sandboxId]);
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
    // Read first: another Xum process may have saved another account's credentials.
    await this.resolveCredentials();
    const cached = this.tokens.get(sandboxId);
    if (cached && !this.tokenNeedsRefresh(sandboxId)) return cached;
    const inFlight = this.tokenRequests.get(sandboxId);
    if (inFlight) return inFlight;

    const request = this.withAccountLease(() =>
      this.mintSshToken(sandboxId, cached, options)
    ).finally(() => {
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
    const stamp = this.accessStamp(sandboxId);
    const { client } = await this.getClient();
    const access = await client.createSshAccess(sandboxId, DAYTONA_SSH_TOKEN_TTL_MINUTES);
    rememberDaytonaToken(access.token);
    const mint = { client, sandboxId, access, stamp, options };
    const outdated = this.settleOutdatedMint(mint, false);
    if (outdated) return outdated;
    try {
      await options.onNewToken?.(access);
    } catch (error) {
      // Nothing holds the new token any more: revoke it rather than leave it live.
      await this.revokeQuietly(client, sandboxId, access.token);
      throw error;
    }
    const outdatedAfterWrite = this.settleOutdatedMint(mint, true);
    if (outdatedAfterWrite) return outdatedAfterWrite;
    this.cacheNewToken(sandboxId, access);
    if (previous && previous.token !== access.token) {
      await this.revokeQuietly(client, sandboxId, previous.token);
    }
    return access;
  }

  /** What a mint must still match when it completes: the settings and the sandbox's access. */
  private accessStamp(sandboxId: string): MintStamp {
    return {
      generation: this.credentialsGeneration,
      release: this.accessReleases.get(sandboxId) ?? 0,
    };
  }

  /**
   * Undefined while the mint is current. A mint that spans a settings change or a release of
   * the sandbox's access is never cached or kept in the include file: its token is revoked
   * with the client that minted it. After a settings change it mints again under the new
   * settings; after a release it fails, since the caller's access was taken away.
   */
  private settleOutdatedMint(
    mint: OutdatedMintInput,
    wroteIncludeFile: boolean
  ): Promise<DaytonaSshAccess> | undefined {
    const { client, sandboxId, access, stamp, options } = mint;
    if ((this.accessReleases.get(sandboxId) ?? 0) !== stamp.release) {
      return this.discardReleasedMint(client, sandboxId, access, wroteIncludeFile);
    }
    if (this.credentialsGeneration !== stamp.generation) {
      // The retry's onNewToken overwrites whatever this one wrote.
      return this.revokeQuietly(client, sandboxId, access.token).then(() =>
        this.mintSshToken(sandboxId, undefined, options)
      );
    }
    return undefined;
  }

  private async discardReleasedMint(
    client: DaytonaClient,
    sandboxId: string,
    access: DaytonaSshAccess,
    wroteIncludeFile: boolean
  ): Promise<never> {
    await this.revokeQuietly(client, sandboxId, access.token);
    if (wroteIncludeFile) await this.sshConfigWriter.removeSandbox(sandboxId);
    throw new Error(
      `Xum released its SSH access to Daytona sandbox "${sandboxId}" while a token was minted`
    );
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
