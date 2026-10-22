import * as fs from "fs/promises";
import * as path from "path";
import { SkillNameSchema } from "@/common/orpc/schemas";
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

/**
 * A box seed is a convenience: a file larger than what is left of this is skipped, and files
 * that still fit are copied, so one large file does not drop every later skill.
 */
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
  /** A file did not fit. */
  skipped: boolean;
}

function isSpent(budget: SeedBudget): boolean {
  return budget.remainingBytes <= 0;
}

async function readRegularFile(
  filePath: string,
  budget: SeedBudget
): Promise<{ content: Buffer; mode: number } | null> {
  try {
    // stat follows symlinks: plugin installs link skills into the skills directory.
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    // Check before reading: a large file must not be loaded only to be dropped.
    if (stat.size > budget.remainingBytes) {
      log.debug("Skipping a file past the Daytona seed size limit", { filePath, size: stat.size });
      budget.skipped = true;
      return null;
    }
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
    budget.skipped = true;
    return;
  }
  budget.remainingBytes -= file.content.length;
  files.push({ remotePath, content: file.content, executable: (file.mode & 0o111) !== 0 });
}

/** Directory entries, sorted; null when the directory is missing or unreadable. */
async function readDirectory(hostDir: string): Promise<string[] | null> {
  try {
    return (await fs.readdir(hostDir)).sort();
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT") && !isErrnoWithCode(error, "ENOTDIR")) {
      log.warn("Skipping an unreadable directory while seeding a Daytona sandbox", {
        hostDir,
        error: getErrorMessage(error),
      });
    }
    return null;
  }
}

