import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { log } from "@/node/services/log";
import { ensurePrivateDirSync } from "@/node/utils/fs";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class FileLeaseManager {
  readonly rootDir: string;
  readonly providersFile: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getXumHome();
    this.providersFile = path.join(this.rootDir, "providers.jsonc");
  }

  /**
   * Advisory cross-process lock for providers.jsonc read-modify-write cycles.
   *
   * Multiple xum processes (desktop app, `xum run`, `xum workflow`) share
   * providers.jsonc, and OAuth credential rotation requires compare-and-set
   * semantics across them. Exclusive directory creation is atomic on all
   * platforms, so `<providersFile>.lock/` serves as the mutex. Locks orphaned
   * by crashed processes are broken after a staleness timeout.
   */
  async withProvidersFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
    // Guards sub-second file mutations, so contention resolves quickly.
    return this.withDirLock(`${this.providersFile}.lock`, 5_000, 10_000, fn);
  }

  /**
   * Cross-process serialization of Coder OAuth token refreshes.
   *
   * Coder rotates refresh tokens on every use, so two processes refreshing
   * the same credential race destructively: the loser's `invalid_grant` can
   * arrive — and its compare-and-clear delete the credential — while the
   * winner's rotation is still in flight and not yet on disk, after which the
   * winner's persist CAS fails too and BOTH processes discard the only valid
   * token. Serializing the whole refresh round-trip (re-read + token request
   * + persist) closes that window: a loser re-reads inside the lock and
   * adopts the winner's rotation without ever sending a doomed request.
   *
   * Timing: the guarded section includes one bounded token request (30s cap,
   * see TOKEN_REQUEST_TIMEOUT_MS in coderOauthService.ts), so acquisition
   * waits up to 45s and orphaned locks are broken after 60s.
   */
  async withCoderOauthRefreshLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-refresh.lock`, 45_000, 60_000, fn);
  }

  /**
   * Cross-process serialization of Coder OAuth desktop-login commits
   * (persist -> finish/rollback; see commitDesktopLogin in
   * coderOauthService.ts).
   *
   * A login's rollback snapshot (`previousSection`) must only ever capture a
   * COMMITTED section. Login flows are process-local, but the persisted
   * section is shared across processes: without this lock, a flow in process
   * B could snapshot process A's persisted-but-uncommitted login; if both
   * were then cancelled, A's rollback would skip (B's auth is current) and
   * revoke A's tokens, after which B's rollback would restore that
   * already-revoked auth over the original login.
   *
   * Timing: the guarded section is a handful of providers-file mutations and
   * no network I/O (revocation runs after release), so acquisition waits up
   * to 15s and orphaned locks are broken after 20s.
   */
  async withCoderOauthLoginCommitLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-login.lock`, 15_000, 20_000, fn);
  }

  /**
   * Atomically install a generation-marked lock directory at `lockPath`: the
   * owner marker (content = holder PID, see tryBreakStaleDirLock) is written
   * into a staged sibling directory which is then rename(2)d into place.
   * Acquisition and marker creation are therefore a single atomic step — a
   * live acquisition is never observable as an EMPTY lock directory, so an
   * empty directory is always a crash remnant (the unlink→rmdir window of
   * release/stale-break) that breakers may reclaim immediately. Without this,
   * a crash between mkdir and marker write would look live until the mtime
   * TTL, and every acquisition timeout is shorter than its TTL — the first
   * operation after such a crash would always time out.
   *
   * On POSIX, rename onto an existing EMPTY directory atomically replaces it
   * (instant orphan recovery); onto a non-empty one it fails ENOTEMPTY. On
   * Windows, rename onto any existing directory fails — contenders recover
   * empty orphans via tryBreakStaleDirLock instead.
   *
   * Returns the installed marker path, or null when the lock is held
   * (contended). Unexpected filesystem errors (EACCES, EROFS, ...) are
   * rethrown after the stage directory is cleaned up.
   */
  private tryInstallDirLock(lockPath: string): string | null {
    const stagePath = `${lockPath}.stage-${crypto.randomBytes(8).toString("hex")}`;
    const markerName = `owner-${crypto.randomBytes(16).toString("hex")}`;
    fs.mkdirSync(stagePath);
    try {
      fs.writeFileSync(path.join(stagePath, markerName), String(process.pid));
      fs.renameSync(stagePath, lockPath);
    } catch (error) {
      try {
        fs.rmSync(stagePath, { recursive: true, force: true });
      } catch {
        // Best effort; abandoned stages are swept by cleanupAbandonedStageDirs.
      }
      const code = (error as NodeJS.ErrnoException).code;
      // POSIX rename refuses a non-empty target with ENOTEMPTY (some
      // platforms report EEXIST); Windows refuses any existing target with
      // EPERM/EEXIST.
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") {
        return null;
      }
      throw error;
    }
    return path.join(lockPath, markerName);
  }

  /**
   * Remove stage directories abandoned by a crash between staging and the
   * rename in tryInstallDirLock. TTL-gated on mtime so a concurrent
   * acquisition's in-flight stage (a microseconds-wide window) is never
   * destroyed under a live process.
   */
  private cleanupAbandonedStageDirs(lockPath: string, ttlMs: number): void {
    const parent = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.stage-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const stagePath = path.join(parent, entry);
      try {
        if (Date.now() - fs.statSync(stagePath).mtimeMs > ttlMs) {
          fs.rmSync(stagePath, { recursive: true, force: true });
        }
      } catch {
        // Best effort (already removed, or racing its own install).
      }
    }
  }

  /**
   * Shared advisory directory lock: acquisition atomically installs the lock
   * directory together with its generation marker (see tryInstallDirLock);
   * locks orphaned by crashed processes are broken once they are older than
   * `staleLockMs` AND their owner process is gone
   * (see tryBreakStaleDirLock — live-but-stalled holders are never broken;
   * contenders instead fail acquisition at the bounded timeout).
   *
   * Ownership generations: a holder that runs past `staleLockMs` (suspended
   * process, stalled event loop) can be stale-broken and the lock reacquired
   * before its release runs — an unconditional removal would then delete the
   * successor's lock and let a third process into the critical section. Each
   * acquisition therefore writes a generation-unique marker file and release
   * only removes that generation (see tryBreakStaleDirLock for the breaker's
   * matching conditional cleanup).
   */
  async withDirLock<T>(
    lockPath: string,
    acquireTimeoutMs: number,
    staleLockMs: number,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const RETRY_DELAY_MS = 25;
    const deadline = Date.now() + acquireTimeoutMs;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }
    this.cleanupAbandonedStageDirs(lockPath, staleLockMs);

    let ownerFile: string;
    for (;;) {
      // tryInstallDirLock rethrows permanent filesystem errors (EACCES,
      // EROFS, ...) — they would fail on every retry, so callers surface an
      // error instead of spinning until the deadline.
      const installed = this.tryInstallDirLock(lockPath);
      if (installed != null) {
        ownerFile = installed;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring providers config lock at ${lockPath}`);
      }
      // Held by another process (or a crashed one): break stale locks, then
      // retry — immediately after a break/vanish, with a delay for a live
      // holder.
      if (this.tryBreakStaleDirLock(lockPath, staleLockMs)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(ownerFile);
        try {
          fs.rmdirSync(lockPath);
        } catch (error) {
          // ENOENT/ENOTEMPTY: a breaker finished the removal or a successor
          // generation already acquired the path — leave it to them.
          log.debug("Failed to release providers config lock:", error);
        }
      } catch {
        // Marker already gone: this holder outlived staleLockMs and was
        // stale-broken; a successor may hold the lock now — keep it.
      }
    }
  }

  /**
   * Try to take an exclusive cross-process lease on the stored Coder OAuth
   * dynamic client. The client's registration has a single redirect_uris
   * slot, so only one login flow — across every Xum process sharing this
   * providers file — may reuse (and RFC 7592-update) it at a time; callers
   * that fail to acquire the lease must register a fresh client instead.
   *
   * Non-blocking: returns a release function on success, or null when another
   * live flow holds the lease. Unlike withProvidersFileLock (which guards
   * sub-second file mutations), this lease spans a whole login flow — the
   * redirect URI must stay registered until the user finishes authorizing —
   * so staleness is judged against `ttlMs` (the flow timeout). A crashed
   * holder's lease is broken after that (only once its process is provably
   * gone, see tryBreakStaleDirLock), and in the interim other flows degrade
   * gracefully to fresh client registrations.
   *
   * Ownership safety: a lease that crosses the staleness boundary can be
   * broken and reacquired by another process at any instant, so neither
   * release nor stale-breaking may check-then-recursively-remove (the check
   * and the rm would race the handover). Instead each acquisition writes a
   * generation-unique marker FILE inside the lease directory, and every
   * destructive step is conditional at the filesystem layer: unlink can only
   * remove the specific generation's marker (a successor's marker has a
   * different name), and the non-recursive rmdir only removes an EMPTY
   * directory — never a directory a successor generation re-marked.
   */
  tryAcquireCoderOauthClientLease(ttlMs: number): (() => void) | null {
    const leasePath = `${this.providersFile}.coder-client.lock`;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }

    this.cleanupAbandonedStageDirs(leasePath, ttlMs);

    for (let attempt = 0; attempt < 2; attempt++) {
      let ownerFile: string;
      try {
        const installed = this.tryInstallDirLock(leasePath);
        if (installed == null) {
          // Contended: held by another flow (or a crash remnant).
          if (!this.tryBreakStaleDirLock(leasePath, ttlMs)) {
            return null; // Held by a live flow.
          }
          continue; // Stale lease broken (or it vanished); retry once.
        }
        ownerFile = installed;
      } catch (error) {
        // Filesystem errors mean the lease was never installed. The lease is
        // an optimization with a documented degradation path — callers fall
        // back to registering a fresh client — so prefer a working login
        // over surfacing an acquisition error.
        log.debug("Failed to install Coder OAuth client lease:", error);
        return null;
      }

      return () => {
        try {
          fs.unlinkSync(ownerFile);
        } catch {
          return; // Stale-broken and reacquired by another flow; keep it.
        }
        try {
          fs.rmdirSync(leasePath);
        } catch (error) {
          // A release racing the staleness boundary can lose the directory to
          // a concurrent breaker after the unlink above: ENOENT means the
          // breaker finished the removal, ENOTEMPTY means a successor already
          // acquired a new generation — both correctly leave it untouched.
          log.debug("Failed to release Coder OAuth client lease:", error);
        }
      };
    }
    return null;
  }

  /**
   * Break a marker-based directory lock/lease left behind by a crashed (or
   * stalled-past-staleness) holder. Shared by withDirLock and
   * tryAcquireCoderOauthClientLease, whose generation-marker layout matches.
   * Returns true when the caller should retry acquisition (the lock was
   * stale or vanished mid-check), false when it is held by a live owner.
   */
  private tryBreakStaleDirLock(leasePath: string, ttlMs: number): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(leasePath);
    } catch {
      return true; // Released between the failed mkdir and now; retry.
    }
    const isStale = (mtimeMs: number) => Date.now() - mtimeMs > ttlMs;

    if (entries.length === 0) {
      // Acquisition installs the marker atomically with the directory
      // (staged rename — see tryInstallDirLock), so an empty lock directory
      // is never a live acquisition: it can only be a crash remnant from the
      // unlink→rmdir window of release/stale-break. Reclaim it immediately —
      // waiting out the mtime TTL would make every acquisition timeout (all
      // shorter than their TTLs) fire first, so the first operation after
      // such a crash would always fail despite being deterministically
      // recoverable. The non-recursive rmdir keeps the race with a concurrent
      // installer safe: it cannot destroy a renamed-in full generation.
      try {
        fs.rmdirSync(leasePath);
      } catch {
        // ENOTEMPTY (a generation was renamed into place) or ENOENT (another
        // breaker won); the retried install/staleness check sorts either out.
      }
      return true;
    }

    // Staleness binds to the OBSERVED generation's marker: marker names are
    // generation-unique, so if the lease changes hands after this check the
    // unlink below ENOENTs and the rmdir ENOTEMPTYs — a live successor lease
    // is never destroyed (the reason breaking must not use recursive rm).
    for (const entry of entries) {
      const entryPath = path.join(leasePath, entry);
      // The marker carries the owner's PID, checked FIRST:
      // - Owner provably ALIVE: never break, however old the marker. A live
      //   process that merely outlived the TTL (suspended laptop, stalled
      //   event loop) may still be mid-critical-section; breaking would let a
      //   second process in, and for the refresh lock the resumed original
      //   could then race the successor over the same rotating refresh token
      //   — both sides clearing/revoking the only valid credential.
      //   Contenders instead fail bounded (withDirLock times out, the client
      //   lease falls back to a fresh registration).
      // - Owner provably DEAD: reclaim immediately, however fresh the marker.
      //   A dead process cannot be mid-critical-section, and every
      //   acquisition timeout is shorter than its staleness TTL — waiting for
      //   the TTL would make the first operation after a crash always time
      //   out even though the orphan is deterministically recoverable.
      // - Owner unknown (unreadable/partial marker): fall back to the mtime
      //   TTL, the only remaining staleness signal.
      // Residual risk: a recycled PID belonging to an unrelated live process
      // keeps an orphaned lock alive until that process exits — rare, and
      // strictly safer than destroying a live holder's lock.
      let ownerPid: number | null = null;
      try {
        const content = fs.readFileSync(entryPath, "utf8").trim();
        ownerPid = /^\d+$/.test(content) ? Number(content) : null;
      } catch {
        continue; // Vanished mid-check; the conditional cleanup below is safe.
      }
      if (ownerPid !== null) {
        if (isProcessAlive(ownerPid)) {
          return false;
        }
      } else {
        try {
          if (!isStale(fs.statSync(entryPath).mtimeMs)) {
            return false;
          }
        } catch {
          continue; // Vanished mid-check; the conditional cleanup below is safe.
        }
      }
      try {
        fs.unlinkSync(entryPath);
      } catch {
        // Already removed by a concurrent breaker or by its owner's release.
      }
    }
    try {
      fs.rmdirSync(leasePath);
    } catch {
      // ENOTEMPTY (a generation appeared) or ENOENT (another breaker won);
      // the retried mkdir/staleness check sorts either out.
    }
    return true;
  }
}
