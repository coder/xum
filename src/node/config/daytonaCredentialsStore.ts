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
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
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

/** Why an API URL cannot be used; undefined when it is unset or valid. */
function apiUrlProblem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    normalizeApiUrl(value);
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
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

/** `stored` with the patch's fields set; an empty string clears a field. */
function applyPatch(
  stored: DaytonaStoredCredentials,
  patch: DaytonaCredentialsPatch
): DaytonaStoredCredentials {
  const next = { ...stored };
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
  return next;
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

  /**
   * A missing or malformed file reads as empty (self-healing): the user can re-enter the key.
   * A read that fails for another reason (an I/O error, a permission problem) throws, for every
   * caller: an update writes the whole file back, and a resolve that took it as empty would
   * fall back to DAYTONA_API_KEY, another account than the one the saved settings select.
   */
  async read(): Promise<DaytonaStoredCredentials> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return {};
      throw new Error(
        `Could not read the Daytona settings in ${this.filePath}: ${getErrorMessage(error)}`,
        { cause: error }
      );
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

  /**
   * Another backend on this Xum root (a desktop app next to `xum server`) has its own
   * updateChain: the file lock spans the whole read-modify-write, or one backend's save of the
   * key could be overwritten by the other's save of the URL, pairing the old key with the new
   * deployment.
   */
  private async applyUpdate(patch: DaytonaCredentialsPatch): Promise<void> {
    await ensurePrivateDir(this.rootDir);
    const release = await acquireCrossProcessLock({
      lockPath: `${this.filePath}.lock`,
      acquireTimeoutMs: 30_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is saving Daytona settings.",
    });
    try {
      const next = applyPatch(await this.read(), patch);
      await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } finally {
      await release();
    }
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
    // The URL in use (saved, else DAYTONA_API_URL) names the deployment the key belongs to: an
    // invalid one (an http URL saved before http was refused, a hand edit, a typo in the env)
    // must not fall back to another URL or the default, which would send the key elsewhere.
    // So Daytona stays unusable until the user fixes it.
    const { source, value } = this.configuredApiUrl(stored);
    const problem = apiUrlProblem(value);
    if (problem) {
      throw new DaytonaConfigError(
        source === "settings"
          ? `The Daytona API URL saved in Settings cannot be used (${problem}); ` +
              "fix or clear it in Settings > Runtimes"
          : `DAYTONA_API_URL cannot be used (${problem}); ` +
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

  /** The saved URL wins over DAYTONA_API_URL; neither set means Daytona's default. */
  private configuredApiUrl(stored: DaytonaStoredCredentials): {
    source: "settings" | "env" | "default";
    value?: string;
  } {
    if (stored.apiUrl) return { source: "settings", value: stored.apiUrl };
    const envUrl = nonEmpty(this.env.DAYTONA_API_URL);
    return envUrl ? { source: "env", value: envUrl } : { source: "default" };
  }

  /** An invalid URL is shown as written, so the user sees what to fix (resolve refuses it). */
  private resolveApiUrl(stored: DaytonaStoredCredentials): string {
    const { value } = this.configuredApiUrl(stored);
    if (!value) return DAYTONA_DEFAULT_API_URL;
    return apiUrlProblem(value) ? value : normalizeApiUrl(value);
  }
}
