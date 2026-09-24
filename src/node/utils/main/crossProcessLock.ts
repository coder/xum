import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { probeProcessBirth } from "@/node/utils/concurrency/fileLock";

/**
 * Cross-process advisory file lock.
 *
 * In-process Promise queues serialize only one service instance; two
 * processes sharing the same Xum home (ALLOW_MULTIPLE_INSTANCES, a desktop
 * app alongside `xum server`) each have their own queue, so their
 * read-modify-write transactions on shared files can interleave and the last
 * writer silently drops the other's changes.
 *
 * FAIL-CLOSED LIVENESS (#4415): a lock is never taken from a holder that is
 * live, or whose death cannot be established (see judge() for exactly what
 * counts as evidence on each platform). Age is NOT evidence of death: a holder
 * whose libuv threadpool is starved by hung fs calls, that is SIGSTOPped, or
 * that is suspended stops renewing yet resumes and keeps writing. The former
 * "older than staleMs ⇒ reclaimable" lease let a sibling take the lock while
 * the original still wrote (reproduced). The price: a hung live holder blocks
 * contenders at their acquire budget until it exits; the timeout error names
 * it (pid, start time, why it was judged live) so the user can stop it.
 *
 * Publication is ATOMIC-WITH-CONTENT: records are written to a temp file and
 * hard-linked (create; exclusive, EEXIST when the path exists) or renamed
 * (takeover, renewal) into place, so no observer can ever read a partially
 * written lock and misjudge it corrupt.
 *
 * Takeover of a provably dead holder uses a per-generation guard file instead
 * of the former age-broken mkdir mutex; see supersede() for the protocol and
 * its safety argument.
 *
 * MIXED VERSIONS are unsupported: builds before #4415 still reclaim holders by
 * age (and ignore guards), so they can steal a stalled new holder. New builds
 * keep renewing `acquiredAt` so older builds at least never age out a HEALTHY
 * holder, and the lock paths are unchanged (renaming them would drop
 * cross-version exclusion entirely).
 */
export interface CrossProcessLockOptions {
  /** Absolute path of the lock file. Its parent directory must exist. */
  lockPath: string;
  /** How long an acquire waits on a live holder before failing. */
  acquireTimeoutMs: number;
  /**
   * Renewal cadence only: while held, `acquiredAt` is re-stamped every
   * staleMs/4 so builds predating #4415 (which reclaim holders older than
   * their staleMs) never age out a healthy holder. It is NOT a takeover
   * threshold: this build never reclaims a holder because of its age. Keep it
   * equal to the value older builds used for the same lock.
   */
  staleMs: number;
  /** Error message prefix thrown when the acquire timeout elapses. */
  timeoutMessage: string;
  /**
   * Abort waiting for a live holder. Checked before every attempt and wakes
   * the inter-attempt sleep, so a caller whose own operation ended (a tool
   * call interrupted with Escape) stops polling immediately instead of
   * occupying its place in an in-process queue until `acquireTimeoutMs`.
   * Never interrupts an acquisition that already succeeded.
   */
  signal?: AbortSignal;
}

/** Thrown when the acquire budget elapses; the message names the blocking holder. */
export class CrossProcessLockTimeoutError extends Error {}

/**
 * Process identity recorded in v2 holder records. Linux: `birth` is the
 * /proc starttime, `bootId`/`pidNs` define the PID domain in which a pid is
 * meaningful, and `machineId` is a mismatch check (plus reboot recovery).
 * `platform` is a MISMATCH check only. `hostname` is diagnostic only (shown
 * in the timeout error): macOS hostnames change with networks, so refusing on
 * a mismatch would keep a crashed holder's lock refused forever.
 */
interface ProcessIdentity {
  birth: string | null;
  bootId: string | null;
  pidNs: string | null;
  machineId: string | null;
  platform: string | null;
  hostname: string | null;
}

