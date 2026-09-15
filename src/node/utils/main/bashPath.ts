/**
 * Platform-specific bash path resolution
 *
 * On Unix/Linux/macOS, bash is in PATH by default.
 * On Windows, xum requires Git for Windows' Git Bash (WSL is not supported).
 */

import { execSync, type ExecSyncOptionsWithStringEncoding } from "child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "fs";
import path from "path";
import { getErrorMessage } from "@/common/utils/errors";

const WIN_PATH = path.win32;

const BASH_PATH_ERROR_COOLDOWN_MS = 30_000;

let cachedBashPath: string | null = null;
let cachedBashPathError: { message: string; lastCheckedMs: number } | null = null;
let cachedUnixBashPath: string | null = null;

type ExecSyncFn = (command: string, options: ExecSyncOptionsWithStringEncoding) => string;
type ExistsSyncFn = (path: string) => boolean;

interface FindWindowsBashParams {
  env: NodeJS.ProcessEnv;
  execSyncFn: ExecSyncFn;
  existsSyncFn: ExistsSyncFn;
}

const defaultExecSync: ExecSyncFn = (command, options) => execSync(command, options);

function parseWhereOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isWslLauncherPath(p: string): boolean {
  const normalized = WIN_PATH.normalize(p).toLowerCase();
  return (
    normalized.endsWith("\\windows\\system32\\bash.exe") ||
    normalized.endsWith("\\windows\\system32\\wsl.exe")
  );
}

/**
 * Ensure the bash we found appears to come from a Git for Windows install.
 *
 * (We avoid launching WSL shells via `C:\\Windows\\System32\\bash.exe`.)
 */
