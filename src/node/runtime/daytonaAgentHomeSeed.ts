import * as fs from "fs/promises";
import * as path from "path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";
import { execBuffered } from "@/node/utils/runtime/helpers";
import type { Runtime } from "./Runtime";
import { expandTildeForSSH } from "./tildeExpansion";

/**
 * Seeds a Xum-created Daytona sandbox with the host's user-global agent files, so hooks and
 * global skills behave as they do locally. Destinations are the paths the remote lookups read:
 * hooks.ts and agentSkillsService resolve user-global files under `runtime.getXumHome()`
 * (`~/.mux` on SSH remotes) and universal skills under `~/.agents/skills`.
 *
 * Xum owns the box, so existing files are overwritten. Attached (shared) sandboxes are never
 * seeded: they belong to the user.
 */

const SEEDED_HOOK_FILES = ["tool_env", "tool_pre", "tool_post"] as const;

/** A box seed is a convenience: past this size the rest is skipped with a warning. */
const MAX_SEED_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_DIR_DEPTH = 8;
const SEED_TIMEOUT_SECONDS = 120;
const HEREDOC_MARKER = "XUM_DAYTONA_SEED_EOF";

export interface AgentHomeSeedFile {
  /** Remote path, `~/`-relative. */
  remotePath: string;
  content: Buffer;
  executable: boolean;
}

export interface AgentHomeSeedSources {
  /** Host Xum home (holds tool_env, tool_pre, tool_post and skills/). */
  xumHome: string;
  /** Host user home (holds .agents/skills). */
  home: string;
}

interface SeedBudget {
  remainingBytes: number;
  exhausted: boolean;
}

async function readRegularFile(
  filePath: string
): Promise<{ content: Buffer; mode: number } | null> {
  try {
    // stat follows symlinks: plugin installs link skills into the skills directory.
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { content: await fs.readFile(filePath), mode: stat.mode };
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return null;
    log.warn("Skipping an unreadable file while seeding a Daytona sandbox", {
      filePath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function addFile(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  remotePath: string,
  file: { content: Buffer; mode: number }
): void {
  if (file.content.length > budget.remainingBytes) {
    budget.exhausted = true;
    return;
  }
  budget.remainingBytes -= file.content.length;
  files.push({ remotePath, content: file.content, executable: (file.mode & 0o111) !== 0 });
}

async function collectDirectory(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  hostDir: string,
  remoteDir: string,
  depth: number
): Promise<void> {
  if (depth > MAX_SKILL_DIR_DEPTH || budget.exhausted) return;
  let entries: string[];
  try {
    entries = await fs.readdir(hostDir);
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT") && !isErrnoWithCode(error, "ENOTDIR")) {
      log.warn("Skipping an unreadable directory while seeding a Daytona sandbox", {
        hostDir,
        error: getErrorMessage(error),
      });
    }
    return;
  }
  for (const entry of entries.sort()) {
    const hostPath = path.join(hostDir, entry);
    const remotePath = path.posix.join(remoteDir, entry);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(hostPath);
    } catch (error) {
      // Broken symlinks are common in skill directories; skip them.
      log.debug("Skipping a missing path while seeding a Daytona sandbox", {
        hostPath,
        error: getErrorMessage(error),
      });
      continue;
    }
    if (stat.isDirectory()) {
      await collectDirectory(files, budget, hostPath, remotePath, depth + 1);
    } else if (stat.isFile()) {
      const file = await readRegularFile(hostPath);
      if (file) addFile(files, budget, remotePath, file);
    }
  }
}

/** The host files to copy; missing files and directories are skipped. */
export async function collectAgentHomeSeedFiles(
  sources: AgentHomeSeedSources,
  remoteXumHome: string
): Promise<AgentHomeSeedFile[]> {
  const files: AgentHomeSeedFile[] = [];
  const budget: SeedBudget = { remainingBytes: MAX_SEED_BYTES, exhausted: false };
  for (const name of SEEDED_HOOK_FILES) {
    const file = await readRegularFile(path.join(sources.xumHome, name));
    if (file) addFile(files, budget, path.posix.join(remoteXumHome, name), file);
  }
  await collectDirectory(
    files,
    budget,
    path.join(sources.xumHome, "skills"),
    path.posix.join(remoteXumHome, "skills"),
    0
  );
  await collectDirectory(
    files,
    budget,
    path.join(sources.home, ".agents", "skills"),
    "~/.agents/skills",
    0
  );
  if (budget.exhausted) {
    log.warn("Daytona agent-home seed hit its size limit; some files were not copied", {
      limitBytes: MAX_SEED_BYTES,
    });
  }
  return files;
}

/** One POSIX sh script that writes every file (sent on stdin: no argv size limit applies). */
export function buildAgentHomeSeedScript(files: readonly AgentHomeSeedFile[]): string {
  const lines = ["set -e"];
  for (const file of files) {
    const target = expandTildeForSSH(file.remotePath);
    lines.push(`mkdir -p ${expandTildeForSSH(path.posix.dirname(file.remotePath))}`);
    lines.push(`base64 -d > ${target} <<'${HEREDOC_MARKER}'`);
    // Line-wrapped base64 never contains the marker.
    lines.push(...(file.content.toString("base64").match(/.{1,76}/g) ?? []));
    lines.push(HEREDOC_MARKER);
    lines.push(`chmod ${file.executable ? "755" : "644"} ${target}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function seedAgentHome(
  runtime: Runtime,
  sources: AgentHomeSeedSources,
  abortSignal?: AbortSignal
): Promise<number> {
  const files = await collectAgentHomeSeedFiles(sources, runtime.getXumHome());
  if (files.length === 0) return 0;
  const result = await execBuffered(runtime, "sh -s", {
    cwd: "/tmp",
    timeout: SEED_TIMEOUT_SECONDS,
    abortSignal,
    stdin: buildAgentHomeSeedScript(files),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to copy agent files into the sandbox: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return files.length;
}
