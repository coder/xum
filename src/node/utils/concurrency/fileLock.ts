/**
 * Cross-process filesystem lock (extracted from the journal kit's append
 * lock so the durable-event blob lock can share one proven protocol).
 *
 * Protocol:
 * - Lock birth is atomic-with-content: the token (`pid:nonce`) is fully
 *   written to a temp file first and hard-linked into place (link fails
 *   EEXIST when held), so a reader can never observe a token-less lock.
 * - Waiting is a bounded jittered poll — there is no portable cross-process
 *   wake primitive available here.
 * - Crash remnants are reclaimed only when the recorded owner is judged dead
 *   by the shared rule in processLiveness.ts (#4415): its pid is gone or
 *   reused in this PID domain, or it belongs to a positively different
 *   (retired) PID domain under the single-PID-domain deployment contract. A
 *   live or indeterminate owner is never reclaimed, however old the lock —
 *   there is no lease fallback for a live pid. Only a malformed token (no
 *   owner to judge) still ages out after the lease.
 * - Reclamation itself is serialized by a guard lockfile and verifies before
 *   displacing: under the guard the canonical token is re-read and must
 *   still equal the judged-stale token, so a lock released-and-reacquired
 *   while a reclaimer was deciding is never displaced (round 11: two
 *   concurrent reclaimers + a fresh acquirer could otherwise put two
 *   processes inside the protected section). Claim-by-rename then moves the
 *   verified-stale token aside; a post-rename mismatch (fresh owner
 *   displaced despite everything — possible only via the stale-guard
 *   double-remove residual below, or an older build's lease-based reclaim)
 *   restores it via link, and a failed restoration PRESERVES the
 *   displaced record instead of destroying the owner's only evidence.
 * - Release is ownership-verified: a mismatched token means the lock was
 *   reclaimed and re-acquired by someone else; leave it alone.
 *
 * Invariant: at most one process can believe it owns the lock. A live holder
 * is never judged stale, and any canonical-token change between judgment
 * and displacement aborts the reclaim. Holders still expose
 * `assertStillOwned` for critical sections to re-verify ownership
 * immediately before irreversible mutations (mirrors the rollback lock's
 * commit-point doctrine in refinementRollback.ts) — it also catches older
 * builds, which still lease-break holders whose birth they cannot prove.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { log } from "@/node/services/log";
import {
  getSelfIdentity,
  judgeHolder,
  parseProcessIdentity,
  probeProcessBirth,
  type HolderEvidence,
} from "@/node/utils/concurrency/processLiveness";

/** Poll interval while another live process holds the lock. */
const FILE_LOCK_RETRY_MS = 10;

/**
 * Age after which a MALFORMED token (no pid to judge) is reclaimed. Tokens
 * are published atomically-with-content, so malformed content has no live
 * writer. Never applied to a well-formed token (#4415): a live pid is never
 * lease-broken, whatever its birth evidence. Older builds still apply this
 * lease to live holders whose birth they cannot prove, which is why holders
 * keep renewing below.
 */
const FILE_LOCK_LEASE_MS = 5 * 60_000;

/**
 * How often a live holder refreshes the lockfile mtime while holding the
 * lock (r59). This build never lease-breaks a live holder; renewal remains
 * so builds predating #4415, which lease-break holders whose birth they
 * cannot prove (e.g. Windows), never age out a healthy one.
 */
const FILE_LOCK_RENEW_INTERVAL_MS = FILE_LOCK_LEASE_MS / 4;

/** Interleaving points inside reclamation, exposed only for tests. */
export type ReclaimSeamPhase = "post-guard" | "pre-restore";

export interface ProcessFileLockOptions {
  /** Absolute or relative lockfile path; the parent directory is created. */
  lockPath: string;
  /** Max milliseconds to wait before acquisition fails. */
  timeoutMs: number;
  /** Human label for error/log messages (e.g. "append lock", "blob lock"). */
  label: string;
  /**
   * Test seam: awaited at deterministic points inside stale-lock
   * reclamation — the only way to exercise reclaim/acquire interleavings
   * (a real competitor cannot be paused between our judgment and our
   * rename). "post-guard" fires after guard acquisition, before the
   * verify-before-displace re-read; "pre-restore" fires after a wrongful
   * displacement is detected, before the restoration link.
   */
  testOnlyReclaimSeam?: (phase: ReclaimSeamPhase) => Promise<void>;
  /**
   * Lease-renewal cadence override (default FILE_LOCK_RENEW_INTERVAL_MS).
   * Exists so tests can observe renewal without a multi-minute wait; real
   * callers should not need to tune it.
   */
  renewIntervalMs?: number;
}