function looksLikeGitForWindowsBash(bashPath: string, existsSyncFn: ExistsSyncFn): boolean {
  if (isWslLauncherPath(bashPath)) {
    return false;
  }

  const normalized = WIN_PATH.normalize(bashPath);
  const lower = normalized.toLowerCase();

  if (lower.endsWith("\\usr\\bin\\bash.exe")) {
    const root = WIN_PATH.dirname(WIN_PATH.dirname(WIN_PATH.dirname(normalized)));
    return existsSyncFn(WIN_PATH.join(root, "cmd", "git.exe"));
  }

  if (lower.endsWith("\\bin\\bash.exe")) {
    const root = WIN_PATH.dirname(WIN_PATH.dirname(normalized));
    return existsSyncFn(WIN_PATH.join(root, "cmd", "git.exe"));
  }

  // Best-effort: walk up a few levels looking for `cmd/git.exe`.
  let dir = WIN_PATH.dirname(normalized);
  for (let i = 0; i < 4; i++) {
    if (existsSyncFn(WIN_PATH.join(dir, "cmd", "git.exe"))) {
      return true;
    }

    const parent = WIN_PATH.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return false;
}

function findGitRootFromGitExePath(gitExePath: string, existsSyncFn: ExistsSyncFn): string | null {
  let dir = WIN_PATH.dirname(WIN_PATH.dirname(WIN_PATH.normalize(gitExePath)));

  for (let i = 0; i < 4; i++) {
    if (existsSyncFn(WIN_PATH.join(dir, "cmd", "git.exe"))) {
      return dir;
    }

    const parent = WIN_PATH.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

/**
 * Find bash executable path on Windows.
 *
 * We strongly prefer Git Bash (Git for Windows) and explicitly avoid WSL launchers.
 */
function findWindowsBash(params: FindWindowsBashParams): string | null {
  const { env, execSyncFn, existsSyncFn } = params;

  const gitRoots: string[] = [
    // Git for Windows default paths
    "C:\\Program Files\\Git",
    "C:\\Program Files (x86)\\Git",
    // Chocolatey installation
    "C:\\tools\\git",
  ];

  // User-local Git installation
  if (env.LOCALAPPDATA) {
    gitRoots.push(WIN_PATH.join(env.LOCALAPPDATA, "Programs", "Git"));
  }

  // Scoop installation
  if (env.USERPROFILE) {
    gitRoots.push(WIN_PATH.join(env.USERPROFILE, "scoop", "apps", "git", "current"));
  }

  // Prefer known Git for Windows install locations.
  const commonPaths = gitRoots.flatMap((root) => [
    WIN_PATH.join(root, "bin", "bash.exe"),
    WIN_PATH.join(root, "usr", "bin", "bash.exe"),
  ]);

  for (const bashPath of commonPaths) {
    if (existsSyncFn(bashPath) && looksLikeGitForWindowsBash(bashPath, existsSyncFn)) {
      return bashPath;
    }
  }

  // Also check if Git is in PATH and derive bash path from it.
  try {
    const result = execSyncFn("where git", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    for (const gitExePath of parseWhereOutput(result)) {
      if (!existsSyncFn(gitExePath)) {
        continue;
      }

      const gitRoot = findGitRootFromGitExePath(gitExePath, existsSyncFn);
      if (!gitRoot) {
        continue;
      }

      const candidateBashPaths = [
        WIN_PATH.join(gitRoot, "bin", "bash.exe"),
        WIN_PATH.join(gitRoot, "usr", "bin", "bash.exe"),
      ];

      for (const bashPath of candidateBashPaths) {
        if (existsSyncFn(bashPath) && looksLikeGitForWindowsBash(bashPath, existsSyncFn)) {
          return bashPath;
        }
      }
    }
  } catch {
    // Git not in PATH
  }

  // Fall back to searching for bash in PATH, skipping WSL.
  try {
    const result = execSyncFn("where bash", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    for (const bashPath of parseWhereOutput(result)) {
      if (!existsSyncFn(bashPath)) {
        continue;
      }

      if (looksLikeGitForWindowsBash(bashPath, existsSyncFn)) {
        return bashPath;
      }
    }
  } catch {
    // Not in PATH
  }

  return null;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) {
      return false;
    }
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve bash to an absolute path on Unix.
 *
 * Spawning the bare name "bash" makes every child PATH-search after fork (one failed
 * execve per PATH entry ahead of bash) while the parent blocks on libuv's exec-status
 * pipe, so we resolve once here and cache the result for the process lifetime.
 */
function findUnixBash(env: NodeJS.ProcessEnv): string {
  const pathEntries = (env.PATH ?? "").split(path.delimiter);
  for (const dir of pathEntries) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, "bash");
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  if (isExecutableFile("/bin/bash")) {
    return "/bin/bash";
  }

  return "bash";
}

export interface GetBashPathForPlatformParams {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execSyncFn?: ExecSyncFn;
  existsSyncFn?: ExistsSyncFn;
}

export function getBashPathForPlatform(params: GetBashPathForPlatformParams): string {
  if (params.platform !== "win32") {
    return findUnixBash(params.env ?? process.env);
  }

  const bashPath = findWindowsBash({
    env: params.env ?? process.env,
    execSyncFn: params.execSyncFn ?? defaultExecSync,
    existsSyncFn: params.existsSyncFn ?? existsSync,
  });

  if (!bashPath) {
    throw new Error(
      "Git Bash not found. On Windows, xum requires Git for Windows (Git Bash). WSL is not supported. Install Git for Windows from https://git-scm.com/download/win"
    );
  }

  return bashPath;
}

/**
 * Get the bash executable path for the current platform
 *
 * @returns Path to bash executable. On Unix/macOS returns the absolute path of the first
 *          `bash` on PATH (falling back to /bin/bash, then bare "bash"),
 *          on Windows returns full path to Git Bash if found.
 * @throws Error if Git Bash cannot be found on Windows
 */
export function getBashPath(
  params: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execSyncFn?: (command: string, options: ExecSyncOptionsWithStringEncoding) => string;
    existsSyncFn?: (path: string) => boolean;
    nowFn?: () => number;
  } = {}
): string {
  const platform = params.platform ?? process.platform;

  if (platform !== "win32") {
    cachedUnixBashPath ??= getBashPathForPlatform({ platform, env: params.env });
    return cachedUnixBashPath;
  }

  // Use cached path if available
  if (cachedBashPath !== null) {
    return cachedBashPath;
  }

  const nowFn = params.nowFn ?? Date.now;
  const now = nowFn();
  if (
    cachedBashPathError &&
    now - cachedBashPathError.lastCheckedMs < BASH_PATH_ERROR_COOLDOWN_MS
  ) {
    throw new Error(cachedBashPathError.message);
  }

  try {
    cachedBashPath = getBashPathForPlatform({
      platform,
      env: params.env,
      execSyncFn: params.execSyncFn,
      existsSyncFn: params.existsSyncFn,
    });
    cachedBashPathError = null;
    return cachedBashPath;
  } catch (error) {
    const message = getErrorMessage(error);
    cachedBashPathError = { message, lastCheckedMs: now };
    throw error;
  }
}

/** Reset cached bash path (used by tests). */
export function resetBashPathCache(): void {
  cachedBashPath = null;
  cachedBashPathError = null;
  cachedUnixBashPath = null;
}

/**
 * Check if bash is available on the system
 *
 * @returns true if bash is available, false otherwise
 */
export function isBashAvailable(): boolean {
  try {
    getBashPath();
    return true;
  } catch {
    return false;
  }
}
