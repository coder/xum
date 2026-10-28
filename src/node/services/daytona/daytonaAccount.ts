import { AsyncLocalStorage } from "async_hooks";
import type {
  DaytonaListSnapshotsResult,
  DaytonaPublicConfig,
  DaytonaTestConnectionResult,
} from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DaytonaConfigError,
  type DaytonaCredentialsPatch,
  type DaytonaCredentialsStore,
  type DaytonaResolvedCredentials,
} from "@/node/config/daytonaCredentialsStore";
import { log } from "@/node/services/log";
import {
  DaytonaApiError,
  DaytonaClient,
  isDaytonaNotFound,
  type DaytonaSnapshot,
} from "./daytonaClient";

/**
 * Sandboxes (and the snapshots that create them) Xum never offers or creates:
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

export type DaytonaAvailability = { available: true } | { available: false; reason: string };

export interface DaytonaAccountOptions {
  credentialsStore: DaytonaCredentialsStore;
  fetch?: typeof fetch;
  /**
   * Runs once a settings save is stored, with a client for the previous settings (if they
   * were usable), so the token and sandbox caches of the old account can be dropped.
   */
  onSettingsChange: (previousClient: DaytonaClient | undefined) => Promise<void>;
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

interface DaytonaAccountClient {
  client: DaytonaClient;
  credentials: DaytonaResolvedCredentials;
}

/** The Daytona settings, the API client they make, and the calls that need no sandbox. */
export class DaytonaAccount {
  private readonly credentialsStore: DaytonaCredentialsStore;
  private readonly fetchImpl?: typeof fetch;
  private readonly onSettingsChange: DaytonaAccountOptions["onSettingsChange"];
  private readonly pinnedClient = new AsyncLocalStorage<{
    client?: Promise<DaytonaAccountClient>;
  }>();

  constructor(options: DaytonaAccountOptions) {
    this.credentialsStore = options.credentialsStore;
    this.fetchImpl = options.fetch;
    this.onSettingsChange = options.onSettingsChange;
  }

  getPublicConfig(): Promise<DaytonaPublicConfig> {
    return this.credentialsStore.getPublicConfig();
  }

  async setConfig(patch: DaytonaCredentialsPatch): Promise<DaytonaPublicConfig> {
    const previousClient = await this.getClientIfConfigured();
    await this.credentialsStore.update(patch);
    await this.onSettingsChange(previousClient);
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

  /** Unusable settings (an http DAYTONA_API_URL) throw a `not_configured` DaytonaApiError. */
  private async resolveCredentials(): Promise<DaytonaResolvedCredentials | null> {
    try {
      return await this.credentialsStore.resolve();
    } catch (error) {
      if (error instanceof DaytonaConfigError) {
        throw new DaytonaApiError("not_configured", error.message);
      }
      throw error;
    }
  }

  /**
   * Runs `operation` with every getClient() inside it on the account in effect at its first
   * call, so a settings save cannot split a setup across two accounts (a create in the old
   * one, its readiness check and cleanup in the new one, leaking the sandbox).
   */
  withPinnedAccount<T>(operation: () => Promise<T>): Promise<T> {
    return this.pinnedClient.run({}, operation);
  }

  /**
   * Whether a settings save stored another account (API URL or key) after the pinned
   * operation took its own. That save has already dropped the old account's ssh access, so
   * what the operation made since then would outlive it.
   */
  async pinnedAccountChanged(): Promise<boolean> {
    const pinned = this.pinnedClient.getStore()?.client;
    if (!pinned) return false;
    const { credentials } = await pinned;
    const current = await this.resolveCredentials();
    return current?.apiUrl !== credentials.apiUrl || current.apiKey !== credentials.apiKey;
  }

  /** Throws a `not_configured` DaytonaApiError when no API key is set. */
  getClient(): Promise<DaytonaAccountClient> {
    const pin = this.pinnedClient.getStore();
    if (!pin) return this.createClient();
    pin.client ??= this.createClient();
    return pin.client;
  }

  private async createClient(): Promise<DaytonaAccountClient> {
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

  /** The default target (region) from DAYTONA_TARGET, if one is set. */
  async getDefaultTarget(): Promise<string | undefined> {
    return (await this.resolveCredentials())?.target;
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

  async listSnapshots(): Promise<DaytonaListSnapshotsResult> {
    try {
      const { client } = await this.getClient();
      const snapshots = await client.listSnapshots();
      return {
        ok: true,
        snapshots: snapshots
          .filter((s) => !unsupportedDaytonaSandboxKind(s))
          .map(({ name }) => ({ name })),
      };
    } catch (error) {
      return toResultError(error);
    }
  }

  /**
   * The snapshot named `name`, with the unsupported kind of sandbox it creates (if any); undefined when
   * Daytona has none by that name. The list is the fallback for one the lookup does not find
   * by name (it serves the snapshot picker).
   */
  async findSnapshot(
    name: string
  ): Promise<{ unsupported?: UnsupportedDaytonaSandboxKind } | undefined> {
    const { client } = await this.getClient();
    let snapshot: DaytonaSnapshot | undefined;
    try {
      snapshot = await client.getSnapshot(name);
    } catch (error) {
      if (!isDaytonaNotFound(error)) throw error;
      snapshot = (await client.listSnapshots()).find((listed) => listed.name === name);
    }
    return snapshot && { unsupported: unsupportedDaytonaSandboxKind(snapshot) };
  }
}
