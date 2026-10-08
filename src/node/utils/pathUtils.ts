import * as fs from "fs/promises";
import * as path from "path";
import { execFileAsync } from "./disposableExec";
import { PlatformPaths } from "./paths.main";

/**
 * Result of path validation
 */
export interface PathValidationResult {
  valid: boolean;
  expandedPath?: string;
  error?: string;
}

/**
 * Expand tilde (~) in paths to the user's home directory
 *
 * @param inputPath - Path that may contain tilde
 * @returns Path with tilde expanded to home directory
 *
 * @example
 * expandTilde("~/Documents") // => "/home/user/Documents"
 * expandTilde("~") // => "/home/user"
 * expandTilde("/absolute/path") // => "/absolute/path"
 */
export function expandTilde(inputPath: string): string {
  return PlatformPaths.expandHome(inputPath);
}

/**
 * Strip trailing slashes from a path.
 * path.normalize() preserves a single trailing slash which breaks basename extraction.
 *
 * @param inputPath - Path that may have trailing slashes
 * @returns Path without trailing slashes
 *
 * @example
 * stripTrailingSlashes("/home/user/project/") // => "/home/user/project"
 * stripTrailingSlashes("/home/user/project//") // => "/home/user/project"
 * stripTrailingSlashes("/") // => "/" (the root has no trailing slash to strip, #5917)
 */
export function stripTrailingSlashes(inputPath: string): string {
  // One backward scan, and no allocation when nothing is stripped: about 80 callers, some on
  // lookup paths. A path made only of separators keeps one, so "/" never becomes "" (an
  // invalid project key that the next config load dropped with its workspace rows, #5917).
  let end = inputPath.length;
  while (end > 0) {
    const code = inputPath.charCodeAt(end - 1);
    if (code !== 47 /* / */ && code !== 92 /* \ */) break;
    end--;
  }
  if (end === inputPath.length) return inputPath;
  return end === 0 ? inputPath.slice(0, 1) : inputPath.slice(0, end);
}

export const PROJECT_AT_FILESYSTEM_ROOT_ERROR = "A project cannot be the filesystem root";

/**
 * True when `inputPath` resolves to a filesystem root (`/` on POSIX, a drive root on Windows).
 * Project add, create and trust flows refuse such paths: file completions, git status and
 * review scans would walk the whole disk. Configs that already hold a root project still load.
 */
export function isFilesystemRoot(inputPath: string): boolean {
  const resolved = path.resolve(inputPath);
  return path.parse(resolved).root === resolved;
}

/**
 * Validate that a project path exists and is a directory.
 * Git repository status is checked separately - non-git repos are valid
 * but will be restricted to local runtime only.
 * Automatically expands tilde and normalizes the path.
 *
 * @param inputPath - Path to validate (may contain tilde)
 * @returns Validation result with expanded path or error
 *
 * @example
 * await validateProjectPath("~/my-project")
 * // => { valid: true, expandedPath: "/home/user/my-project" }
 *
 * await validateProjectPath("~/nonexistent")
 * // => { valid: false, error: "Path does not exist: /home/user/nonexistent" }
 */
export async function validateProjectPath(inputPath: string): Promise<PathValidationResult> {
  // Expand tilde if present
  const expandedPath = expandTilde(inputPath);

  // Normalize to resolve any .. or . in the path, then strip trailing slashes
  const normalizedPath = stripTrailingSlashes(path.normalize(expandedPath));

  // Before #5917 the root normalized to "" and failed the stat below; keep refusing it.
  if (isFilesystemRoot(normalizedPath)) {
    return { valid: false, error: PROJECT_AT_FILESYSTEM_ROOT_ERROR };
  }

  // Check if path exists
  try {
    const stats = await fs.stat(normalizedPath);

    // Check if it's a directory
    if (!stats.isDirectory()) {
      return {
        valid: false,
        error: `Path is not a directory: ${normalizedPath}`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        valid: false,
        error: `Path does not exist: ${normalizedPath}`,
      };
    }
    throw err;
  }

  return {
    valid: true,
    expandedPath: normalizedPath,
  };
}

/**
 * Check if a path is a git repository
 *
 * @param projectPath - Path to check (should be already validated/normalized)
 * @returns true if the path contains a .git directory
 */
export async function isGitRepository(projectPath: string): Promise<boolean> {
  const gitPath = path.join(projectPath, ".git");
  try {
    await fs.stat(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether `projectPath` lies inside a git work tree, even if `.git`
 * lives in an ancestor directory. This matters for sub-projects: the
 * sub-project directory itself has no `.git`, but it still belongs to the
 * parent project's git work tree, so we should treat it as a git repo for
 * UX (e.g. branch listing, suppressing the "git init" banner).
 *
 * @param projectPath - Path to check (should be already validated/normalized)
 */
export async function isInsideGitRepository(projectPath: string): Promise<boolean> {
  try {
    using proc = execFileAsync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
    const { stdout } = await proc.result;
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Check whether `filePath` is equal to or nested inside `dirPath`.
 *
 * Both paths are resolved to absolute form first, so relative segments
 * and missing trailing slashes are handled automatically.
 *
 * @example
 * isPathInsideDir("/home/user/project", "/home/user/project/src/index.ts") // true
 * isPathInsideDir("/home/user/project", "/home/user/other/file.ts")        // false
 */
export function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
