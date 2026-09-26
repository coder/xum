/**
 * Holder liveness judgment shared by the two cross-process lock kits
 * (crossProcessLock, fileLock), so both apply one death rule (#4415).
 *
 * DEPLOYMENT CONTRACT (user decision, #4415): every cooperating Xum process
 * sharing one XUM_ROOT runs in one PID domain; a replaced domain (restarted
 * or replaced container, rebooted host) is retired and cannot resume before
 * a new one accesses the root. Concurrent cross-domain sharing is
 * unsupported, not prevented.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import * as os from "node:os";

/**
 * Identity of the process occupying `pid` right now, uncached, or null when
 * the platform offers no probe (or the process vanished mid-probe). Callers
 * judging liveness must never compare against a cached birth of a previous
 * pid incarnation (fileLock's getProcessBirth caches for token creation).
 */
export function probeProcessBirth(pid: number): string | null {
  // Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot) is
  // unique per pid incarnation. The comm field can embed spaces/parens, so
  // fields are parsed after the LAST ')' where the format is well-defined
  // (state is field 3 → starttime is offset 19).
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = rest[19];
    if (starttime !== undefined && /^\d+$/.test(starttime)) {
      return `linux-ticks:${starttime}`;
    }
  } catch {
    // Not Linux (or the process vanished); try the portable fallback.
  }
  // macOS/BSD: full start timestamp, stable per process incarnation.
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
    const line = out.stdout?.trim();
    if (out.status === 0 && line !== undefined && line.length > 0) {
      return `ps-lstart:${line}`;
    }
  } catch {
    // ps unavailable (e.g. Windows): undeterminable.
  }
  return null;
}

/**
 * Only Linux starttime is comparable evidence: other encodings (macOS
 * `ps -o lstart`) depend on the probing process's locale/timezone, so a
 * mismatch would not prove a different process.
 */
export function linuxBirth(pid: number): string | null {
  const birth = probeProcessBirth(pid);
  return birth?.startsWith("linux-ticks:") ? birth : null;
}

/**
 * Process identity recorded by holders. Linux: `birth` is the /proc
 * starttime and `bootId`/`pidNs` define the PID domain in which a pid is
 * meaningful. `machineId` and `platform` count only when both sides have
 * them and they DIFFER (a positively different domain; see judgeHolder()).
 * `hostname` is diagnostic only: macOS hostnames change with networks, so
 * refusing on a mismatch would keep a crashed holder's lock refused forever.
 */
export interface ProcessIdentity {
  birth: string | null;
  bootId: string | null;
  pidNs: string | null;
  machineId: string | null;
  platform: string | null;
  hostname: string | null;
}

function readTrimmed(file: string): string | null {
  try {
    const value = readFileSync(file, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

let selfIdentity: ProcessIdentity | undefined;

export function getSelfIdentity(): ProcessIdentity {
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
export function setSelfIdentityForTests(identity: ProcessIdentity | undefined): void {
  selfIdentity = identity;
}

/** Parse a recorded identity object; null fields when absent or malformed. */
export function parseProcessIdentity(record: Record<string, unknown>): ProcessIdentity {
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    birth: str(record.birth),
    bootId: str(record.bootId),
    pidNs: str(record.pidNs),
    machineId: str(record.machineId),
    platform: str(record.platform),
    hostname: str(record.hostname),
  };
}

export type Verdict = { dead: true } | { dead: false; why: string };
const DEAD: Verdict = { dead: true };
const refuse = (why: string): Verdict => ({ dead: false, why });

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM = exists but owned by another user; only ESRCH proves absence.
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export interface HolderEvidence {
  pid: number;
  /** Recorded identity; absent on legacy records written before #4415. */
  identity?: ProcessIdentity;
  /** Legacy records only: a recorded birth (fileLock tokens carried one). */
  legacyBirth?: string | null;
}

/**
 * Death proof for a lock or guard holder. Anything not judged dead is live
 * or indeterminate and is never reclaimed; age never reclaims.
 *
 * 1. A POSITIVELY different PID domain is retired by contract ⇒ dead:
 *    machine-ids both present and different; platforms both recorded and
 *    different; on Linux (both sides naming boot id and PID namespace) a
 *    different boot id or namespace. Hostname is diagnostic, not evidence.
 * 2. UNKNOWN domain evidence is not dead ⇒ refuse: a record missing its
 *    boot id/namespace while we have ours, or naming one we cannot read.
 * 3. Same domain (proven on Linux): ESRCH or a different starttime ⇒ dead;
 *    a live pid (or EPERM) ⇒ refuse.
 * 3a. macOS/Windows (no qualified PID-domain identity) and legacy records:
 *    ASSUMES the holder shares this host's PID domain (the contract). ESRCH ⇒
 *    dead; a live pid (or EPERM) ⇒ refuse, except that a legacy Linux birth
 *    that differs from the pid's current one ⇒ dead (pid reuse).
 * 4. Same pid (in a domain that passed the checks above) is this process or a
 *    previous one that had our pid: live only while `ownTokenLive` (the
 *    caller's registry of tokens this process may still write).
 */
export function judgeHolder(holder: HolderEvidence, ownTokenLive: boolean): Verdict {
  const { pid, identity: record } = holder;
  if (record === undefined) {
    if (pidGone(pid)) {
      return DEAD;
    }
    const recorded = holder.legacyBirth ?? null;
    const current = recorded?.startsWith("linux-ticks:") ? linuxBirth(pid) : null;
    return current !== null && current !== recorded
      ? DEAD
      : refuse("it was written by an older Xum build and that pid is running");
  }
  const self = getSelfIdentity();
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  // Positively different PID domain: retired by the deployment contract.
  if (differs(record.platform, self.platform) || differs(record.machineId, self.machineId)) {
    return DEAD;
  }
  const linuxDomain = self.bootId !== null && self.pidNs !== null;
  if (linuxDomain) {
    if (record.bootId === null || record.pidNs === null) {
      return refuse("its boot or PID namespace is unknown");
    }
    if (record.bootId !== self.bootId || record.pidNs !== self.pidNs) {
      return DEAD;
    }
  } else if (record.bootId !== null || record.pidNs !== null) {
    return refuse("it names a PID domain this process cannot verify");
  }
  if (pid === process.pid) {
    return ownTokenLive ? refuse("it is held by this process") : DEAD;
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
