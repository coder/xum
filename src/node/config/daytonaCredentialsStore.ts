import * as fs from "fs/promises";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
import type { DaytonaApiKeySource, DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * Daytona credentials live in their own 0600 file, deliberately outside the other stores:
 * - not providers.jsonc: that is the AI-provider list (Coder sits there only as an AI gateway);
 * - not secrets.json: those secrets are injected into agent turns and terminals, and an agent
 *   must never hold a key that creates and deletes billed sandboxes;
 * - not runtime config or chat history, which are persisted per workspace and shared freely.
 */
export const DAYTONA_CREDENTIALS_FILE = "daytona.json";

export interface DaytonaStoredCredentials {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

/** Credentials ready for a client call. Only node code ever sees `apiKey`. */
export interface DaytonaResolvedCredentials {
  apiKey: string;
  apiKeySource: DaytonaApiKeySource;
  apiUrl: string;
  target?: string;
}

/** Each field: undefined = unchanged, empty (after trim) = cleared. */
export interface DaytonaCredentialsPatch {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Settings input the user must correct; the router reports it as a bad request. */
export class DaytonaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaConfigError";
  }
}

/** An http(s) URL with a host the user wrote. */
function parseApiUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DaytonaConfigError(`Daytona API URL is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DaytonaConfigError("Daytona API URL must use http or https");
  }
  // `new URL` turns "http:///api" and "https:api" into host "api": require a written host.
  if (!/^https?:\/\/[^/?#\\]/i.test(value)) {
    throw new DaytonaConfigError(`Daytona API URL has no host: ${value}`);
  }
  return parsed;
}

function normalizeApiUrl(value: string): string {
  const parsed = parseApiUrl(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DaytonaConfigError(
      "Daytona API URL must not contain credentials, a query or a fragment"
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

const CREDENTIAL_FIELDS = ["apiKey", "apiUrl", "target"] as const;

/** The non-empty string fields of a credentials file, or undefined when it is not an object. */
function parseStoredCredentials(raw: string): DaytonaStoredCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const stored: DaytonaStoredCredentials = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = nonEmpty(record[field]);
    if (value) stored[field] = value;
  }
  return stored;
}

export class DaytonaCredentialsStore {
  readonly filePath: string;
  private readonly rootDir: string;
  private readonly env: NodeJS.ProcessEnv;
  // Serializes read-modify-write updates; writeFileAtomic alone only orders the final writes.
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(rootDir?: string, env: NodeJS.ProcessEnv = process.env) {
    this.rootDir = rootDir ?? getXumHome();
    this.filePath = path.join(this.rootDir, DAYTONA_CREDENTIALS_FILE);
    this.env = env;
  }

  /** A missing or malformed file reads as empty (self-healing): the user can re-enter the key. */
  async read(): Promise<DaytonaStoredCredentials> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        log.warn("Failed to read Daytona credentials file", {
          filePath: this.filePath,
          error: getErrorMessage(error),
        });
      }
      return {};
    }
    const stored = parseStoredCredentials(raw);
    if (!stored) {
      // Never log the content: it holds the API key.
      log.warn("Ignoring malformed Daytona credentials file", { filePath: this.filePath });
      return {};
    }
    return stored;
  }

  update(patch: DaytonaCredentialsPatch): Promise<void> {
    const run = this.updateChain.then(() => this.applyUpdate(patch));
    // The caller gets the rejection through `run`; the chain only needs to keep going.
    this.updateChain = run.catch((error: unknown) => {
      log.debug("Daytona credentials update failed", { error: getErrorMessage(error) });
    });
    return run;
  }

  private async applyUpdate(patch: DaytonaCredentialsPatch): Promise<void> {
    const next = await this.read();
    for (const field of CREDENTIAL_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      const trimmed = nonEmpty(value);
      if (trimmed === undefined) {
        delete next[field];
      } else {
        next[field] = field === "apiUrl" ? normalizeApiUrl(trimmed) : trimmed;
      }
    }
    await ensurePrivateDir(this.rootDir);
    await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  /**
   * Settings win over the Xum server's own environment (DAYTONA_API_KEY / DAYTONA_API_URL), so a
   * key entered in the UI is the one used. Returns null when no API key is available.
   */
  async resolve(): Promise<DaytonaResolvedCredentials | null> {
    const stored = await this.read();
    const envKey = nonEmpty(this.env.DAYTONA_API_KEY);
    const apiKey = stored.apiKey ?? envKey;
    if (!apiKey) return null;
    return {
      apiKey,
      apiKeySource: stored.apiKey ? "settings" : "env",
      apiUrl: this.resolveApiUrl(stored),
      ...(stored.target ? { target: stored.target } : {}),
    };
  }

  /** What the UI may see: whether a key is set and where from, never the key. */
  async getPublicConfig(): Promise<DaytonaPublicConfig> {
    const stored = await this.read();
    const envKeySet = nonEmpty(this.env.DAYTONA_API_KEY) !== undefined;
    return {
      apiKeySet: stored.apiKey !== undefined || envKeySet,
      apiKeySource: stored.apiKey ? "settings" : envKeySet ? "env" : null,
      apiUrl: this.resolveApiUrl(stored),
      target: stored.target ?? null,
    };
  }

  private resolveApiUrl(stored: DaytonaStoredCredentials): string {
    if (stored.apiUrl) return stored.apiUrl;
    const envUrl = nonEmpty(this.env.DAYTONA_API_URL);
    if (envUrl) {
      try {
        return normalizeApiUrl(envUrl);
      } catch (error) {
        log.warn("Ignoring invalid DAYTONA_API_URL", { error: getErrorMessage(error) });
      }
    }
    return DAYTONA_DEFAULT_API_URL;
  }
}