interface LockHolder {
  pid: number;
  token: string;
  acquiredAt: number;
  /** Absent on legacy (pre-#4415, v1) records. */
  identity?: ProcessIdentity;
}

function readTrimmed(file: string): string | null {
  try {
    const value = readFileSync(file, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Only Linux starttime is comparable evidence here: other encodings (macOS
 * `ps -o lstart`) depend on the probing process's locale/timezone, so a
 * mismatch would not prove a different process. Uncached on purpose — a
 * cached birth of a previous pid incarnation would read as "birth differs".
 */
function linuxBirth(pid: number): string | null {
  const birth = probeProcessBirth(pid);
  return birth?.startsWith("linux-ticks:") ? birth : null;
}

let selfIdentity: ProcessIdentity | undefined;

function getSelfIdentity(): ProcessIdentity {
  if (selfIdentity === undefined) {
    const linux = process.platform === "linux";
    let pidNs: string | null = null;
    let hostname: string | null = null;
    try {
      pidNs = linux ? readlinkSync("/proc/self/ns/pid") : null;
    } catch {
      pidNs = null;
    }
    try {
      hostname = os.hostname() || null;
    } catch {
      hostname = null;
    }
    selfIdentity = {
      birth: linux ? linuxBirth(process.pid) : null,
      bootId: linux ? readTrimmed("/proc/sys/kernel/random/boot_id") : null,
      pidNs,
      machineId: linux
        ? (readTrimmed("/etc/machine-id") ?? readTrimmed("/var/lib/dbus/machine-id"))
        : null,
      platform: process.platform,
      hostname,
    };
  }
  return selfIdentity;
}

/** Test seam: judge records as if this process had `identity` (undefined restores the probe). */
export function setSelfIdentityForTesting(identity: ProcessIdentity | undefined): void {
  selfIdentity = identity;
}

function holderRecord(token: string): string {
  // Older builds read only pid/token/acquiredAt; everything else is additive.
  return JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: Date.now(),
    v: 2,
    ...getSelfIdentity(),
  });
}

/**
 * Tokens this process may still publish or hold. A token is registered BEFORE
 * any file carrying it is published (lock create, guard, takeover) and retired
 * only after the operation's last possible write (failed attempt, finished
 * release). So a record with our pid whose token is absent here can never be
 * written again: it is a lock this process leaked (a failed release), or one
 * left by a previous process with our pid, and is reclaimable.
 */
const liveTokens = new Set<string>();

type Observation =
  | { kind: "absent" }
  | { kind: "unreadable"; code: string }
  | { kind: "corrupt"; key: string; mtimeMs: number }
  | { kind: "holder"; key: string; holder: LockHolder };
type Generation = Extract<Observation, { key: string }>;

function parseHolder(text: string): LockHolder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { pid, token, acquiredAt } = record;
  // acquiredAt is shape-checked only: it is a renewal stamp for older builds,
  // never a liveness signal. (The former "future timestamp ⇒ corrupt ⇒
  // reclaim" rule is gone: a clock stepped back would have made a live
  // holder's record reclaimable.)
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof acquiredAt !== "number" ||
    !Number.isFinite(acquiredAt)
  ) {
    return undefined;
  }
  if (record.v !== 2) {
    return { pid, token, acquiredAt };
  }
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    pid,
    token,
    acquiredAt,
    identity: {
      birth: str(record.birth),
      bootId: str(record.bootId),
      pidNs: str(record.pidNs),
      machineId: str(record.machineId),
      platform: str(record.platform),
      hostname: str(record.hostname),
    },
  };
}

