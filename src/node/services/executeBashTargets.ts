import path from "path";
import { shellQuote } from "@/common/utils/shell";
import { Err, Ok, type Result } from "@/common/types/result";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

// Pure target selection for WorkspaceService.executeBash: which script runs, and which
// project's checkout a repo-root command runs in.

/** A project path in one comparable form: forward slashes, trimmed, no trailing slash. */
export function normalizeRepoRootProjectPath(projectPath: string | null | undefined): string {
  const normalizedPath = projectPath?.replaceAll("\\", "/").trim() ?? "";
  if (!normalizedPath) {
    return "";
  }

  return stripTrailingSlashes(path.posix.normalize(normalizedPath));
}

/**
 * The script executeBash runs: the caller's script, or, in command mode, the quoted command
 * line. Command mode supports only git.
 */
export function resolveExecuteBashScript(
  script: string,
  command: string | undefined,
  args: readonly string[] | undefined
): Result<string> {
  if (command == null) {
    return Ok(script);
  }
  if (command !== "git") {
    return Err("executeBash command mode only supports git");
  }
  return Ok([shellQuote(command), ...(args ?? []).map((arg) => shellQuote(arg))].join(" "));
}

/**
 * The project a multi-project repo-root command runs in: the requested project when one is
 * named (undefined if no project matches), else the primary project, else the first project.
 */
export function selectRepoRootProject<T extends { projectPath: string }>(
  projects: readonly T[],
  requestedProjectPath: string,
  primaryProjectPath: string
): T | undefined {
  const matches = (projectPath: string) => (project: T) =>
    normalizeRepoRootProjectPath(project.projectPath) === projectPath;
  if (requestedProjectPath) {
    return projects.find(matches(requestedProjectPath));
  }
  return projects.find(matches(normalizeRepoRootProjectPath(primaryProjectPath))) ?? projects[0];
}
