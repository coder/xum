/**
 * The disk rule of the in-memory loop proof (agentLoop.inMemory.hostProof.ts): which host trap
 * rows the proof allows. A pure function of the rows, so agentLoop.inMemory.diskRule.test.ts
 * checks each branch in the normal unit suite.
 */
import * as path from "node:path";
import type { HostTrapRow } from "./hostTrap/hostTrap.testHarness";
import { isPathInsideDir } from "@/node/utils/pathUtils";

// isPathInsideDir resolves both paths first, so a `..` segment cannot leave the root.
const isInside = isPathInsideDir;

interface DiskRule {
  configRoot: string;
  /** Under the config root, but on test layers: the session dirs and the worktrees. */
  layered: string[];
  logsDir: string;
}

function allowedPath(rule: DiskRule, api: string, target: string): boolean {
  return (
    (isInside(rule.configRoot, target) && !rule.layered.some((dir) => isInside(dir, target))) ||
    (api === "fs.lstatSync" && isInside(target, rule.configRoot)) ||
    isLogSinkPath(rule.logsDir, target)
  );
}

/** The log sink's own paths: its dir, mux.log and the rotated mux.<n>.log. Nothing else in the dir. */
function isLogSinkPath(logsDir: string, target: string): boolean {
  const resolved = path.resolve(target);
  if (resolved === path.resolve(logsDir)) return true;
  return (
    path.dirname(resolved) === path.resolve(logsDir) &&
    /^mux(\.\d+)?\.log$/.test(path.basename(resolved))
  );
}

/** Calls that may write stdout or stderr by fd: the console sink. Not net.connect(1). */
const STD_FD_APIS = /^(fs\.|Bun\.(file|write)$)/;

/**
 * The disk rule of claim 4.3: Config's calls under its root and the log file. Nothing else.
 * - Config and its stores (config.json, providers.jsonc, secrets.json, the plugin registry and
 *   journals of the managed container) stay on the disk until #7209. Config checks each
 *   ancestor of its root for links (lstat). The session dirs and worktrees under the root are
 *   not Config's: a call there fails the proof.
 * - The log sink writes XUM_ROOT/logs/mux.log (#7209), and its console sink writes stdout. The
 *   file stream writes by fd. An fd row is allowed for stdout and stderr, or when the trap saw
 *   the fd open while armed and its path passes this rule. An fd opened before arm() fails.
 */
export function allowedOnDisk(configRoot: string, logsDir: string): (row: HostTrapRow) => boolean {
  const rule: DiskRule = {
    configRoot,
    layered: [path.join(configRoot, "sessions"), path.join(configRoot, "src")],
    logsDir,
  };
  return (row) => {
    // A two-path call (rename, copyFile, ...) does host I/O at both paths.
    if (row.arg2 !== undefined && !allowedPath(rule, row.api, row.arg2)) return false;
    if (!/^fd\/\d+$/.test(row.arg)) return allowedPath(rule, row.api, row.arg);
    if (row.arg === "fd/1" || row.arg === "fd/2") return STD_FD_APIS.test(row.api);
    return row.fdPath !== undefined && allowedPath(rule, row.api, row.fdPath);
  };
}
