import * as fs from "fs/promises";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
import type { DaytonaApiKeySource, DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isLoopbackHost } from "@/common/utils/loopbackHost";
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
}

/** Credentials ready for a client call. Only node code ever sees `apiKey`. */
export interface DaytonaResolvedCredentials {
  apiKey: string;
  apiKeySource: DaytonaApiKeySource;
  apiUrl: string;
  target?: string;
}

/** undefined = unchanged, empty (after trim) = cleared. */
export interface DaytonaCredentialsPatch {
  apiKey?: string;
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
    throw new DaytonaConfigError(`DAYTONA_API_URL is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DaytonaConfigError("DAYTONA_API_URL must use http or https");
  }
  // `new URL` turns "http:///api" and "https:api" into host "api": require a written host.
  if (!/^https?:\/\/[^/?#\\]/i.test(value)) {
    throw new DaytonaConfigError(`DAYTONA_API_URL has no host: ${value}`);
  }
  // Every authenticated call sends the API key as a bearer token: over plain http anyone on
  // the network path could read it. Only a loopback host keeps it on this machine.
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new DaytonaConfigError(
      "DAYTONA_API_URL must use https (http is accepted only for localhost and 127.0.0.1)"
    );
  }
  return parsed;
}

function normalizeApiUrl(value: string): string {
  const parsed = parseApiUrl(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DaytonaConfigError(
      "DAYTONA_API_URL must not contain credentials, a query or a fragment"
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** The saved key, or undefined when the file does not hold one. */
function parseStoredKey(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? nonEmpty(parsed.apiKey) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Only the API key is saved here. The deployment URL and the default target (region) come from
 * the Xum server's environment (DAYTONA_API_URL, DAYTONA_TARGET).
 */
export class DaytonaCredentialsStore {
  readonly filePath: string;
  private readonly rootDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(rootDir?: string, env: NodeJS.ProcessEnv = process.env) {
    this.rootDir = rootDir ?? getXumHome();
    this.filePath = path.join(this.rootDir, DAYTONA_CREDENTIALS_FILE);
    this.env = env;
  }

  /** A missing, unreadable or malformed file reads as empty (self-healing): the user can re-enter the key. */
  async read(): Promise<DaytonaStoredCredentials> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        log.warn("Could not read the Daytona credentials file", {
          filePath: this.filePath,
          error: getErrorMessage(error),
        });
      }
      return {};
    }
    const apiKey = parseStoredKey(raw);
    return apiKey ? { apiKey } : {};
  }

  async update(patch: DaytonaCredentialsPatch): Promise<void> {
    if (patch.apiKey === undefined) return;
    const apiKey = nonEmpty(patch.apiKey);
    await ensurePrivateDir(this.rootDir);
    await writeFileAtomic(this.filePath, JSON.stringify(apiKey ? { apiKey } : {}, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  /**
   * A key saved in Settings wins over DAYTONA_API_KEY, so a key entered in the UI is the one
   * used. Returns null when no API key is available. An invalid DAYTONA_API_URL throws instead of
   * falling back to the default, which would send the key to another deployment.
   */
  async resolve(): Promise<DaytonaResolvedCredentials | null> {
    const stored = await this.read();
    const apiKey = stored.apiKey ?? nonEmpty(this.env.DAYTONA_API_KEY);
    if (!apiKey) return null;
    const envUrl = nonEmpty(this.env.DAYTONA_API_URL);
    const target = nonEmpty(this.env.DAYTONA_TARGET);
    return {
      apiKey,
      apiKeySource: stored.apiKey ? "settings" : "env",
      apiUrl: envUrl ? normalizeApiUrl(envUrl) : DAYTONA_DEFAULT_API_URL,
      ...(target ? { target } : {}),
    };
  }

  /** What the UI may see: whether a key is set and where from, never the key. */
  async getPublicConfig(): Promise<DaytonaPublicConfig> {
    const stored = await this.read();
    const envKeySet = nonEmpty(this.env.DAYTONA_API_KEY) !== undefined;
    return {
      apiKeySet: stored.apiKey !== undefined || envKeySet,
      apiKeySource: stored.apiKey ? "settings" : envKeySet ? "env" : null,
    };
  }
}
