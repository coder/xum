import { accessSync, constants, statSync } from "fs";
import * as path from "path";
import { assert } from "@/common/utils/assert";
import { DEFAULT_WINDOWS_PATHEXT } from "@/constants/windowsPathExt";

function isRegularFile(candidate: string): boolean {
  try {
    // statSync follows symlinks, so a symlink to an executable counts like `which` does.
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate: string): boolean {
  if (!isRegularFile(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * process.cwd() throws ENOENT once the backend's launch directory is deleted. Only relative and
 * empty PATH entries (and the Windows cwd search) need it, so absolute entries still resolve.
 */
function currentDirectoryOrNull(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/**
 * Resolve an executable name through PATH in-process, like `which` (POSIX) or `where` (Windows).
 *
 * Spawning `which`/`where` blocks the event loop for several ms on a large backend (fork copies
 * page tables), so hot paths use this stat-based scan instead.
 * Returns the absolute path of the first match in PATH order, or null when nothing matches.
 */
export function findExecutableOnPath(
  name: string,
  options?: { env?: NodeJS.ProcessEnv; cwd?: string }
): string | null {
  assert(name.length > 0, "findExecutableOnPath: name must be non-empty");
  assert(
    !name.includes("/") && !name.includes("\\"),
    "findExecutableOnPath: name must not contain path separators"
  );

  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? currentDirectoryOrNull();
  const isWindows = process.platform === "win32";
  const pathApi = isWindows ? path.win32 : path.posix;

  // process.env is case-insensitive on Windows; plain env objects may only carry `Path`.
  const pathValue = (isWindows ? (env.PATH ?? env.Path) : env.PATH) ?? "";
  // An unset or empty PATH searches no directories. Within a non-empty PATH, empty and
  // relative entries are not skipped: execvp/`which` resolve them against cwd (an empty
  // POSIX entry means the current directory).
  const entries = pathValue.length > 0 ? pathValue.split(isWindows ? ";" : ":") : [];

  // Absolute entries never touch cwd; path.resolve() would call process.cwd() for relative ones.
  const resolveCandidate = (directory: string, fileName: string): string | null => {
    if (pathApi.isAbsolute(directory)) return pathApi.resolve(directory, fileName);
    return cwd === null ? null : pathApi.resolve(cwd, directory, fileName);
  };

  if (!isWindows) {
    for (const entry of entries) {
      const candidate = resolveCandidate(entry, name);
      if (candidate !== null && isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const extensions = (env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .filter((extension) => extension.length > 0);
  const lowerName = name.toLowerCase();
  const candidateNames = extensions.some((extension) => lowerName.endsWith(extension.toLowerCase()))
    ? [name, ...extensions.map((extension) => name + extension)]
    : extensions.map((extension) => name + extension);

  // where.exe searches the current directory before PATH.
  for (const directory of cwd === null ? entries : [cwd, ...entries]) {
    for (const candidateName of candidateNames) {
      const candidate = resolveCandidate(directory, candidateName);
      if (candidate !== null && isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}
