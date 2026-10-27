import { getErrorMessage } from "@/common/utils/errors";
import type { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { rememberDaytonaToken } from "@/node/runtime/daytonaTokenRedaction";
import { log } from "@/node/services/log";
import type { DaytonaAccount } from "./daytonaAccount";
import type { DaytonaClient, DaytonaGatewayConfig, DaytonaSshAccess } from "./daytonaClient";
import type { DaytonaReadiness } from "./daytonaReadiness";
import { requireSandboxId, type DaytonaSandboxIds } from "./daytonaSandboxIds";

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
  ids: Pick<DaytonaSandboxIds, "get">;
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
 * the first one's back. Keyed by sandbox name (the alias); tokens are minted and revoked for the
 * recorded id.
 */
export class DaytonaSsh {
  private readonly account: DaytonaSshOptions["account"];
  private readonly readiness: DaytonaReadiness;
  private readonly ids: DaytonaSshOptions["ids"];
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
    this.ids = options.ids;
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
    let entries: Array<{ sandboxName: string; token: string }>;
    try {
      entries = await this.sshConfigWriter.readTokens();
    } catch (error) {
      log.warn("Could not read the Daytona ssh tokens in the include file", {
        error: getErrorMessage(error),
      });
      throw error;
    }
    for (const { sandboxName, token } of entries) {
      rememberDaytonaToken(token);
      // An earlier run's tokens: holding them lets a replacement, a settings change or an
      // archive revoke them. The file has no expiry, so they are due for refresh at once.
      if (!this.persistedTokensLoaded && !this.tokens.has(sandboxName)) {
        this.tokens.set(sandboxName, { token, expiresAt: new Date(0).toISOString() });
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
    for (const [sandboxName] of tokens) await this.removeOldAccountAlias(sandboxName);
    if (previousClient) {
      await Promise.all(
        tokens.map(([sandboxName, access]) =>
          this.revokeQuietly(previousClient, sandboxName, access.token)
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
  async repairSshAccess(sandboxName: string): Promise<void> {
    const { client, credentials } = await this.account.getClient();
    const config = await client.getConfig();
    this.gatewayCache = { apiUrl: credentials.apiUrl, config };
    await this.sshConfigWriter.repointGateway(toSshGateway(config));
    const cached = this.tokens.get(sandboxName);
    // Due at once, so ensureSshAccess mints, writes, and revokes the old one.
    if (cached) this.tokens.set(sandboxName, { ...cached, expiresAt: new Date(0).toISOString() });
    await this.ensureSshAccess(sandboxName);
  }

  /**
   * A valid token in the include file for this sandbox. The first write in this process also
   * writes known_hosts and the `~/.ssh/config` block; a refresh rewrites only the include file.
   * The `~/.ssh/config` block is checked every time: another tool may have removed it while a
   * cached token stays fresh, and an external editor needs it to resolve the alias.
   */
  async ensureSshAccess(sandboxName: string): Promise<void> {
    // Fails before a mint when the control plane cannot say where the gateway is.
    await this.getGatewayConfig();
    // A cached token was written by the mint that produced it, so only a mint writes files.
    await this.getSshToken(sandboxName, {
      onNewToken: async ({ token }) => {
        const gateway = toSshGateway(await this.getGatewayConfig());
        if (this.sshConfigured.has(sandboxName)) {
          await this.sshConfigWriter.updateToken({ sandboxName, token, gateway });
          return;
        }
        await this.sshConfigWriter.writeSandbox({ sandboxName, token, gateway });
      },
    });
    await this.sshConfigWriter.ensureManagedBlock();
    this.sshConfigured.add(sandboxName);
  }

  /** Revoke the token and remove the sandbox's include block. */
  async releaseSshAccess(sandboxName: string): Promise<void> {
    await this.readiness.waitForSandboxReadiness(sandboxName);
    this.sshConfigured.delete(sandboxName);
    this.readiness.invalidateSandboxReady(sandboxName);
    await this.forgetSshToken(sandboxName);
    await this.sshConfigWriter.removeSandbox(sandboxName);
  }

  private tokenNeedsRefresh(sandboxName: string): boolean {
    const cached = this.tokens.get(sandboxName);
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
    sandboxName: string,
    options: DaytonaSshTokenOptions = {}
  ): Promise<DaytonaSshAccess> {
    const cached = this.tokens.get(sandboxName);
    if (cached && !this.tokenNeedsRefresh(sandboxName)) return cached;
    const inFlight = this.tokenRequests.get(sandboxName);
    if (inFlight) return inFlight;

    const request = this.mintSshToken(sandboxName, cached, options).finally(() => {
      this.tokenRequests.delete(sandboxName);
    });
    this.tokenRequests.set(sandboxName, request);
    return request;
  }

  private async mintSshToken(
    sandboxName: string,
    previous: DaytonaSshAccess | undefined,
    options: DaytonaSshTokenOptions
  ): Promise<DaytonaSshAccess> {
    const accountChanges = this.accountChanges;
    const sandboxId = requireSandboxId(this.ids, sandboxName);
    const { client } = await this.account.getClient();
    const access = await client.createSshAccess(sandboxId, DAYTONA_SSH_TOKEN_TTL_MINUTES);
    rememberDaytonaToken(access.token);
    await this.announceNewToken(client, sandboxName, access, options);
    // No await between this check and the set: forgetAccount sees the token, or this sees it.
    if (this.accountChanges !== accountChanges) {
      await this.dropOldAccountToken(client, sandboxName, access.token);
    }
    this.tokens.set(sandboxName, access);
    if (previous && previous.token !== access.token) {
      await this.revokeQuietly(client, sandboxName, previous.token);
    }
    return access;
  }

  private async announceNewToken(
    client: DaytonaClient,
    sandboxName: string,
    access: DaytonaSshAccess,
    options: DaytonaSshTokenOptions
  ): Promise<void> {
    try {
      await options.onNewToken?.(access);
    } catch (error) {
      // Nothing holds the new token any more: revoke it rather than leave it live.
      await this.revokeQuietly(client, sandboxName, access.token);
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
    sandboxName: string,
    token: string
  ): Promise<never> {
    await this.removeOldAccountAlias(sandboxName);
    await this.revokeQuietly(client, sandboxName, token);
    throw new Error(`The Daytona settings changed while Xum got ssh access to ${sandboxName}`);
  }

  private async removeOldAccountAlias(sandboxName: string): Promise<void> {
    try {
      await this.sshConfigWriter.removeSandbox(sandboxName);
    } catch (error) {
      log.warn("Failed to remove an old-account Daytona alias from the include file", {
        sandboxName,
        error: getErrorMessage(error),
      });
    }
  }

  /** Revoke and forget the cached token (workspace deleted or sandbox detached). */
  async forgetSshToken(sandboxName: string): Promise<void> {
    const cached = this.tokens.get(sandboxName);
    this.tokens.delete(sandboxName);
    if (!cached) return;
    const { client } = await this.account.getClient();
    await this.revokeQuietly(client, sandboxName, cached.token);
  }

  /** Without a recorded id there is no sandbox to ask: the token expires on its own. */
  private async revokeQuietly(
    client: DaytonaClient,
    sandboxName: string,
    token: string
  ): Promise<void> {
    const sandboxId = this.ids.get(sandboxName);
    if (!sandboxId) return;
    try {
      await client.revokeSshAccess(sandboxId, token);
    } catch (error) {
      // Never log the token itself.
      log.warn("Failed to revoke a Daytona SSH token; it expires on its own", {
        sandboxName,
        error: getErrorMessage(error),
      });
    }
  }
}
