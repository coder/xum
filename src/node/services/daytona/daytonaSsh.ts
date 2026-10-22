import { getErrorMessage } from "@/common/utils/errors";
import type { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { rememberDaytonaToken } from "@/node/runtime/daytonaTokenRedaction";
import { log } from "@/node/services/log";
import type { DaytonaAccount } from "./daytonaAccount";
import type { DaytonaClient, DaytonaGatewayConfig, DaytonaSshAccess } from "./daytonaClient";
import type { DaytonaReadiness } from "./daytonaReadiness";

/** Tokens are minted for an hour and replaced once less than 15 minutes remain. */
export const DAYTONA_SSH_TOKEN_TTL_MINUTES = 60;
export const DAYTONA_SSH_TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;

/**
 * How long Daytona's `/config` (gateway endpoint and host keys) is trusted. Daytona can move
 * its gateway or rotate its keys while Xum runs; a refetch that sees a change rewrites every
 * sandbox's ssh setup on its next use.
 */
export const DAYTONA_GATEWAY_CONFIG_TTL_MS = 5 * 60_000;

export type DaytonaSshWriter = Pick<
  DaytonaSshConfigWriter,
  | "writeSandbox"
  | "ensureManagedBlock"
  | "updateToken"
  | "repointGateway"
  | "removeSandbox"
  | "readTokens"
  | "restoreGatewayPins"
>;

export interface DaytonaSshOptions {
  account: Pick<DaytonaAccount, "getClient" | "withAccountLease">;
  readiness: DaytonaReadiness;
  sshConfigWriter: DaytonaSshWriter;
  retireSshConnections: (sandboxId: string) => Promise<void>;
  now: () => number;
}

export interface DaytonaSshTokenOptions {
  /**
   * Runs after a fresh token is minted and before the previous one is revoked, so the caller
   * can point the ssh include file at the new token first and no new connection ever uses a
   * revoked token.
   */
  onNewToken?: (access: DaytonaSshAccess) => Promise<void>;
}

function toSshGateway(config: DaytonaGatewayConfig) {
  return {
    host: config.sshGatewayHost,
    port: config.sshGatewayPort,
    hostKeys: config.sshGatewayHostKeys,
  };
}

/** What the ssh setup depends on; key order from Daytona is not significant. */
function gatewayIdentity(config: DaytonaGatewayConfig): string {
  const { host, port, hostKeys } = toSshGateway(config);
  return JSON.stringify([host, port, [...hostKeys].sort()]);
}

/**
 * Xum's SSH access to sandboxes: the per-sandbox tokens (minted, refreshed, revoked), the
 * include file and `~/.ssh/config` block they are written to, and the gateway `/config` they
 * point at. One instance per Xum backend: a second one would mint (and revoke) tokens behind
 * the first one's back.
 */
export class DaytonaSsh {
  private readonly account: DaytonaSshOptions["account"];
  private readonly readiness: DaytonaReadiness;
  private readonly now: () => number;
  /** See gatewayGeneration. */
  private gatewayMoves = 0;
  private gatewayCache?: {
    apiUrl: string;
    fetchedAt: number;
    config: DaytonaGatewayConfig;
  };
  private gatewayRequest?: {
    apiUrl: string;
    promise: Promise<DaytonaGatewayConfig>;
  };
  private readonly tokens = new Map<string, DaytonaSshAccess>();
  /** Bumped (unique per process) whenever a sandbox's cached token becomes another one. */
  private readonly tokenGenerations = new Map<string, number>();
  private lastTokenGeneration = 0;
  private readonly tokenRequests = new Map<string, Promise<DaytonaSshAccess>>();
  /** Per sandbox: bumped by every release of its SSH access, so a mint that spans one can tell. */
  private readonly accessReleases = new Map<string, number>();
  private readonly sshConfigWriter: DaytonaSshWriter;
  private readonly retireSshConnections: DaytonaSshOptions["retireSshConnections"];
  /** Sandboxes whose include block and `~/.ssh/config` block this process has written. */
  private readonly sshConfigured = new Set<string>();
  /** Whether the include file was read once, seeding the tokens an earlier process left. */
  private persistedTokensLoaded = false;

  constructor(options: DaytonaSshOptions) {
    this.account = options.account;
    this.readiness = options.readiness;
    this.now = options.now;
    this.sshConfigWriter = options.sshConfigWriter;
    this.retireSshConnections = options.retireSshConnections;
  }

  /**
   * Register every token the include file holds with the redactor: ssh sends whatever token
   * the file holds, including one an earlier run left (ssh keeps sending it until Xum replaces
   * it). So every ssh to a sandbox reads it first, and a failed read fails that ssh. Startup
   * reads it too but goes on when the read fails. A missing file holds nothing.
   */
  async loadPersistedTokens(): Promise<void> {
    let entries: Array<{ sandboxId: string; token: string }>;
    try {
      entries = await this.sshConfigWriter.readTokens();
    } catch (error) {
      log.warn("Could not read the Daytona ssh tokens in the include file", {
        error: getErrorMessage(error),
      });
      throw error;
    }
    for (const { sandboxId, token } of entries) {
      rememberDaytonaToken(token);
      // An earlier run's tokens: holding them lets a replacement, a settings change or an
      // archive revoke them. The file has no expiry, so they are due for refresh at once.
      if (!this.persistedTokensLoaded && !this.tokens.has(sandboxId)) {
        this.cacheNewToken(sandboxId, { token, expiresAt: new Date(0).toISOString() });
      }
    }
    this.persistedTokensLoaded = true;
  }

  /**
   * Tokens and gateway data belong to the old account or deployment: drop their aliases from
   * the include file (a revoke can fail, and the alias would still reach the old account),
   * revoke the tokens with the old credentials (which may not work for the new ones) and drop
   * the caches. Connections already open may reach the old account until they end.
   */
  async forgetAccount(previousClient: DaytonaClient | undefined): Promise<void> {
    const tokens = [...this.tokens];
    this.tokens.clear();
    this.sshConfigured.clear();
    this.gatewayCache = undefined;
    for (const [sandboxId] of tokens) {
      try {
        await this.sshConfigWriter.removeSandbox(sandboxId);
      } catch (error) {
        log.warn("Failed to remove an old-account Daytona alias from the include file", {
          sandboxId,
          error: getErrorMessage(error),
        });
      }
    }
    if (previousClient) {
      await Promise.all(
        tokens.map(([sandboxId, access]) =>
          this.revokeQuietly(previousClient, sandboxId, access.token)
        )
      );
    }
  }

  /** `force` refetches a cached `/config` that is still fresh (an in-flight fetch is shared). */
  async getGatewayConfig(options: { force?: boolean } = {}): Promise<DaytonaGatewayConfig> {
    const { client, credentials } = await this.account.getClient();
    const cached = this.cachedGateway(credentials.apiUrl);
    if (cached && !options.force && this.now() - cached.fetchedAt < DAYTONA_GATEWAY_CONFIG_TTL_MS) {
      return cached.config;
    }
    return this.sharedGatewayRefresh(client, credentials.apiUrl, cached);
  }

  /**
   * Concurrent lookups share one refresh: a reply that started earlier and arrived last would
   * otherwise publish the old gateway over the new one.
   */
  private sharedGatewayRefresh(
    client: DaytonaClient,
    apiUrl: string,
    cached: ReturnType<DaytonaSsh["cachedGateway"]>
  ): Promise<DaytonaGatewayConfig> {
    const inFlight = this.gatewayRequest;
    if (inFlight?.apiUrl === apiUrl) return inFlight.promise;
    const promise = this.refreshGateway(client, apiUrl, cached).finally(() => {
      if (this.gatewayRequest?.promise === promise) this.gatewayRequest = undefined;
    });
    this.gatewayRequest = { apiUrl, promise };
    return promise;
  }

  private async refreshGateway(
    client: DaytonaClient,
    apiUrl: string,
    cached: ReturnType<DaytonaSsh["cachedGateway"]>
  ): Promise<DaytonaGatewayConfig> {
    const config = await client.getConfig();
    const moved = cached && gatewayIdentity(cached.config) !== gatewayIdentity(config);
    this.gatewayCache = { apiUrl, fetchedAt: this.now(), config };
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
   * failure already found the move) and the sandbox's ssh setup now points at the new one, or
   * when the gateway stayed but its pins in known_hosts had to be put back.
   */
  async refreshGatewayAfterSshFailure(
    sandboxId: string,
    attemptGeneration: number
  ): Promise<boolean> {
    if (this.gatewayMoves === attemptGeneration) {
      const config = await this.getGatewayConfig({ force: true });
      if (this.gatewayMoves === attemptGeneration) return this.restoreGatewayPins(config);
    }
    await this.ensureSshAccess(sandboxId);
    return true;
  }

  /**
   * The pins come from the `/config` just fetched, never from a key a server offered. Only here,
   * after a fresh fetch: a readiness check reads a cached `/config`.
   */
  private async restoreGatewayPins(config: DaytonaGatewayConfig): Promise<boolean> {
    const restored = await this.sshConfigWriter.restoreGatewayPins(toSshGateway(config));
    if (restored) log.info("Daytona gateway pins were missing or changed; wrote them again");
    return restored;
  }

  /** The cached `/config` of these settings, fresh or not. */
  private cachedGateway(apiUrl: string) {
    const cached = this.gatewayCache;
    return cached?.apiUrl === apiUrl ? cached : undefined;
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
    this.readiness.invalidateAll();
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

  /**
   * A valid token in the include file for this sandbox. The first write in this process also
   * writes known_hosts and the `~/.ssh/config` block; a refresh rewrites only the include file.
   * The `~/.ssh/config` block is checked every time: another tool may have removed it while a
   * cached token stays fresh, and an external editor needs it to resolve the alias.
   */
  ensureSshAccess(sandboxId: string): Promise<void> {
    return this.account.withAccountLease(async () => {
      // Fails before a mint when the control plane cannot say where the gateway is.
      await this.getGatewayConfig();
      // A cached token was written by the mint that produced it, so only a mint writes files.
      await this.getSshToken(sandboxId, {
        onNewToken: async ({ token }) => {
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
    this.readiness.invalidateSandboxReady(sandboxId);
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
    await this.readiness.waitForSandboxReadiness(sandboxId);
    // A mint in flight sees the bump and drops its token instead of writing it back.
    this.accessReleases.set(sandboxId, this.releaseCount(sandboxId) + 1);
    this.sshConfigured.delete(sandboxId);
    this.readiness.invalidateSandboxReady(sandboxId);
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
    const cached = this.tokens.get(sandboxId);
    if (cached && !this.tokenNeedsRefresh(sandboxId)) return cached;
    const inFlight = this.tokenRequests.get(sandboxId);
    if (inFlight) return inFlight;

    const request = this.account
      .withAccountLease(() => this.mintSshToken(sandboxId, cached, options))
      .finally(() => {
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
    const release = this.releaseCount(sandboxId);
    const released = () => this.releaseCount(sandboxId) !== release;
    const { client } = await this.account.getClient();
    const access = await client.createSshAccess(sandboxId, DAYTONA_SSH_TOKEN_TTL_MINUTES);
    rememberDaytonaToken(access.token);
    // A mint that spans a release of the sandbox's access is never cached or kept in the
    // include file: the caller's access was taken away.
    if (released()) return this.discardReleasedMint(client, sandboxId, access, false);
    await this.announceNewToken(client, sandboxId, access, options);
    if (released()) return this.discardReleasedMint(client, sandboxId, access, true);
    this.cacheNewToken(sandboxId, access);
    if (previous && previous.token !== access.token) {
      await this.revokeQuietly(client, sandboxId, previous.token);
    }
    return access;
  }

  private releaseCount(sandboxId: string): number {
    return this.accessReleases.get(sandboxId) ?? 0;
  }

  private async announceNewToken(
    client: DaytonaClient,
    sandboxId: string,
    access: DaytonaSshAccess,
    options: DaytonaSshTokenOptions
  ): Promise<void> {
    try {
      await options.onNewToken?.(access);
    } catch (error) {
      // Nothing holds the new token any more: revoke it rather than leave it live.
      await this.revokeQuietly(client, sandboxId, access.token);
      throw error;
    }
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
    const { client } = await this.account.getClient();
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