export interface ProcessFileLock extends AsyncDisposable {
  /**
   * Re-read the lockfile and throw when this acquisition no longer owns it
   * (wrongfully displaced by a reclaimer, or reclaimed after a wedge).
   * Critical sections call this immediately before irreversible mutations —
   * see the module-doc invariant discussion.
   */
  assertStillOwned(): Promise<void>;
}

/**
 * Tokens this process may still write (lock or reclaim guard): registered
 * before publication, retired after release or a failed acquisition. A
 * token with our pid that is not registered here can never be written
 * again (a leak, or a previous process with our pid) and is reclaimable.
 */
const liveTokens = new Set<string>();

/**
 * Build a `pid:nonce:birthHex:identityHex` ownership token for lock/guard
 * files (hex-encoded: ps-derived birth strings contain spaces and colons).
 * Older readers use only parts 0 and 2, so the identity segment (#4415) is
 * additive; an empty birth segment reads as "no birth" to them.
 */
function makeOwnershipToken(): { token: string; nonce: string } {
  const nonce = crypto.randomBytes(8).toString("hex");
  const ownBirth = getProcessBirth(process.pid);
  const birthHex = ownBirth === null ? "" : Buffer.from(ownBirth).toString("hex");
  const identityHex = Buffer.from(JSON.stringify(getSelfIdentity())).toString("hex");
  const token = `${process.pid}:${nonce}:${birthHex}:${identityHex}`;
  liveTokens.add(token);
  return { token, nonce };
}

/**
 * Birth-probe memo: probing can spawn `ps` on non-Linux platforms, and the
 * reclaim path polls every ~15ms during contention. A short TTL bounds the
 * spawn rate; process birth is immutable, so a cached LIVE answer only goes
 * stale via pid reuse, which cannot happen within the TTL while the pid is
 * still alive.
 */
const birthCache = new Map<number, { birth: string | null; at: number }>();
const BIRTH_CACHE_TTL_MS = 1_000;

/**
 * Stable identity of the process currently occupying `pid`, or null when the
 * platform offers no probe (or the process vanished mid-probe). Recorded in
 * lock tokens and compared at reclamation: a live pid whose CURRENT birth
 * differs from the token's proves the OS reused the pid for an unrelated
 * process — without this, kill(pid, 0) alone would judge a crashed owner's
 * reused pid live forever, wedging every append until manual cleanup.
 * Token creation and verification run the same probe order on the same
 * machine (session dirs are host-local), so formats always align.
 * Exported for tests (constructing a verified-live token needs the format).
 */
export function getProcessBirth(pid: number): string | null {
  const cached = birthCache.get(pid);
  if (cached !== undefined && Date.now() - cached.at < BIRTH_CACHE_TTL_MS) {
    return cached.birth;
  }
  const birth = probeProcessBirth(pid);
  birthCache.set(pid, { birth, at: Date.now() });
  return birth;
}

/**
 * Parsed lock token, or null when malformed. The COMPLETE shape is checked,
 * not just a numeric prefix: content that merely starts with a live pid
 * ("1234", "1234:", "1234garbage") is corruption, not holder evidence, and
 * must take the malformed-token lease path instead of being refused forever.
 * Accepted shapes (everything this and previous builds write):
 * - legacy `pid:nonce` and `pid:nonce:birthHex` (pre-#4415);
 * - `pid:nonce:birthHex:identityHex`, birthHex possibly empty, identityHex
 *   decoding to a JSON object (#4415).
 */
function parseLockToken(raw: string): HolderEvidence | null {
  const parts = raw.split(":");
  const [pidText, nonce, birthHex, identityHex] = parts;
  const hex = /^(?:[0-9a-f]{2})+$/;
  if (
    parts.length < 2 ||
    parts.length > 4 ||
    !/^[1-9][0-9]*$/.test(pidText) ||
    !/^[A-Za-z0-9_-]+$/.test(nonce) ||
    (birthHex !== undefined && birthHex !== "" && !hex.test(birthHex)) ||
    // A legacy 3-segment token was only ever written with a birth.
    (parts.length === 3 && birthHex === "")
  ) {
    return null;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) {
    return null;
  }
  const decode = (value: string | undefined) =>
    value === undefined || value === "" ? null : Buffer.from(value, "hex").toString("utf-8");
  if (identityHex === undefined) {
    return { pid, legacyBirth: decode(birthHex) };
  }
  if (!hex.test(identityHex)) {
    return null;
  }
  try {
    const parsed = JSON.parse(decode(identityHex) ?? "") as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { pid, identity: parseProcessIdentity(parsed as Record<string, unknown>) };
    }
  } catch {
    // Unparseable identity segment: malformed.
  }
  return null;
}

