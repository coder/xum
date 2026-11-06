import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { answersAsXumBackend } from "./xumBackendProbe";

export const ServerLockDataSchema = z.object({
  pid: z.number(),
  /** Base URL for HTTP API (e.g., "http://localhost:3000" or "https://my.box.com/mux") */
  baseUrl: z.url(),
  token: z.string(),
  startedAt: z.string(),
  /** Bind host/interface the server is listening on (e.g. "127.0.0.1" or "0.0.0.0") */
  bindHost: z.string().optional(),
  /** The port the server is listening on */
  port: z.number().int().min(0).max(65535).optional(),
  /** Additional base URLs that are reachable from other devices (LAN/VPN) */
  networkBaseUrls: z.array(z.url()).optional(),
});

export type ServerLockData = z.infer<typeof ServerLockDataSchema>;

/**
 * The locks this process wrote and has not released: lock path -> the `startedAt` it wrote.
 * A lock that names this process's own pid is live only if it is in here. Otherwise an earlier
 * process wrote it and the OS gave its pid to this one (every run of a container is pid 1), and
 * no HTTP answer can tell the two apart, because this process answers for itself.
 */
const ownedLocks = new Map<string, string>();

/**
 * Manages the server lockfile at ~/.xum/server.lock
 *
 * The lockfile enables CLI tools to discover a running xum server
 * (either Electron app or standalone xum server) and connect to it.
 */
export class ServerLockfile {
  private readonly lockPath: string;

  constructor(xumHome: string) {
    this.lockPath = path.join(xumHome, "server.lock");
  }

  /**
   * Acquire the lockfile with the given baseUrl and token.
   * Writes atomically with 0600 permissions (owner read/write only).
   */
  async acquire(
    baseUrl: string,
    token: string,
    extra?: {
      bindHost?: string;
      port?: number;
      networkBaseUrls?: string[];
    }
  ): Promise<void> {
    const bindHost = extra?.bindHost?.trim() ? extra.bindHost.trim() : undefined;
    const port =
      typeof extra?.port === "number" &&
      Number.isInteger(extra.port) &&
      extra.port >= 0 &&
      extra.port <= 65535
        ? extra.port
        : undefined;

    const data: ServerLockData = {
      pid: process.pid,
      baseUrl,
      token,
      startedAt: new Date().toISOString(),
      bindHost,
      port,
      networkBaseUrls: extra?.networkBaseUrls?.length ? extra.networkBaseUrls : undefined,
    };

    // Ensure directory exists
    const dir = path.dirname(this.lockPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }

    // Write atomically by writing to temp file then renaming
    const tempPath = `${this.lockPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
      mode: 0o600, // Owner read/write only
    });
    await fs.rename(tempPath, this.lockPath);
    ownedLocks.set(this.lockPath, data.startedAt);
  }

  /**
   * Read the lockfile and validate it.
   * Returns null if the lockfile doesn't exist or is stale: its pid is dead, or the pid is alive
   * but no xum backend runs at the lock's baseUrl (see peek()).
   *
   * A reader never deletes a stale lock. Unlinking it by path after the pid check would also
   * delete the lock of a backend that started in between (acquire() renames its lock into place),
   * and nothing writes that lock again before the next restart, so the CLI and every other
   * reader would find no running backend. The next acquire() replaces a stale lock with an
   * atomic rename, and its owner's release() removes it.
   */
  async read(): Promise<ServerLockData | null> {
    return this.peek();
  }

  /**
   * Read a live lockfile without ever deleting it.
   * Same as read() now that read() never deletes either. #4854 added it for on-demand discovery
   * (the desktop "Open Server Window" action), which must not race a starting xum server that is
   * replacing a stale lock, and its callers keep the name.
   *
   * A lock is live only if its pid is alive and it is the lock of a running backend:
   * - A lock with this process's own pid is live only if this process acquired it (ownedLocks).
   * - Any other lock is live only if a xum backend answers at its baseUrl. The OS reuses pids, so
   *   a live pid alone does not make a lock live, and a reader that trusted it would refuse to
   *   start next to a backend that is gone, or send the lock's token to whatever listens on its
   *   port now. The probe carries no token (see answersAsXumBackend).
   */
  async peek(): Promise<ServerLockData | null> {
    const data = await this.readData();
    if (data == null || !this.isProcessAlive(data.pid)) return null;
    if (data.pid === process.pid) {
      return ownedLocks.get(this.lockPath) === data.startedAt ? data : null;
    }
    return (await answersAsXumBackend(data.baseUrl)) ? data : null;
  }

  private async readData(): Promise<ServerLockData | null> {
    try {
      const content = await fs.readFile(this.lockPath, "utf-8");
      return ServerLockDataSchema.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }

  /**
   * Release the lock this process acquired. Another backend's lock is never deleted: a backend
   * that a starter judged stale (it did not answer in time) has had its lock replaced by the
   * starter's acquire(), and deleting that lock would leave the running backend undiscoverable.
   *
   * No unlink can test who owns the file it removes, so this renames the lock out of the way
   * first, then reads whose it was. A lock that was not ours goes back, unless an even newer one
   * was written meanwhile (link() fails on an existing path).
   */
  async release(): Promise<void> {
    const startedAt = ownedLocks.get(this.lockPath);
    ownedLocks.delete(this.lockPath);
    if (startedAt == null) return;
    const aside = `${this.lockPath}.${process.pid}.release`;
    try {
      await fs.rename(this.lockPath, aside);
    } catch {
      return; // no lock there (or none we can move): nothing of ours to delete
    }
    try {
      const taken = ServerLockDataSchema.parse(JSON.parse(await fs.readFile(aside, "utf-8")));
      if (taken.pid !== process.pid || taken.startedAt !== startedAt) {
        await fs.link(aside, this.lockPath);
      }
    } catch {
      // Unreadable, or a newer lock took the path: ours is gone either way.
    } finally {
      await fs.unlink(aside).catch(() => undefined);
    }
  }

  /**
   * Check if a process with the given PID is still running.
   * Uses signal 0 which tests existence without actually sending a signal.
   *
   * This cannot tell the server from an unrelated process that reused its pid, so peek() also
   * asks the lock's baseUrl.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the path to the lockfile (for testing/debugging).
   */
  getLockPath(): string {
    return this.lockPath;
  }
}
