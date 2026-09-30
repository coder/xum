import { createGitStatusOutput, type GitStatusFixture } from "../mocks/git";

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS/DIFF EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════════
export interface GitDiffFixture {
  /** The raw unified diff output */
  diffOutput: string;
  /** The numstat output (additions, deletions per file) */
  numstatOutput?: string;
  /** File contents for read-more feature (path -> full file content as lines) */
  fileContents?: Map<string, string[]>;
  /** List of untracked files (for UntrackedStatus banner) */
  untrackedFiles?: string[];
}

/**
 * Creates an executeBash function that returns git status and diff output for workspaces.
 * Handles: git status, git diff, git diff --numstat, git show (for read-more),
 * git ls-files --others (for untracked files)
 */
export function createGitStatusExecutor(
  gitStatus?: Map<string, GitStatusFixture>,
  gitDiff?: Map<string, GitDiffFixture>
) {
  return (workspaceId: string, script: string) => {
    if (script.includes("git status")) {
      const status = gitStatus?.get(workspaceId) ?? {};
      // For git status --ignored --porcelain, add !! node_modules to mark it as ignored
      let output = createGitStatusOutput(status);
      if (script.includes("--ignored")) {
        output = output ? `${output}\n!! node_modules/` : "!! node_modules/";
      }
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // Handle git ls-files --others (untracked files)
    if (script.includes("git ls-files --others")) {
      const diff = gitDiff?.get(workspaceId);
      const output = diff?.untrackedFiles?.join("\n") ?? "";
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // Handle git diff --numstat
    if (script.includes("git diff") && script.includes("--numstat")) {
      const diff = gitDiff?.get(workspaceId);
      const output = diff?.numstatOutput ?? "";
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // Handle git diff (regular diff output)
    if (script.includes("git diff")) {
      const diff = gitDiff?.get(workspaceId);
      const output = diff?.diffOutput ?? "";
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // Handle git show for read-more feature (e.g., git show "HEAD:file.ts" | sed -n '1,20p')
    const gitShowMatch = /git show "[^:]+:([^"]+)"/.exec(script);
    const sedMatch = /sed -n '(\d+),(\d+)p'/.exec(script);
    if (gitShowMatch && sedMatch) {
      const filePath = gitShowMatch[1];
      const startLine = parseInt(sedMatch[1], 10);
      const endLine = parseInt(sedMatch[2], 10);
      const diff = gitDiff?.get(workspaceId);
      const lines = diff?.fileContents?.get(filePath);
      if (lines) {
        // sed uses 1-based indexing
        const output = lines.slice(startLine - 1, endLine).join("\n");
        return Promise.resolve({
          success: true as const,
          output,
          exitCode: 0,
          wall_duration_ms: 50,
        });
      }
    }

    return Promise.resolve({
      success: true as const,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
    });
  };
}
