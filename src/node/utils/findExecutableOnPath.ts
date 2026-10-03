import { accessSync, constants, statSync } from "fs";
import * as path from "path";
import { assert } from "@/common/utils/assert";

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

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
 * Resolve an executable name through PATH in-process, like `which` (POSIX) or `where` (Windows).
 *
 * Spawning `which`/`where` blocks the event loop for several ms on a large backend (fork copies
 * page tables), so hot paths use this stat-based scan instead. It never launches a process.
 * Returns the absolute path of the first match in PATH order, or null when nothing matches.
 */
export function findExecutableOnPath(
  name: string,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string }
): string | null {
  assert(name.length > 0, "findExecutableOnPath: name must be non-empty");
  assert(
    !name.includes("/") && !name.includes("\\"),
    "findExecutableOnPath: name must not contain path separators"
  );

  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const cwd = options?.cwd ?? process.cwd();
  const isWindows = platform === "win32";
  const pathApi = isWindows ? path.win32 : path.posix;

  // process.env is case-insensitive on Windows; plain env objects may only carry `Path`.
  const pathValue = (isWindows ? (env.PATH ?? env.Path) : env.PATH) ?? "";
  // An unset or empty PATH searches no directories. Within a non-empty PATH, empty and
  // relative entries are not skipped: execvp/`which` resolve them against cwd (an empty
  // POSIX entry means the current directory).
  const entries = pathValue.length > 0 ? pathValue.split(isWindows ? ";" : ":") : [];

  if (!isWindows) {
    for (const entry of entries) {
      const candidate = pathApi.resolve(cwd, entry, name);
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const extensions = (env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .filter((extension) => extension.length > 0);
  const lowerName = name.toLowerCase();
  const candidateNames = extensions.some((extension) =>
    lowerName.endsWith(extension.toLowerCase())
  )
    ? [name, ...extensions.map((extension) => name + extension)]
    : extensions.map((extension) => name + extension);

  // where.exe searches the current directory before PATH.
  for (const directory of [cwd, ...entries]) {
    for (const candidateName of candidateNames) {
      const candidate = pathApi.resolve(cwd, directory, candidateName);
      if (isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}