/** The real path and its stat (links followed); null for a broken link or a missing path. */
async function resolveEntry(
  hostPath: string
): Promise<{ real: string; stat: Awaited<ReturnType<typeof fs.stat>> } | null> {
  try {
    const real = await fs.realpath(hostPath);
    return { real, stat: await fs.stat(real) };
  } catch (error) {
    // Broken symlinks are common in skill directories; skip them.
    log.debug("Skipping a missing path while seeding a Daytona sandbox", {
      hostPath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function isInside(realPath: string, realRoot: string): boolean {
  const relative = path.relative(realRoot, realPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A skills root (`~/.xum/skills`, `~/.agents/skills`). Only its skill directories are copied
 * (see isSkillDirectory). Each may be a symlink (users and plugin installs link skills, and
 * skill discovery follows them); inside a skill, links are followed only while they stay
 * within that skill's real directory, so a link to `~/.ssh` is never copied into the sandbox.
 */
async function collectSkillsRoot(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  hostRoot: string,
  remoteRoot: string
): Promise<void> {
  const entries = await readDirectory(hostRoot);
  if (!entries) return;
  for (const entry of entries) {
    if (isSpent(budget)) return;
    await collectSkillsRootEntry(files, budget, {
      hostPath: path.join(hostRoot, entry),
      remotePath: path.posix.join(remoteRoot, entry),
    });
  }
}

/**
 * Whether a directory of a skills root is a skill as discovery sees one: a valid skill name and
 * a regular SKILL.md. SKILL.md must also stay inside the real directory, so a root entry linked
 * to `~/.ssh` (or holding a SKILL.md link to elsewhere) does not become a copy boundary.
 */
async function isSkillDirectory(name: string, realDir: string): Promise<boolean> {
  if (!SkillNameSchema.safeParse(name).success) return false;
  const skillFile = await resolveEntry(path.join(realDir, "SKILL.md"));
  return skillFile !== null && skillFile.stat.isFile() && isInside(skillFile.real, realDir);
}

/**
 * A skill directory (its real path bounds what it may link to). Discovery reads nothing else
 * of a skills root, and the root itself may be a link to `~/.ssh`, so other entries (files
 * included) are skipped.
 */
async function collectSkillsRootEntry(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  entry: { hostPath: string; remotePath: string }
): Promise<void> {
  const resolved = await resolveEntry(entry.hostPath);
  if (!resolved) return;
  const isSkill =
    resolved.stat.isDirectory() &&
    (await isSkillDirectory(path.basename(entry.hostPath), resolved.real));
  if (!isSkill) {
    log.warn(
      "Skipping a skills directory entry that is not a skill while seeding a Daytona sandbox",
      {
        hostPath: entry.hostPath,
      }
    );
    return;
  }
  await collectDirectory(files, budget, resolved.real, entry.remotePath, 1, resolved.real);
}

async function collectDirectory(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  hostDir: string,
  remoteDir: string,
  depth: number,
  skillRoot: string
): Promise<void> {
  if (depth > MAX_SKILL_DIR_DEPTH || isSpent(budget)) return;
  const entries = await readDirectory(hostDir);
  if (!entries) return;
  for (const entry of entries) {
    const resolved = await resolveEntry(path.join(hostDir, entry));
    if (!resolved) continue;
    if (!isInside(resolved.real, skillRoot)) {
      log.warn("Skipping a symlink that leaves its skill while seeding a Daytona sandbox", {
        hostPath: path.join(hostDir, entry),
      });
      continue;
    }
    const remotePath = path.posix.join(remoteDir, entry);
    if (resolved.stat.isDirectory()) {
      await collectDirectory(files, budget, resolved.real, remotePath, depth + 1, skillRoot);
    } else {
      await collectFile(files, budget, resolved, remotePath);
    }
  }
}

async function collectFile(
  files: AgentHomeSeedFile[],
  budget: SeedBudget,
  resolved: { real: string; stat: Awaited<ReturnType<typeof fs.stat>> },
  remotePath: string
): Promise<void> {
  if (!resolved.stat.isFile()) return;
  const file = await readRegularFile(resolved.real, budget);
  if (file) addFile(files, budget, remotePath, file);
}

/** The host files to copy; missing files and directories are skipped. */
export async function collectAgentHomeSeedFiles(
  sources: AgentHomeSeedSources,
  remoteXumHome: string
): Promise<AgentHomeSeedFile[]> {
  const files: AgentHomeSeedFile[] = [];
  const budget: SeedBudget = { remainingBytes: MAX_SEED_BYTES, skipped: false };
  for (const name of SEEDED_HOOK_FILES) {
    const file = await readRegularFile(path.join(sources.xumHome, name), budget);
    if (file) addFile(files, budget, path.posix.join(remoteXumHome, name), file);
  }
  await collectSkillsRoot(
    files,
    budget,
    path.join(sources.xumHome, "skills"),
    path.posix.join(remoteXumHome, "skills")
  );
  await collectSkillsRoot(
    files,
    budget,
    path.join(sources.home, ".agents", "skills"),
    "~/.agents/skills"
  );
  if (budget.skipped) {
    log.warn("Daytona agent-home seed hit its size limit; some files were not copied", {
      limitBytes: MAX_SEED_BYTES,
    });
  }
  return files;
}

/**
 * Shell helpers of the seed script. The snapshot may already hold a seed path, and a write or
 * chmod that followed a link there (`tool_env -> ~/.ssh/authorized_keys`) would clobber the
 * link's target. So nothing follows a link:
 * - a directory below the home that is a symlink fails the seed: removing it could drop
 *   snapshot content, and writing through it would land anywhere;
 * - each file is written to a fresh `mktemp` file in its own directory, chmodded there, and
 *   renamed over the destination. A destination symlink is removed first, so the rename
 *   replaces it (Xum owns the box and overwrites its seed files) instead of `mv` moving the
 *   file into a directory the link points at; a real directory there fails the seed.
 */
const SEED_SCRIPT_PRELUDE = [
  "set -e",
  "xum_seed_tmp=",
  `trap 'rm -f "$xum_seed_tmp"' EXIT`,
  `xum_seed_refuse() { echo "Refusing to seed $1: $2" >&2; exit 1; }`,
  `xum_seed_dir() { if [ -L "$1" ]; then xum_seed_refuse "$1" "it is a symlink"; fi; [ -d "$1" ] || mkdir "$1"; }`,
  `xum_seed_open() { if [ -d "$1" ] && [ ! -L "$1" ]; then xum_seed_refuse "$1" "it is a directory"; fi; xum_seed_tmp=$(mktemp "$2/.xum-seed.XXXXXX"); }`,
  `xum_seed_close() { chmod "$2" "$xum_seed_tmp"; if [ -L "$1" ]; then rm -f "$1"; fi; mv -f "$xum_seed_tmp" "$1"; xum_seed_tmp=; }`,
];

/** The `~/`-relative directories from the home down to `remoteDir`, each one level deeper. */
function directoriesBelowHome(remoteDir: string): string[] {
  if (!remoteDir.startsWith("~/")) {
    throw new Error(`Agent seed paths must be under the sandbox home: ${remoteDir}`);
  }
  const parts = remoteDir.slice(2).split("/").filter(Boolean);
  return parts.map((_, index) => `~/${parts.slice(0, index + 1).join("/")}`);
}

/** One POSIX sh script that writes every file (sent on stdin: no argv size limit applies). */
export function buildAgentHomeSeedScript(files: readonly AgentHomeSeedFile[]): string {
  const lines = [...SEED_SCRIPT_PRELUDE];
  const checkedDirs = new Set<string>();
  for (const file of files) {
    const target = expandTildeForSSH(file.remotePath);
    const remoteDir = path.posix.dirname(file.remotePath);
    for (const dir of directoriesBelowHome(remoteDir)) {
      if (checkedDirs.has(dir)) continue;
      checkedDirs.add(dir);
      lines.push(`xum_seed_dir ${expandTildeForSSH(dir)}`);
    }
    lines.push(`xum_seed_open ${target} ${expandTildeForSSH(remoteDir)}`);
    lines.push(`base64 -d > "$xum_seed_tmp" <<'${HEREDOC_MARKER}'`);
    // Line-wrapped base64 never contains the marker. A loop, not a spread: a spread passes
    // every line as an argument, and Node throws a RangeError past ~125k (a 10 MiB file).
    for (const line of file.content.toString("base64").match(/.{1,76}/g) ?? []) lines.push(line);
    lines.push(HEREDOC_MARKER);
    lines.push(`xum_seed_close ${target} ${file.executable ? "755" : "644"}`);
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
