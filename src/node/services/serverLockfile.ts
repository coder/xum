import { constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  getSelfIdentity,
  judgeHolder,
  parseProcessIdentity,
} from "../utils/concurrency/processLiveness";
import { probeXumBackend } from "./xumBackendProbe";

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
  /**
   * The backend's process identity (ProcessIdentity: pid start time, boot id, PID namespace and
   * platform, the fields judgeHolder decides on), so a reader can tell the backend from another
   * process that now holds its pid. Absent in locks that older builds wrote, and read as absent
   * when it is malformed.
   */
  identity: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

export type ServerLockData = z.infer<typeof ServerLockDataSchema>;

/**
 * The locks this process wrote and has not released: lock path -> the `startedAt` it wrote.
 * A lock that names this process's own pid is live only if it is in here. Otherwise an earlier
 * process wrote it and the OS gave its pid to this one (every run of a container is pid 1), and
 * no HTTP answer can tell the two apart, because this process answers for itself.
 */
const ownedLocks = new Map<string, string>();

/** The lock in `filePath`, or null if it is missing or not a valid lock. */
async function readLockFile(filePath: string): Promise<ServerLockData | null> {
  try {
    return ServerLockDataSchema.parse(JSON.parse(await fs.readFile(filePath, "utf-8")));
  } catch {
    return null;
  }
}

/**
 * What the lock's process identity says about its backend, without the network:
 * - "stale": the backend is not there (pid gone, other start time, or another boot, PID namespace
 *   or platform, which processLiveness retires by contract).
 * - "live": a process with the recorded start time holds the pid, in this boot and PID namespace.
 * - "undecided": identity cannot say. This is the case when
 *   - the lock has none (an older build wrote it), or
 *   - this process has no Linux PID domain to compare (macOS, Windows, or a Linux process that
 *     cannot read its own boot id or PID namespace), or
 *   - on Linux, the lock's identity is incomplete (no boot id, PID namespace or start time), or
 *     the start time of the pid cannot be read.
 */
function judgeByIdentity(data: ServerLockData): "stale" | "live" | "undecided" {
  const identity = data.identity === undefined ? undefined : parseProcessIdentity(data.identity);
  // mutation-equivalent: peek() answers this process's own pid before it calls this, so the
  // second argument (whether this process may still write the lock) is never read.
  const verdict = judgeHolder({ pid: data.pid, identity }, false);
  if (verdict.dead) return "stale";
  // judgeHolder reports "running" for a pid it only saw alive (no identity, or no Linux PID
  // domain). With the Linux PID domain on both sides, "running" means the start time matched.
  const self = getSelfIdentity();
  const provenByStartTime =
    identity !== undefined &&
    self.bootId !== null &&
    self.pidNs !== null &&
    verdict.running === true;
  return provenByStartTime ? "live" : "undecided";
}

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
      identity: { ...getSelfIdentity() },
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
   * Returns null if the lockfile doesn't exist or is stale: the backend that wrote it is gone
   * (see peek()).
   *
   * A reader never deletes a stale lock. Unlinking it by path after the check would also
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
   * The OS reuses pids, so a live pid alone does not make a lock live: a reader that trusted it
   * would refuse to start next to a backend that is gone, or send the lock's token to whatever
   * listens on its port now. A lock is live in one of three ways:
   * - It names this process's pid, and this process acquired it (ownedLocks).
   * - Its process identity says so (judgeHolder). On Linux, in the PID namespace and boot the
   *   lock names, the pid with the recorded start time is the backend, even when the backend is
   *   frozen, and any other start time (or a gone pid, or another boot or namespace) is not.
   *   That needs no network, so a squatter on the backend's port can neither pass for it nor
   *   receive the token, and a backend that does not answer is not mistaken for a dead one.
   * - Identity cannot decide, and a probe of the lock's baseUrl does not say "no" (see
   *   probeXumBackend). That covers macOS and Windows (a live pid is all there is), and locks that
   *   an older build wrote (they record no identity). A backend that connects and does not answer
   *   in time counts as live there too, as it did before the probe.
   */
  async peek(): Promise<ServerLockData | null> {
    const data = await readLockFile(this.lockPath);
    if (data == null) return null;
    if (data.pid === process.pid) {
      return ownedLocks.get(this.lockPath) === data.startedAt ? data : null;
    }
    const byIdentity = judgeByIdentity(data);
    if (byIdentity === "stale") return null;
    // No await since the read: a lock that is replaced after this point is replaced just as much
    // after the return, as for every reader. Only the probe waits on the network, so only its
    // branch reads the lock again.
    if (byIdentity === "live") return data;
    // "silent" (connected, no answer in time) is live on purpose: a frozen backend looks like it,
    // and a second backend must not start next to one. Only a lock that judgeByIdentity left
    // "undecided" reaches this line (macOS and Windows, a lock that an older build wrote, an
    // incomplete identity, a start time that cannot be read), and there the public /version
    // answer proves nothing either: a process that answers it gets the token as well as one that
    // stalls (see the limits in probeXumBackend).
    if ((await probeXumBackend(data.baseUrl)) === "no") return null;
    // A restart can replace the lock while the probe waits. Hand out the lock that was asked
    // only if it is still the lock: a caller must not send its token to the successor.
    const current = await readLockFile(this.lockPath);
    return current?.pid === data.pid && current.startedAt === data.startedAt ? data : null;
  }

  /**
   * Release the lock this process acquired. Another backend's lock is never deleted: a backend
   * that a starter judged stale (it did not answer in time) has had its lock replaced by the
   * starter's acquire(), and deleting that lock would leave the running backend undiscoverable.
   *
   * The lock is read first and only a lock that is ours is touched, so a successor's lock stays
   * at its path throughout. No unlink can test who owns the file it removes, so a lock that was
   * ours is renamed out of the way before it is deleted, and read again. Only if a successor
   * acquired in between (the time between two calls) is the renamed lock another backend's: it is
   * copied back, and the copy fails if a newer lock took the path meanwhile (COPYFILE_EXCL
   * creates the file only if it is absent and, unlike link(), needs no hard-link support). A
   * reader that looks while that copy runs can see a partial file and treat it as no lock.
   */
  async release(): Promise<void> {
    const startedAt = ownedLocks.get(this.lockPath);
    ownedLocks.delete(this.lockPath);
    if (startedAt == null) return;
    const isOurs = (lock: ServerLockData | null) =>
      lock?.pid === process.pid && lock.startedAt === startedAt;
    if (!isOurs(await readLockFile(this.lockPath))) return;

    const aside = `${this.lockPath}.${process.pid}.release`;
    try {
      await fs.rename(this.lockPath, aside);
    } catch {
      return; // the lock is gone already
    }
    const taken = await readLockFile(aside);
    if (taken != null && !isOurs(taken)) {
      // A successor replaced the lock after it was read. If it cannot be put back, `aside`
      // stays, so it is not lost.
      const settled = await fs.copyFile(aside, this.lockPath, fsConstants.COPYFILE_EXCL).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code === "EEXIST"
      );
      if (!settled) return;
    }
    await fs.unlink(aside).catch(() => undefined);
  }

  /**
   * Get the path to the lockfile (for testing/debugging).
   */
  getLockPath(): string {
    return this.lockPath;
  }
}
