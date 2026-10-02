import assert from "@/common/utils/assert";
import * as fs from "fs/promises";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Whether this host can probe a background process group. On Windows, background commands run
 * under Git Bash (MSYS), whose PIDs are not Windows PIDs, so readers fall back to trusting the
 * exit_code record alone there (Windows support for the group protocol is unresolved).
 */
export const HOST_PROCESS_GROUPS_PROBEABLE = process.platform !== "win32";

/**
 * Whether host process group `pgid` still has a live (non-zombie) member. The host-side twin of
 * the shell `__xum_glive` (src/node/runtime/backgroundCommands.ts): it only observes and never
 * signals the group, and it fails closed (an inconclusive answer is "live").
 *
 * ESRCH from `kill(-pgid, 0)` proves the group is gone. Any other answer (success, EPERM) counts
 * as live, except on Linux, where /proc decides: an unreaped zombie keeps `kill(-pgid, 0)`
 * succeeding (Xum in a container whose PID 1 does not reap), and a group of zombies is over.
 * /proc cannot decide when it hides other users' processes (`hidepid`, `subset=pid`: a member
 * that changed UID would be invisible) or when an entry exists but cannot be read.
 */
export async function hostProcessGroupIsLive(pgid: number): Promise<boolean> {
  assert(HOST_PROCESS_GROUPS_PROBEABLE, "host process groups are not probeable on this platform");
  assert(Number.isSafeInteger(pgid) && pgid > 1, `invalid process group id ${pgid}`);
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if (isErrnoWithCode(error, "ESRCH")) return false;
  }
  if (process.platform !== "linux") return true;
  if (await procHidesOtherUsers()) return true;
  return linuxGroupHasNonZombieMember(pgid);
}

/** Whether /proc is mounted with an option that hides other users' processes. */
async function procHidesOtherUsers(): Promise<boolean> {
  let mountinfo: string;
  try {
    mountinfo = await fs.readFile("/proc/self/mountinfo", "utf-8");
  } catch {
    return true; // Cannot tell: assume hidden (fail closed).
  }
  return mountinfo.split("\n").some(
    (line) =>
      line.includes(" /proc ") &&
      line.includes(" - proc ") &&
      // Any hidepid mode other than 0/off hides some processes (1, 2, 4, noaccess,
      // invisible, ptraceable, and modes added later).
      /(?:hidepid=(?!(?:0|off)(?:,|$))|subset=pid(?:,|$))/.test(line)
  );
}

async function linuxGroupHasNonZombieMember(pgid: number): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir("/proc");
  } catch {
    return true; // Cannot scan: live (callers then wait or refuse, never settle).
  }
  const wanted = String(pgid);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = await fs.readFile(`/proc/${name}/stat`, "utf-8");
    } catch (error) {
      // The process ended during the scan; any other failure leaves the answer open.
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ESRCH")) continue;
      return true;
    }
    // Fields after comm, which may contain spaces and ") ": state, ppid, pgrp, ...
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    if (fields[2] === wanted && !["Z", "X", "x"].includes(fields[0])) return true;
  }
  return false;
}