/** Read `file` once. The generation key is the token, or a digest of corrupt bytes. */
async function observe(file: string): Promise<Observation> {
  const codeOf = (error: unknown) =>
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : String(error);
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(file, "r");
  } catch (error) {
    return hasErrorCode(error, "ENOENT")
      ? { kind: "absent" }
      : { kind: "unreadable", code: codeOf(error) };
  }
  try {
    // stat and read the SAME inode, so a corrupt verdict's age matches its bytes.
    const stat = await handle.stat();
    const bytes = await handle.readFile();
    const holder = parseHolder(bytes.toString("utf-8"));
    if (holder !== undefined) {
      return { kind: "holder", key: holder.token, holder };
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { kind: "corrupt", key: `corrupt-${digest}`, mtimeMs: stat.mtimeMs };
  } catch (error) {
    // Unreadable (EACCES, EIO, a Windows sharing violation) is NOT corruption:
    // nothing is known about the holder, so it is never reclaimed.
    return { kind: "unreadable", code: codeOf(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Unparseable records get this much settle time before they are reclaimed.
 * Evidence (git history of this file): every released version — introduced
 * in 0802bf2a7e (v0.28.3), changed only in 788d4a40d6 — publishes records
 * solely by link()/rename() of a fully written temp file, and no other code
 * writes these lock paths. So no live writer can be observed mid-publication:
 * persistently unparseable content is debris (manual edit, power loss before
 * writeback) whose writer is gone. The grace is margin, not a correctness
 * condition.
 */
const CORRUPT_LOCK_GRACE_MS = 2_000;

type Verdict = { dead: true } | { dead: false; why: string };
const DEAD: Verdict = { dead: true };
const refuse = (why: string): Verdict => ({ dead: false, why });

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM = exists but owned by another user; only ESRCH proves absence.
    return hasErrorCode(error, "ESRCH");
  }
}

/**
 * Death proof for a lock or guard record. Anything not judged dead is live or
 * indeterminate and is never reclaimed; age never reclaims.
 *
 * 1. Mismatch-only evidence: a different platform or machine-id (each
 *    compared only when both sides have it) means another machine or OS ⇒
 *    refuse. Equality proves nothing by itself. Hostname is not evidence.
 * 2. Linux, with our boot id and PID namespace readable: the record must name
 *    both. Same boot + same namespace ⇒ the pid is comparable: ESRCH or a
 *    different starttime ⇒ dead. Different boot with equal machine-ids ⇒ an
 *    earlier boot of this machine ⇒ dead (reboot recovery; cloned VMs sharing
 *    one network XUM_ROOT with equal machine-ids are outside the contract).
 *    Any other boot/namespace mismatch or missing value ⇒ refuse.
 * 3. macOS/Windows (no qualified PID-domain identity) and legacy v1 records:
 *    ASSUMES the holder shares this host's PID domain. ESRCH ⇒ dead; a live
 *    pid (or EPERM) ⇒ refuse. A holder on another host sharing the home, or
 *    in another PID domain, is misjudged dead when its pid is absent locally
 *    — only a recorded platform mismatch catches that.
 * 4. Same pid (in a domain that passed the checks above) is this process or a
 *    previous one that had our pid: live only while the token is registered
 *    in liveTokens. Legacy records cannot be ours, so a legacy record with
 *    our (live) pid is refused like any live pid.
 */
function judge(observation: Generation): Verdict {
  if (observation.kind === "corrupt") {
    return Date.now() - observation.mtimeMs > CORRUPT_LOCK_GRACE_MS
      ? DEAD
      : refuse("its content is unparseable and was written moments ago");
  }
  const { pid, token, identity: record } = observation.holder;
  if (record === undefined) {
    return pidGone(pid)
      ? DEAD
      : refuse("it was written by an older Xum build and that pid is running");
  }
  const self = getSelfIdentity();
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  if (differs(record.platform, self.platform) || differs(record.machineId, self.machineId)) {
    return refuse("it was written on another machine or OS");
  }
  const linuxDomain = self.bootId !== null && self.pidNs !== null;
  if (linuxDomain) {
    if (record.bootId === null || record.pidNs === null) {
      return refuse("its boot or PID namespace is unknown");
    }
    if (record.bootId !== self.bootId) {
      return record.machineId !== null && record.machineId === self.machineId
        ? DEAD
        : refuse("it comes from another boot and its machine cannot be verified as this one");
    }
    if (record.pidNs !== self.pidNs) {
      return refuse("it belongs to another PID namespace (container)");
    }
  } else if (record.bootId !== null || record.pidNs !== null) {
    return refuse("it names a PID domain this process cannot verify");
  }
  if (pid === process.pid) {
    return liveTokens.has(token) ? refuse("it is held by this process") : DEAD;
  }
  if (pidGone(pid)) {
    return DEAD;
  }
  if (!linuxDomain) {
    return refuse("that pid is running");
  }
  if (record.birth === null) {
    return refuse("its process start time is unknown");
  }
  const current = linuxBirth(pid);
  if (current === null) {
    return refuse("its process start time cannot be read");
  }
  return current === record.birth ? refuse("that process is running") : DEAD;
}

/** Why an attempt did not get the lock; reported by the timeout error. */
interface Blocker {
  holder?: LockHolder;
  why: string;
}

function describeBlocker(lockPath: string, blocker: Blocker | undefined): string {
  if (blocker === undefined) {
    return `Lock: ${lockPath}.`;
  }
  const holder = blocker.holder;
  const who =
    holder === undefined
      ? ""
      : ` by pid ${holder.pid} (started ${holder.identity?.birth ?? "at an unknown time"}` +
        `${holder.identity?.hostname ? ` on ${holder.identity.hostname}` : ""})`;
  const hint = holder === undefined ? "" : " Stop that process to free the lock.";
  return `Lock ${lockPath} is held${who} and was not taken over because ${blocker.why}.${hint}`;
}

/**
 * Hash keeps guard names bounded and path-safe whatever the key or nesting
 * depth. Exported for tests (simulating a reclaimer that died holding one).
 */
export function guardPath(lockPath: string, target: string, key: string): string {
  const digest = createHash("sha256")
    .update(`${path.basename(target)}\0${key}`)
    .digest("hex")
    .slice(0, 32);
  return `${lockPath}.supersede-${digest}`;
}

/** Publish `content` at `target` atomically-with-content; false when `target` exists. */
async function linkExclusive(target: string, content: string): Promise<boolean> {
  const tempPath = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  await fsPromises.writeFile(tempPath, content);
  try {
    await fsPromises.link(tempPath, target);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** Replace `target` in place (never absent) with `content`, unless `abort()` says otherwise. */
async function replaceWith(target: string, content: string, abort?: () => boolean): Promise<void> {
  const tempPath = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  await fsPromises.writeFile(tempPath, content);
  try {
    if (abort?.() === true) {
      throw new Error("replacement aborted");
    }
    await fsPromises.rename(tempPath, target);
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Nesting bound: each level needs another reclaimer to have died mid-takeover. */
const MAX_SUPERSEDE_DEPTH = 8;

/**
 * Replace `target` (the lock, or a guard) whose generation `observed` was
 * judged dead, with our record. Returns true when `target` now carries our
 * token. The caller keeps `token` registered in liveTokens throughout.
 *
 * Protocol: (1) exclusively link our record at guard = guardPath(target,
 * key); on EEXIST the guard's own record is judged by judge(): live ⇒ back
 * off; dead ⇒ take the guard over by this same protocol (recursion keyed by
 * the dead guard's generation). (2) Holding the guard, re-read `target`;
 * continue only if it still carries generation `key`. (3) rename our record
 * over it (the path is never absent, so no link-create can slip in) and
 * confirm. (4) Delete the guard.
 *
 * Safety. Every write this build makes to a file carrying generation K is
 * made (a) by K's owner (renewal/release of the lock, deletion of its own
 * guard), (b) by the process holding guardPath(file, K) after re-reading K,
 * or (c) by link-create, which needs the path absent. judge() declares K dead
 * only when K's owner can never write again (its pid is gone, it predates
 * this boot, or it is an unregistered token of this process). So once we
 * hold the guard and re-read K, the file cannot change before our rename:
 * (a) is impossible, (b) is us — our guard record is live, so it is never
 * superseded — and (c) needs absence. Hence:
 * - Two concurrent reclaimers of one dead lock: link() lets one win the
 *   guard; the loser sees a live guard owner and backs off, or (if it arrives
 *   after the guard was deleted) re-reads a new generation and aborts.
 * - A reclaimer stalled at any step: before the guard it holds nothing; while
 *   holding it, others refuse (an availability cost) and the file still
 *   carries K; after its rename it is simply a stalled live holder.
 * - The owner renewing/releasing concurrently: a live owner's generation is
 *   never judged dead, so no takeover of it exists; its own token check
 *   before writing cannot be invalidated by this build.
 * - A reclaimer dying mid-protocol: its guard's owner is now dead, so the
 *   guard is superseded the same way; if it died after its rename, the lock
 *   carries its dead token and is taken over as a new generation. Guards left
 *   for generations that no longer exist are inert (tokens never repeat).
 *
 * The former mkdir mutex is no longer entered. Its age-based break let two
 * reclaimers both win, it guarded nothing the guard does not, and entering it
 * for older builds' sake would only suggest a mixed-version guarantee we do
 * not give (older builds steal stalled holders by age regardless).
 */
async function supersede(
  lockPath: string,
  target: string,
  observed: Generation,
  content: string,
  token: string,
  depth: number,
  onBlocked: (blocker: Blocker) => void
): Promise<boolean> {
  const guard = guardPath(lockPath, target, observed.key);
  if (!(await linkExclusive(guard, content))) {
    const rival = await observe(guard);
    if (rival.kind === "absent") {
      return false; // Finished meanwhile: retry from a fresh observation.
    }
    if (rival.kind === "unreadable") {
      onBlocked({ why: `its takeover guard ${guard} cannot be read (${rival.code})` });
      return false;
    }
    const verdict = judge(rival);
    if (!verdict.dead) {
      onBlocked({
        holder: rival.kind === "holder" ? rival.holder : undefined,
        why: `another process is taking it over and ${verdict.why}`,
      });
      return false;
    }
    if (
      depth >= MAX_SUPERSEDE_DEPTH ||
      !(await supersede(lockPath, guard, rival, content, token, depth + 1, onBlocked))
    ) {
      return false;
    }
  }
  try {
    const current = await observe(target);
    if ((current.kind !== "holder" && current.kind !== "corrupt") || current.key !== observed.key) {
      return false; // A new generation: not ours to replace.
    }
    await replaceWith(target, content);
    const confirmed = await observe(target);
    return confirmed.kind === "holder" && confirmed.key === token;
  } finally {
    await fsPromises.rm(guard, { force: true }).catch(() => undefined);
  }
}

/** One acquisition attempt with a registered `token`. */
async function tryTake(
  lockPath: string,
  token: string,
  onBlocked: (blocker: Blocker) => void
): Promise<boolean> {
  const content = holderRecord(token);
  if (await linkExclusive(lockPath, content)) {
    const confirmed = await observe(lockPath);
    // Only an older build's age-based reclaim can replace a fresh create.
    return confirmed.kind === "holder" && confirmed.key === token;
  }
  const current = await observe(lockPath);
  if (current.kind === "absent") {
    return false; // Released meanwhile: retry.
  }
  if (current.kind === "unreadable") {
    onBlocked({ why: `the lock file cannot be read (${current.code})` });
    return false;
  }
  const verdict = judge(current);
  if (!verdict.dead) {
    onBlocked({ holder: current.kind === "holder" ? current.holder : undefined, why: verdict.why });
    return false;
  }
  return supersede(lockPath, lockPath, current, content, token, 0, onBlocked);
}

function sleepWithJitter(baseMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const delay = baseMs + Math.floor(Math.random() * baseMs);
    if (signal === undefined) {
      setTimeout(resolve, delay);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Acquire the lock; returns the (idempotent) release function. */
export async function acquireCrossProcessLock(
  options: CrossProcessLockOptions
): Promise<() => Promise<void>> {
  const { lockPath, acquireTimeoutMs, staleMs, timeoutMessage, signal } = options;
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + acquireTimeoutMs;

  // RENEWAL exists for builds predating #4415 only (see staleMs). No mutex:
  // this build never takes over a live owner's generation, so the owner's
  // check-then-rename cannot clobber a successor from this build.
  const startRenewal = (token: string): (() => Promise<void>) => {
    let stopped = false;
    // The in-flight tick, joined by stop: clearing the interval only stops
    // FUTURE ticks, and a tick past its token check could otherwise rename a
    // record back into place after release unlinked it.
    let inFlight: Promise<void> | undefined;
    const interval = setInterval(
      () => {
        if (stopped || inFlight !== undefined) {
          return;
        }
        inFlight = (async () => {
          const current = await observe(lockPath);
          if (current.kind === "holder" && current.key === token) {
            await replaceWith(lockPath, holderRecord(token), () => stopped);
          }
        })()
          .catch(() => undefined) // Best-effort: a missed renewal only matters to older builds.
          .finally(() => {
            inFlight = undefined;
          });
      },
      Math.max(250, Math.floor(staleMs / 4))
    );
    interval.unref?.();
    return async () => {
      stopped = true;
      clearInterval(interval);
      await inFlight;
    };
  };

  const releaseFor = (token: string): (() => Promise<void>) => {
    const stopRenewal = startRenewal(token);
    const release = async () => {
      try {
        await stopRenewal();
        for (let attempt = 0; attempt < 40; attempt++) {
          const current = await observe(lockPath);
          if (
            current.kind === "absent" ||
            (current.kind !== "unreadable" && current.key !== token)
          ) {
            return; // Not ours anymore: nothing to delete.
          }
          if (current.kind === "holder") {
            // Check-then-unlink needs no mutex: while this process lives and
            // the token is registered, no build of this version replaces it.
            // A transiently failing unlink (Windows file lock, antivirus) is
            // retried: a record left behind reads as live to every sibling
            // until this process exits.
            try {
              await fsPromises.rm(lockPath, { force: true });
              return;
            } catch {
              // Retry below.
            }
          }
          await sleepWithJitter(25);
        }
        // Gave up: the record leaks. Retiring the token (finally) makes it
        // reclaimable in this process; siblings refuse it until we exit.
      } finally {
        liveTokens.delete(token);
      }
    };
    // Idempotent: concurrent callers share one check-then-unlink sequence.
    let releasing: Promise<void> | undefined;
    return () => (releasing ??= release());
  };

  let blocker: Blocker | undefined;
  for (;;) {
    if (signal?.aborted) {
      throw new Error("Lock acquisition was aborted");
    }
    const token = randomBytes(16).toString("hex");
    liveTokens.add(token); // Before any publication: see liveTokens.
    let owned = false;
    try {
      owned = await tryTake(lockPath, token, (b) => {
        blocker = b;
      });
    } finally {
      if (!owned) {
        liveTokens.delete(token); // Every write of this attempt has settled.
      }
    }
    if (owned) {
      return releaseFor(token);
    }
    // `>=`: a zero timeout is a try-lock (batch acquirers release earlier
    // locks immediately on contention) and must reject without sleeping even
    // when the failed attempt completed within the deadline's millisecond.
    if (Date.now() >= deadline) {
      throw new CrossProcessLockTimeoutError(
        `${timeoutMessage} ${describeBlocker(lockPath, blocker)}`
      );
    }
    await sleepWithJitter(250, signal);
  }
}
