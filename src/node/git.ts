import * as fs from "fs";
import * as path from "path";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { log } from "./services/log";

/**
 * Remove stale .git/index.lock file if it exists and is old.
 *
 * Git creates index.lock during operations that modify the index. If a process
 * is killed mid-operation (user cancel, crash, terminal closed), the lock file
 * gets orphaned. This is common in Xum when git operations are interrupted.
 *
 * We only remove locks older than STALE_LOCK_AGE_MS to avoid removing locks
 * from legitimately running processes.
 */
const STALE_LOCK_AGE_MS = 5000; // 5 seconds

export function cleanStaleLock(repoPath: string): void {
  const lockPath = path.join(repoPath, ".git", "index.lock");
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_LOCK_AGE_MS) {
      fs.unlinkSync(lockPath);
      log.info(`Removed stale git index.lock (age: ${Math.round(ageMs / 1000)}s) at ${lockPath}`);
    }
  } catch {
    // Lock doesn't exist or can't be accessed - this is fine
  }
}

export async function listLocalBranches(
  projectPath: string,
  options?: ExecFileAsyncOptions
): Promise<string[]> {
  using proc = execFileAsync(
    "git",
    ["-C", projectPath, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    options
  );
  const { stdout } = await proc.result;
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export async function getCurrentBranch(
  projectPath: string,
  options?: ExecFileAsyncOptions
): Promise<string | null> {
  try {
    using proc = execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
      options
    );
    const { stdout } = await proc.result;
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

const FALLBACK_TRUNK_CANDIDATES = ["main", "master", "trunk", "develop", "default"];

export async function detectDefaultTrunkBranch(
  projectPath: string,
  branches?: string[]
): Promise<string> {
  const branchList = branches ?? (await listLocalBranches(projectPath));

  if (branchList.length === 0) {
    throw new Error(`No branches available in repository ${projectPath}`);
  }

  const branchSet = new Set(branchList);
  const currentBranch = await getCurrentBranch(projectPath);

  if (currentBranch && branchSet.has(currentBranch)) {
    return currentBranch;
  }

  for (const candidate of FALLBACK_TRUNK_CANDIDATES) {
    if (branchSet.has(candidate)) {
      return candidate;
    }
  }

  return branchList[0];
}
