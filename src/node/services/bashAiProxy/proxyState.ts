/**
 * Persisted bash AI proxy state in `<XUM_ROOT>/bash-ai-proxy.json` (mode 0600):
 * - `secret`: signs the workspace keys (stableIdentity.ts), so keys survive a restart.
 * - `port`: the listener port that commands already have in their env. A restart binds it again
 *   first, so background processes keep working.
 *
 * A missing or malformed file self-heals: each field is checked on its own, so a bad port is
 * dropped and a good secret (and every key signed with it) stays. Only a bad secret rotates the
 * keys.
 *
 * Every read-modify-write holds a cross-process lock and starts from the file, not from a cached
 * copy, so backends that share a root (XUM_ALLOW_MULTIPLE_INSTANCES) never overwrite each
 * other's changes and all adopt the same secret.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { log } from "@/node/services/log";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

export const BASH_AI_PROXY_STATE_FILE = "bash-ai-proxy.json";

const ProxyStateSchema = z.object({
  version: z.literal(1),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  port: z.number().int().min(1).max(65535).optional(),
});

export type ProxyState = z.infer<typeof ProxyStateSchema>;

export class ProxyStateStore {
  private readonly file: string;
  private cached: ProxyState | undefined;
  // One writer at a time inside this process; the lock covers the other processes.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    assert(rootDir.length > 0, "ProxyStateStore requires a rootDir");
    this.file = path.join(rootDir, BASH_AI_PROXY_STATE_FILE);
  }

  /** The state, created or repaired on first use. Later calls return the same snapshot. */
  load(): Promise<ProxyState> {
    return this.serialize(async () => {
      this.cached ??= await this.locked(() => this.readOrRepair());
      return this.cached;
    });
  }

  /**
   * Applies `mutate` to the state on disk (read under the lock) and writes it. Errors are
   * logged, never thrown.
   */
  update(mutate: (state: ProxyState) => void): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.locked(async () => {
          const state = await this.readOrRepair();
          mutate(state);
          await this.write(state);
        });
      } catch (error) {
        log.warn("[bash-ai-proxy] could not save proxy state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Saves `port` unless the file already has one. Two backends on one root can start together
   * with no saved port and bind different ports: only the first one becomes durable, so a
   * restart binds the port that commands already hold.
   */
  async claimPort(port: number): Promise<void> {
    await this.update((state) => {
      state.port ??= port;
    });
  }

  /** Resolves when every queued write has finished. */
  async flush(): Promise<void> {
    await this.chain;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const release = await acquireCrossProcessLock({
      lockPath: `${this.file}.lock`,
      acquireTimeoutMs: 10_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is updating the bash AI proxy state.",
    });
    await using _lock = { [Symbol.asyncDispose]: release };
    return await fn();
  }

  /** Reads the state, writing a repaired one when the file is missing or partly invalid. */
  private async readOrRepair(): Promise<ProxyState> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      // Only a missing file or bad JSON is repaired. Any other read error (EIO, a sharing
      // violation) propagates: replacing a file we could not read would rotate every key.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing && !(error instanceof SyntaxError)) throw error;
      raw = undefined;
    }
    const state = parseState(raw);
    if (state.repaired) {
      if (raw !== undefined) {
        log.warn("[bash-ai-proxy] repairing the proxy state file", {
          keysKept: state.value.secret === readSecret(raw),
        });
      }
      await this.write(state.value);
    }
    return state.value;
  }

  // Durable (fsyncs the file and its directory): commands get keys signed with this secret, so
  // a power loss must not bring back an older file with another secret.
  private async write(state: ProxyState): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

function readSecret(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null ? (raw as { secret?: unknown }).secret : undefined;
}

/**
 * Checks each field on its own: a valid field survives an invalid neighbor. A state without a
 * valid secret gets a new one.
 */
function parseState(raw: unknown): { value: ProxyState; repaired: boolean } {
  const fields = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const secret = ProxyStateSchema.shape.secret.safeParse(fields.secret);
  const port = ProxyStateSchema.shape.port.safeParse(fields.port);
  const value: ProxyState = {
    version: 1,
    secret: secret.success ? secret.data : randomBytes(32).toString("hex"),
    ...(port.success && port.data !== undefined ? { port: port.data } : {}),
  };
  const repaired = fields.version !== 1 || !secret.success || !port.success;
  return { value, repaired };
}
