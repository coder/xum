import assert from "node:assert/strict";
import path from "node:path";

import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";

export type EnsureGitInfoExcludeResult =
  | { status: "notGit" }
  | { status: "ensured"; pattern: string; excludePath: string }
  | { status: "failed"; error: string };

export async function ensureGitInfoExclude(input: {
  runtime: Runtime;
  workspacePath: string;
  relativeDir: string;
}): Promise<EnsureGitInfoExcludeResult> {
  const { runtime, workspacePath, relativeDir } = input;
  assert(workspacePath.trim().length > 0, "workspacePath is required");
  assert(relativeDir.trim().length > 0, "relativeDir is required");

  const inside = await execBuffered(runtime, "git rev-parse --is-inside-work-tree", {
    cwd: workspacePath,
    timeout: 5,
  });
  if (inside.exitCode !== 0) {
    const message = `${inside.stderr}\n${inside.stdout}`;
    if (/not a git repository/i.test(message)) {
      return { status: "notGit" };
    }
    return { status: "failed", error: message.trim() || "Could not determine Git workspace" };
  }

  const [prefixResult, excludeResult] = await Promise.all([
    execBuffered(runtime, "git rev-parse --show-prefix", { cwd: workspacePath, timeout: 5 }),
    execBuffered(runtime, "git rev-parse --git-path info/exclude", {
      cwd: workspacePath,
      timeout: 5,
    }),
  ]);
  if (prefixResult.exitCode !== 0) {
    return {
      status: "failed",
      error: prefixResult.stderr.trim() || "Could not resolve Git prefix",
    };
  }
  if (excludeResult.exitCode !== 0) {
    return {
      status: "failed",
      error: excludeResult.stderr.trim() || "Could not resolve Git exclude path",
    };
  }

  const prefix = prefixResult.stdout
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const relative = relativeDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const pattern = `/${[prefix, relative].filter(Boolean).join("/")}/`;
  const excludePath = resolveRuntimePath(workspacePath, excludeResult.stdout.trim());

  let existing = "";
  try {
    existing = await readFileString(runtime, excludePath);
  } catch {
    existing = "";
  }

  const existingLines = existing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!existingLines.includes(pattern)) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFileString(runtime, excludePath, `${existing}${separator}${pattern}\n`);
  }

  return { status: "ensured", pattern, excludePath };
}

function resolveRuntimePath(workspacePath: string, gitPath: string): string {
  assert(gitPath.trim().length > 0, "git exclude path is required");
  if (path.isAbsolute(gitPath) || /^[/~]/u.test(gitPath) || /^[A-Za-z]:[\\/]/u.test(gitPath)) {
    return gitPath;
  }
  return `${workspacePath.replace(/[\\/]+$/u, "")}/${gitPath}`;
}