export async function acquireProcessFileLock(
  options: ProcessFileLockOptions
): Promise<ProcessFileLock> {
  const { lockPath, timeoutMs, label } = options;
  assert(lockPath.length > 0, "acquireProcessFileLock requires a lock path");
  assert(timeoutMs > 0, "acquireProcessFileLock timeoutMs must be positive");
  const { token, nonce } = makeOwnershipToken();
  const tempPath = `${lockPath}.tmp-${process.pid}-${nonce}`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(tempPath, token, "utf-8");
    for (;;) {
      try {
        await fs.link(tempPath, lockPath);
        acquired = true;
        // Lease renewal (r59, see FILE_LOCK_RENEW_INTERVAL_MS): keep a live
        // holder's mtime fresh so an older build's lease-based reclaim never
        // displaces it mid-critical-section. unref'd — a held lock must not
        // keep the process alive; renewal only matters while real work
        // (which itself keeps the loop alive) is still running.
        const renewIntervalMs = options.renewIntervalMs ?? FILE_LOCK_RENEW_INTERVAL_MS;
        assert(renewIntervalMs > 0, "renewIntervalMs must be positive");
        let renewInFlight: Promise<void> | null = null;
        const renewTimer = setInterval(() => {
          if (renewInFlight !== null) return; // never overlap renewals
          renewInFlight = renewLeaseOnce(lockPath, token, label).finally(() => {
            renewInFlight = null;
          });
        }, renewIntervalMs);
        renewTimer.unref();
        return {
          assertStillOwned: () => assertLockOwned(lockPath, token, label),
          [Symbol.asyncDispose]: async () => {
            // Stop-and-JOIN renewal before releasing: a renewal still in
            // flight after release could otherwise refresh a successor's
            // lockfile it no longer owns (renewLeaseOnce re-verifies the
            // token, but only joining makes the ordering deterministic).
            clearInterval(renewTimer);
            if (renewInFlight !== null) await renewInFlight;
            await releaseFileLock(lockPath, token, label);
            liveTokens.delete(token); // After release's last possible write.
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      await reclaimStaleFileLock(lockPath, label, options.testOnlyReclaimSeam);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring ${label} ${lockPath} after ${timeoutMs}ms`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, FILE_LOCK_RETRY_MS + Math.random() * FILE_LOCK_RETRY_MS)
      );
    }
  } finally {
    if (!acquired) {
      liveTokens.delete(token);
    }
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/**
 * One lease-renewal tick (r59): refresh the held lock's mtime so an older
 * build's lease never expires under a live holder. Only the current owner renews (token re-verified first); the
 * residual read→utimes race can only refresh a successor's fresh lease,
 * never displace anyone. Never throws: a failed renewal degrades to the
 * pre-renewal exposure, still bounded by commit-point assertStillOwned.
 */
async function renewLeaseOnce(lockPath: string, token: string, label: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, "utf-8");
    if (current !== token) {
      return; // Displaced or reclaimed: nothing of ours to renew.
    }
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch (error) {
    log.debug(`FileLock: failed to renew ${label} ${lockPath}`, { error });
  }
}

/** Throw when `token` is no longer the canonical lock content (see handle doc). */
async function assertLockOwned(lockPath: string, token: string, label: string): Promise<void> {
  let current: string | null = null;
  try {
    current = await fs.readFile(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // ENOENT = the lock vanished: someone judged us stale and reclaimed.
  }
  if (current !== token) {
    throw new Error(
      `${label} ${lockPath} is no longer owned by this holder (displaced or reclaimed); ` +
        `aborting before mutation`
    );
  }
}

/**
 * True when the lock's owner is judged dead by the shared rule (see
 * processLiveness.judgeHolder). A live or indeterminate owner is never
 * stale, regardless of age. Only a malformed token falls back to the lease.
 */
async function isLockStale(lockPath: string, observed: string): Promise<boolean> {
  const holder = parseLockToken(observed);
  if (holder === null) {
    return await lockLeaseExpired(lockPath);
  }
  return judgeHolder(holder, liveTokens.has(observed)).dead;
}

/** True when the lockfile's mtime is older than the stale-lock lease. */
async function lockLeaseExpired(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > FILE_LOCK_LEASE_MS;
  } catch {
    return false; // Vanished (released/reclaimed): retry acquisition instead.
  }
}

/**
 * Serialize reclaimers: at most one process may evaluate/displace a stale
 * lock at a time. The round-11 double entry began with exactly the
 * forbidden interleaving — reclaimer 1 removes the stale token, a fresh
 * owner acquires, and reclaimer 2 (still acting on its pre-removal read)
 * renames the fresh lock aside. When the guard is busy, `fn` is skipped and
 * the caller's poll loop retries; a crash-remnant guard (dead by the same
 * judgment as locks) is unlinked so it cannot deadlock
 * reclamation. The unconditional unlink of a stale guard has its own
 * theoretical double-remove window (plain POSIX cannot compare-and-unlink);
 * the verify-before-displace re-read in reclaimStaleFileLock and holders'
 * commit-point assertStillOwned make that residual harmless — mirroring the
 * rollback lock's guard doctrine in refinementRollback.ts.
 */
async function withReclaimGuard(
  lockPath: string,
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  const guardPath = `${lockPath}.reclaim`;
  const { token, nonce } = makeOwnershipToken();
  const tempPath = `${guardPath}.tmp-${process.pid}-${nonce}`;
  await fs.writeFile(tempPath, token, "utf-8");
  try {
    try {
      await fs.link(tempPath, guardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const observed = await fs.readFile(guardPath, "utf-8").catch(() => null);
      if (observed !== null && (await isLockStale(guardPath, observed))) {
        await fs.unlink(guardPath).catch(() => undefined);
      }
      return; // Guard busy (or just freed): the caller's poll loop retries.
    }
    try {
      await fn();
    } finally {
      await releaseFileLock(guardPath, token, `${label} reclaim guard`);
    }
  } finally {
    liveTokens.delete(token);
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/** Reclaim the lock if its recorded owner is provably gone (see module doc). */
async function reclaimStaleFileLock(
  lockPath: string,
  label: string,
  testOnlySeam?: (phase: ReclaimSeamPhase) => Promise<void>
): Promise<void> {
  let observed: string;
  try {
    observed = await fs.readFile(lockPath, "utf-8");
  } catch {
    return; // Already released or reclaimed; retry acquisition.
  }
  if (!(await isLockStale(lockPath, observed))) {
    return;
  }
  await withReclaimGuard(lockPath, label, async () => {
    if (testOnlySeam !== undefined) {
      await testOnlySeam("post-guard");
    }
    // Verify before displacing: with reclaimers serialized by the guard,
    // only the owner's own release can change the canonical token between
    // our staleness judgment and here — ANY change means a fresh owner may
    // hold the lock now, so the reclaim must abort rather than displace it.
    const current = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (current !== observed) {
      return;
    }
    const graveyard = `${lockPath}.stale-${crypto.randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(lockPath, graveyard);
    } catch {
      return; // Lock vanished (owner released): retry acquisition.
    }
    const claimed = await fs.readFile(graveyard, "utf-8").catch(() => null);
    if (claimed !== null && claimed !== observed) {
      // Despite the guard and the re-read, a fresh holder acquired inside the
      // re-read→rename window (see the module doc's residuals): restore the
      // displaced owner's lock.
      if (testOnlySeam !== undefined) {
        await testOnlySeam("pre-restore");
      }
      try {
        await fs.link(graveyard, lockPath);
      } catch (error) {
        // A third process claimed the emptied path first. PRESERVE the
        // displaced record (round 11): destroying it would erase the only
        // evidence of the wrongful displacement while its holder still
        // believes it owns the section; the holder's commit-point
        // assertStillOwned aborts it instead.
        log.error(
          `FileLock: failed to restore a wrongfully displaced ${label} on ${lockPath}; ` +
            `preserving the displaced record at ${graveyard}`,
          { error }
        );
        return;
      }
      log.warn(`FileLock: reclaim raced a fresh ${label} on ${lockPath}; restored it`);
      await fs.unlink(graveyard).catch(() => undefined);
      return;
    }
    await fs.unlink(graveyard).catch(() => undefined);
  });
}

/** Release only if we still own the lock (a raced reclaim may have replaced it). */
async function releaseFileLock(lockPath: string, token: string, label: string): Promise<void> {
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    if (content !== token) {
      log.warn(`FileLock: ${label} ${lockPath} changed owners before release; leaving it`);
      return;
    }
    await fs.unlink(lockPath);
  } catch (error) {
    log.debug(`FileLock: failed to release ${label} ${lockPath}`, { error });
  }
}
