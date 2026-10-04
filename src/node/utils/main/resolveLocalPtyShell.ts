import { spawnSync } from "child_process";
import { accessSync, constants, statSync } from "fs";
import path from "path";

import { DEFAULT_WINDOWS_PATHEXT } from "@/constants/windowsPathExt";
import { getBashPath } from "@/node/utils/main/bashPath";

export interface ResolvedPtyShell {
  command: string;
  args: string[];
}

export interface ResolveLocalPtyShellParams {
  /** User-configured shell from config.json (highest priority when valid). */
  configuredShell: string | undefined;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isCommandAvailable: (command: string) => boolean;
  isPathAccessible?: (path: string) => boolean;
  getBashPath: () => string;
}

function defaultIsCommandAvailable(platform: NodeJS.Platform): (command: string) => boolean {
  return (command: string) => {
    if (!command) return false;

    try {
      const result = spawnSync(platform === "win32" ? "where" : "which", [command], {
        stdio: "ignore",
      });
      return result.status === 0;
    } catch {
      return false;
    }
  };
}

/**
 * Check whether a path-like shell candidate is a real executable file.
 * - Must be a regular file (rejects directories, symlink-to-dir, etc.)
 * - On POSIX: must have execute permission for the current user.
 * - On Windows: must have a recognized executable extension (PATHEXT-aware).
 */
function defaultIsPathAccessible(shellPath: string): boolean {
  try {
    const stat = statSync(shellPath);
    if (!stat.isFile()) {
      return false;
    }

    if (process.platform !== "win32") {
      // X_OK checks execute permission for the current user.
      accessSync(shellPath, constants.X_OK);
      return true;
    }

    // On Windows, executable status is determined by file extension.
    const ext = path.win32.extname(shellPath).toLowerCase();
    if (!ext) {
      return false;
    }

    const pathExtEnv = process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT;
    const allowedExts = new Set(
      pathExtEnv
        .split(";")
        .map((candidateExt) => candidateExt.toLowerCase().trim())
        .filter(Boolean)
    );

    return allowedExts.has(ext);
  } catch {
    return false;
  }
}

function isPathLikeShell(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

/** Resolve the Windows fallback shell command: prefer COMSPEC when valid, otherwise cmd.exe. */
function getWindowsFallbackCommand(
  env: NodeJS.ProcessEnv,
  isPathAccessible: (candidatePath: string) => boolean
): string {
  const comspec = env.COMSPEC?.trim();
  if (!comspec) {
    return "cmd.exe";
  }

  // If COMSPEC is a path-like value that doesn't validate, fall back to bare cmd.exe
  // so the OS can resolve it via PATH.
  if (isPathLikeShell(comspec) && !isPathAccessible(comspec)) {
    return "cmd.exe";
  }

  return comspec;
}

function isCandidateAvailable(
  command: string,
  deps: {
    isCommandAvailable: (candidateCommand: string) => boolean;
    isPathAccessible: (candidatePath: string) => boolean;
  }
): boolean {
  if (!command) {
    return false;
  }

  if (isPathLikeShell(command)) {
    return deps.isPathAccessible(command);
  }

  return deps.isCommandAvailable(command);
}

function looksLikeWslShell(envShell: string): boolean {
  // WSL (and other Unix-like environments) often surface POSIX-y paths like `/bin/bash`.
  // Those paths don't exist on Windows hosts, so treat them as WSL and ignore.
  if (envShell.startsWith("/")) {
    return true;
  }

  const normalized = envShell.replace(/\//g, "\\").toLowerCase();
  const base = path.win32.basename(normalized);
  return (
    normalized === "wsl" ||
    base === "wsl.exe" ||
    normalized === "bash" ||
    normalized === "bash.exe" ||
    normalized.endsWith("\\windows\\system32\\bash.exe")
  );
}

/**
 * Resolve the best shell to use for a *local* PTY session.
 *
 * We keep this as a small, mostly-pure helper so it can be unit-tested without
 * mutating `process.platform` / `process.env`.
 */
export function resolveLocalPtyShell(
  params: Partial<ResolveLocalPtyShellParams> = {}
): ResolvedPtyShell {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const isCommandAvailable = params.isCommandAvailable ?? defaultIsCommandAvailable(platform);
  const isPathAccessible = params.isPathAccessible ?? defaultIsPathAccessible;
  const getBashPathFn = params.getBashPath ?? getBashPath;

  const candidates: ResolvedPtyShell[] = [];

  // User-configured shell from config.json stays highest priority, but only when valid.
  const configuredShell = params.configuredShell?.trim();
  if (configuredShell) {
    candidates.push({ command: configuredShell, args: [] });
  }

  // `process.env.SHELL` can be present-but-empty (""), especially in packaged apps.
  // Treat empty/whitespace as "unset".
  const envShell = env.SHELL?.trim();
  if (envShell) {
    // On Windows, `SHELL=bash` often routes to WSL (via System32\\bash.exe).
    // Ignore WSL shells and fall back to Git Bash/pwsh/cmd selection below.
    if (platform !== "win32" || !looksLikeWslShell(envShell)) {
      candidates.push({ command: envShell, args: [] });
    }
  }

  if (platform === "win32") {
    // Prefer Git Bash when available (works well with repo tooling).
    try {
      const bashPath = getBashPathFn().trim();
      if (bashPath) {
        candidates.push({ command: bashPath, args: ["--login", "-i"] });
      }
    } catch {
      // Git Bash not available; fall back to PowerShell / cmd.
    }

    candidates.push({ command: "pwsh", args: [] });
    candidates.push({ command: "powershell", args: [] });

    candidates.push({ command: getWindowsFallbackCommand(env, isPathAccessible), args: [] });
  } else if (platform === "darwin") {
    candidates.push({ command: "/bin/zsh", args: [] });
  } else {
    candidates.push({ command: "/bin/bash", args: [] });
  }

  for (const candidate of candidates) {
    if (isCandidateAvailable(candidate.command, { isCommandAvailable, isPathAccessible })) {
      return candidate;
    }
  }

  // Last-resort fallback if all candidates above are unavailable.
  // Keep platform-native: cmd.exe on Windows, /bin/zsh on macOS, /bin/bash elsewhere.
  if (platform === "win32") {
    return { command: getWindowsFallbackCommand(env, isPathAccessible), args: [] };
  }
  if (platform === "darwin") {
    return { command: "/bin/zsh", args: [] };
  }
  return { command: "/bin/bash", args: [] };
}
