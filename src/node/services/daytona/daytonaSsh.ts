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

export type DaytonaSshWriter = Pick<
  DaytonaSshConfigWriter,
  | "writeSandbox"
  | "ensureManagedBlock"
  | "updateToken"
  | "repointGateway"
  | "removeSandbox"
  | "readTokens"
>;

export interface DaytonaSshOptions {
  account: Pick<DaytonaAccount, "getClient">;
  readiness: DaytonaReadiness;
  sshConfigWriter: DaytonaSshWriter;
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
  /** Daytona's `/config` of these settings, fetched once; a repair fetches it again. */
  private gatewayCache?: { apiUrl: string; config: DaytonaGatewayConfig };
  private readonly tokens = new Map<string, DaytonaSshAccess>();
  private readonly tokenRequests = new Map<string, Promise<DaytonaSshAccess>>();
  private readonly sshConfigWriter: DaytonaSshWriter;
  /** Sandboxes whose include block and `~/.ssh/config` block this process has written. */
  private readonly sshConfigured = new Set<string>();
  /** Whether the include file was read once, seeding the tokens an earlier process left. */
  private persistedTokensLoaded = false;
  /** Counts forgetAccount calls: a mint that spans one holds a token the call never saw. */
  private accountChanges = 0;

  constructor(options: DaytonaSshOptions) {
    this.account = options.account;
    this.readiness = options.readiness;
    this.now = options.now;
    this.sshConfigWriter = options.sshConfigWriter;
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
        this.tokens.set(sandboxId, { token, expiresAt: new Date(0).toISOString() });
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
    this.accountChanges++;
    const tokens = [...this.tokens];
    this.tokens.clear();
    this.sshConfigured.clear();
    this.gatewayCache = undefined;
    for (const [sandboxId] of tokens) await this.removeOldAccountAlias(sandboxId);
    if (previousClient) {
      await Promise.all(
        tokens.map(([sandboxId, access]) =>
          this.revokeQuietly(previousClient, sandboxId, access.token)
        )
      );
    }
  }

  async getGatewayConfig(): Promise<DaytonaGatewayConfig> {
    const { client, credentials } = await this.account.getClient();
    const cached = this.gatewayCache;
    if (cached?.apiUrl === credentials.apiUrl) return cached.config;
    const config = await client.getConfig();
    this.gatewayCache = { apiUrl: credentials.apiUrl, config };
    return config;
  }

  /**
   * An ssh command to a started sandbox failed: the gateway may have refused its token (revoked
   * outside Xum, or one an earlier run left), Daytona may have moved its gateway or rotated its
   * host keys, or known_hosts was edited. Refetch `/config`, repoint every sandbox's block and
   * the pins at it (pins come from `/config`, never from a key a server offered), and replace
   * this sandbox's token, revoking the old one. Pooled connections opened before keep their old
   * gateway until they close.
   */
  async repairSshAccess(sandboxId: string): Promise<void> {
    const { client, credentials } = await this.account.getClient();
    const config = await client.getConfig();
    this.gatewayCache = { apiUrl: credentials.apiUrl, config };
    await this.sshConfigWriter.repointGateway(toSshGateway(config));
    const cached = this.tokens.get(sandboxId);
    // Due at once, so ensureSshAccess mints, writes, and revokes the old one.
    if (cached) this.tokens.set(sandboxId, { ...cached, expiresAt: new Date(0).toISOString() });
    await this.ensureSshAccess(sandboxId);
  }

  /**
   * A valid token in the include file for this sandbox. The first write in this process also
   * writes known_hosts and the `~/.ssh/config` block; a refresh rewrites only the include file.
   * The `~/.ssh/config` block is checked every time: another tool may have removed it while a
   * cached token stays fresh, and an external editor needs it to resolve the alias.
   */
  async ensureSshAccess(sandboxId: string): Promise<void> {
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
  }

  /** Whether this process holds a token for the sandbox that is close to expiry. */
  hasExpiringSshToken(sandboxId: string): boolean {
    return this.tokens.has(sandboxId) && this.tokenNeedsRefresh(sandboxId);
  }

  /** Revoke the token and remove the sandbox's include block. */
  async releaseSshAccess(sandboxId: string): Promise<void> {
    await this.readiness.waitForSandboxReadiness(sandboxId);
    this.sshConfigured.delete(sandboxId);
    this.readiness.invalidateSandboxReady(sandboxId);
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
    const accountChanges = this.accountChanges;
    const { client } = await this.account.getClient();
    const access = await client.createSshAccess(sandboxId, DAYTONA_SSH_TOKEN_TTL_MINUTES);
    rememberDaytonaToken(access.token);
    await this.announceNewToken(client, sandboxId, access, options);
    // No await between this check and the set: forgetAccount sees the token, or this sees it.
    if (this.accountChanges !== accountChanges) {
      await this.dropOldAccountToken(client, sandboxId, access.token);
    }
    this.tokens.set(sandboxId, access);
    if (previous && previous.token !== access.token) {
      await this.revokeQuietly(client, sandboxId, previous.token);
    }
    return access;
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

  /**
   * A settings save ran forgetAccount during this mint: the token belongs to the account the
   * save left, so remove its alias and revoke it as forgetAccount would have, and fail the
   * caller.
   */
  private async dropOldAccountToken(
    client: DaytonaClient,
    sandboxId: string,
    token: string
  ): Promise<never> {
    await this.removeOldAccountAlias(sandboxId);
    await this.revokeQuietly(client, sandboxId, token);
    throw new Error(`The Daytona settings changed while Xum got ssh access to ${sandboxId}`);
  }

  private async removeOldAccountAlias(sandboxId: string): Promise<void> {
    try {
      await this.sshConfigWriter.removeSandbox(sandboxId);
    } catch (error) {
      log.warn("Failed to remove an old-account Daytona alias from the include file", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
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
