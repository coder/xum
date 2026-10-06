/**
 * Persisted bash AI proxy state in `<XUM_ROOT>/bash-ai-proxy.json` (mode 0600):
 * - `secret`: signs the workspace keys (stableIdentity.ts), so keys survive a restart.
 * - `port`: the listener port that commands already have in their env. A restart binds it again
 *   first, so background processes keep working.
 *
 * A missing or malformed file self-heals to a fresh state. That only rotates the keys and ports.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { log } from "@/node/services/log";

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
  // One writer at a time inside this process; the file itself is replaced atomically.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    assert(rootDir.length > 0, "ProxyStateStore requires a rootDir");
    this.file = path.join(rootDir, BASH_AI_PROXY_STATE_FILE);
  }

  load(): Promise<ProxyState> {
    return this.serialize(async () => {
      this.cached ??= await this.readOrCreate();
      return this.cached;
    });
  }

  /** Applies `mutate` to the current state and writes it. Errors are logged, never thrown. */
  update(mutate: (state: ProxyState) => void): Promise<void> {
    return this.serialize(async () => {
      const state = (this.cached ??= await this.readOrCreate());
      mutate(state);
      try {
        await this.write(state, "replace");
      } catch (error) {
        log.warn("[bash-ai-proxy] could not save proxy state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

  private async readOrCreate(): Promise<ProxyState> {
    const existing = await this.read();
    if (existing) return existing;
    const fresh: ProxyState = {
      version: 1,
      secret: randomBytes(32).toString("hex"),
    };
    try {
      // `wx`: a second backend on the same root that wins the race keeps its secret.
      await this.write(fresh, "create");
      return fresh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const raced = await this.read();
    if (raced) return raced;
    log.warn(
      "[bash-ai-proxy] replacing an unreadable proxy state file; old bash keys stop working"
    );
    await this.write(fresh, "replace");
    return fresh;
  }

  private async read(): Promise<ProxyState | undefined> {
    try {
      const parsed = ProxyStateSchema.safeParse(JSON.parse(await fs.readFile(this.file, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(state: ProxyState, mode: "create" | "replace"): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(state, null, 2);
    if (mode === "create") {
      await fs.writeFile(this.file, text, { mode: 0o600, flag: "wx" });
      return;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
