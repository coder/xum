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
  // Every authenticated call sends the API key as a bearer token: over plain http anyone on
  // the network path could read it. Only a loopback host keeps it on this machine.
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new DaytonaConfigError(
      "Daytona API URL must use https (http is accepted only for localhost and 127.0.0.1)"
    );
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

/** Why a stored API URL cannot be used; undefined when it is unset or valid. */
function storedApiUrlProblem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    normalizeApiUrl(value);
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}

function validApiUrl(value: string | undefined, source: string): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeApiUrl(value);
  } catch (error) {
    log.warn(`Ignoring invalid ${source}`, { error: getErrorMessage(error) });
    return undefined;
  }
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
  if (!isPlainObject(parsed)) return undefined;
  const stored: DaytonaStoredCredentials = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = nonEmpty(parsed[field]);
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
    // A saved URL names the deployment the key belongs to (an http one saved before http was
    // refused, or a hand edit): falling back to DAYTONA_API_URL or the default would send the
    // key elsewhere, so Daytona stays unusable until the user fixes or clears it.
    const storedProblem = storedApiUrlProblem(stored.apiUrl);
    if (storedProblem) {
      throw new DaytonaConfigError(
        `The Daytona API URL saved in Settings cannot be used (${storedProblem}); ` +
          "fix or clear it in Settings > Runtimes"
      );
    }
    // The environment names the deployment to use: falling back to the default one would send
    // the key to a deployment the operator did not pick, so it stays unusable until fixed.
    if (this.insecureEnvApiUrl(stored)) {
      throw new DaytonaConfigError(
        "DAYTONA_API_URL must use https (http is accepted only for localhost and 127.0.0.1); " +
          "fix it, or set the API URL in Settings > Runtimes"
      );
    }
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

  /**
   * A saved URL wins, shown as written when it does not validate so the user can fix it (resolve
   * refuses it). An env URL that does not validate is ignored (self-healing), as if unset, except
   * one that only fails for plain http: that one is shown, and resolve refuses it.
   */
  private resolveApiUrl(stored: DaytonaStoredCredentials): string {
    if (stored.apiUrl) {
      return storedApiUrlProblem(stored.apiUrl) ? stored.apiUrl : normalizeApiUrl(stored.apiUrl);
    }
    return (
      this.insecureEnvApiUrl(stored) ??
      validApiUrl(nonEmpty(this.env.DAYTONA_API_URL), "DAYTONA_API_URL") ??
      DAYTONA_DEFAULT_API_URL
    );
  }

  /** DAYTONA_API_URL when it would be used and is http to a host that is not loopback. */
  private insecureEnvApiUrl(stored: DaytonaStoredCredentials): string | undefined {
    const envUrl = nonEmpty(this.env.DAYTONA_API_URL);
    if (!envUrl || stored.apiUrl) return undefined;
    const parsed = URL.canParse(envUrl) ? new URL(envUrl) : undefined;
    return parsed?.protocol === "http:" && !isLoopbackHost(parsed.hostname) ? envUrl : undefined;
  }
}
