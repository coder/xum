import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { z } from "zod";

import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import type { SkillsCliRunSchema, SkillsCliStatusSchema } from "@/common/orpc/schemas/skillsCli";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import {
  isSkillsCliRemoteUrl,
  SKILLS_CLI_NOT_REMOTE_PROBLEM,
  skillsCliSourceProblem,
} from "@/common/utils/skillsCliSource";
import {
  assertNoAgentPluginUrlCredentials,
  parseAgentPluginSourceInput,
} from "@/node/services/agentPlugins/sourceInput";
import { stripAnsiControlChars } from "@/node/utils/ansi";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { execFileAsync } from "@/node/utils/disposableExec";
import { findExecutableOnPath } from "@/node/utils/findExecutableOnPath";

/**
 * The "Skills CLI" install method of the Add panel: Xum runs the skills CLI
 * (vercel-labs/skills) with fixed flags and shows its output. The CLI copies
 * the skills into ~/.agents/skills, which Xum already reads. Xum does not
 * review, update or remove these skills.
 */

export type SkillsCliStatus = z.infer<typeof SkillsCliStatusSchema>;
export type SkillsCliRun = z.infer<typeof SkillsCliRunSchema>;

// Pinned: the spike verified 1.7.4 (flags, output folder, lock file). Running
// `skills@latest` would let a new upstream release change what Xum runs
// without review, so a new CLI version needs a Xum release.
export const SKILLS_CLI_PACKAGE = "skills@1.7.4";

/** skills@1.7.4 declares `engines.node >=22.20.0`; on older versions npm only warns. */
const MIN_NODE_VERSION: readonly [number, number, number] = [22, 20, 0];
const MIN_NODE_VERSION_TEXT = MIN_NODE_VERSION.join(".");

/** npx downloads the package on the first run, so this covers a slow network. */
const RUN_TIMEOUT_MS = 120_000;
const NODE_VERSION_TIMEOUT_MS = 10_000;
/** Kills a runaway CLI; far above the output of a normal install. */
const MAX_BUFFERED_OUTPUT_BYTES = 10 * 1024 * 1024;
/** The Add panel shows only the tail of long output (the result and errors are at the end). */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * The CLI writes ~/.agents/skills and ~/.agents/.skill-lock.json with an unlocked
 * read-modify-write, so two runs at once could lose each other's lock entries. The mutex
 * orders the runs of this process; the file lock (in the same home, next to the CLI's lock
 * file) also orders the runs of other Xum backends that share the home.
 */
const runMutex = new AsyncMutex();
const RUN_LOCK_FILE = ".xum-skills-cli.lock";
/** A run holds the lock for at most RUN_TIMEOUT_MS; wait for one other run and some slack. */
const RUN_LOCK_TIMEOUT_MS = RUN_TIMEOUT_MS + 30_000;

export interface SkillsCliOptions {
  /** Merged over process.env; PATH selects npx and node. */
  env?: NodeJS.ProcessEnv;
  /** Where the CLI writes ~/.agents/skills. Must match HOME in `env`. */
  homeDir?: string;
  timeoutMs?: number;
}

/**
 * The skills CLI takes a git URL: a remote https/ssh source of the whole repository at its
 * default branch (skillsCliSourceProblem, which Settings also checks before it offers the CLI).
 */
function skillsCliSource(input: string): string {
  const problem = skillsCliSourceProblem(input);
  if (problem !== undefined) throw new Error(problem);
  const parsed = parseAgentPluginSourceInput(input);
  // The shared check refuses shorthand with `@ref` or a subpath; URL inputs never carry them.
  assert(
    parsed.ref === undefined && parsed.subpath === undefined,
    "skillsCliSource: an accepted source has no ref or subpath"
  );
  const url = parsed.url;
  // Again here: the parser checks the raw input, this checks what Xum runs.
  assertNoAgentPluginUrlCredentials(url);
  if (!isSkillsCliRemoteUrl(url)) throw new Error(SKILLS_CLI_NOT_REMOTE_PROBLEM);
  const urlProblem = skillsCliSourceProblem(url);
  if (urlProblem !== undefined) throw new Error(urlProblem);
  assert(!url.startsWith("-"), "skillsCliSource: a remote URL never starts with '-'");
  return url;
}

/**
 * The npx arguments. `--global --agent codex` writes ~/.agents/skills (the
 * plugin installer has no project scope either), `--copy` keeps no symlink
 * into the CLI cache, and both `--yes` flags keep npx and the CLI from asking.
 */
export function skillsCliArgs(source: string, skills: string[]): string[] {
  assert(skills.length > 0, "Pick at least one skill to install.");
  for (const skill of skills) {
    // The skill-name grammar starts with [a-z0-9], so no name reads as an option.
    if (!SkillNameSchema.safeParse(skill).success) {
      throw new Error(
        `'${skill}' is not a valid skill name (lowercase letters, digits and single hyphens, up to 64 characters).`
      );
    }
  }
  return [
    "--yes",
    SKILLS_CLI_PACKAGE,
    "add",
    skillsCliSource(source),
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--global",
    "--agent",
    "codex",
    "--copy",
    "--yes",
  ];
}

/** Quote only where a POSIX shell needs it, so the copied command stays readable. */
function formatCommand(argv: string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9@%_+=:,./-]+$/.test(arg) ? arg : shellQuote(arg)))
    .join(" ");
}

function parseNodeVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
  version: readonly [number, number, number],
  minimum: readonly [number, number, number]
): boolean {
  for (let index = 0; index < 3; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

type Detection =
  | { available: true; npxPath: string; nodeVersion: string }
  | { available: false; reason: string; nodeVersion: string | null };

type Unavailable = Extract<Detection, { available: false }>;

/** The npx and node that a run would use, or why there are none. */
function findNodeTools(
  env: NodeJS.ProcessEnv
): { npxPath: string; nodePath: string } | Unavailable {
  if (process.platform === "win32") {
    // npx is npx.cmd on Windows, and Node.js refuses to start a .cmd file
    // without a shell. Xum runs no shell here, so the user runs the command.
    return {
      available: false,
      reason: "On Windows, Xum does not run the skills CLI. Run the command in a terminal.",
      nodeVersion: null,
    };
  }
  const npxPath = findExecutableOnPath("npx", { env });
  const nodePath = findExecutableOnPath("node", { env });
  if (npxPath === null || nodePath === null) {
    return {
      available: false,
      reason: `Xum did not find ${npxPath === null ? "npx" : "node"} on PATH. The skills CLI needs Node.js ${MIN_NODE_VERSION_TEXT} or later.`,
      nodeVersion: null,
    };
  }
  return { npxPath, nodePath };
}

async function readNodeVersion(
  nodePath: string,
  env: NodeJS.ProcessEnv
): Promise<{ version: string } | Unavailable> {
  try {
    using proc = execFileAsync(nodePath, ["--version"], {
      env,
      timeoutMs: NODE_VERSION_TIMEOUT_MS,
    });
    return { version: (await proc.result).stdout.trim() };
  } catch (error) {
    return {
      available: false,
      reason: `Xum could not read the Node.js version (${getErrorMessage(error)}).`,
      nodeVersion: null,
    };
  }
}

async function detectNode(env: NodeJS.ProcessEnv): Promise<Detection> {
  const tools = findNodeTools(env);
  if ("available" in tools) return tools;
  const read = await readNodeVersion(tools.nodePath, env);
  if ("available" in read) return read;
  const parsed = parseNodeVersion(read.version);
  if (parsed === null || !isAtLeast(parsed, MIN_NODE_VERSION)) {
    return {
      available: false,
      reason: `The skills CLI needs Node.js ${MIN_NODE_VERSION_TEXT} or later. The node on PATH is ${read.version || "unknown"}.`,
      nodeVersion: read.version || null,
    };
  }
  // npx starts the CLI with the first node on PATH (`#!/usr/bin/env node`), the one checked here.
  return { available: true, npxPath: tools.npxPath, nodeVersion: read.version };
}

// The CLI and its npm dependency tree are third-party code, so they get only what npx,
// git and npm need: no provider API keys or other secrets from the Xum environment.
const SKILLS_CLI_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // The CLI keeps its global lock file in $XDG_STATE_HOME/skills when this is set.
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows needs these to start any process.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

function isSkillsCliEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  // LC_* is the locale; npm_config_* is npm's own config (registry, proxy, cache).
  return (
    SKILLS_CLI_ENV_NAMES.has(upper) || upper.startsWith("LC_") || upper.startsWith("NPM_CONFIG_")
  );
}

function mergedEnv(options: SkillsCliOptions | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries({ ...process.env, ...options?.env })) {
    // execFileAsync spreads process.env under this object, so a refused name must be set to
    // undefined here (spawn drops undefined values), not only left out.
    env[name] = isSkillsCliEnvName(name) ? value : undefined;
  }
  return env;
}

export async function skillsCliStatus(options?: SkillsCliOptions): Promise<SkillsCliStatus> {
  const detection = await detectNode(mergedEnv(options));
  return detection.available
    ? { available: true, nodeVersion: detection.nodeVersion, package: SKILLS_CLI_PACKAGE }
    : {
        available: false,
        reason: detection.reason,
        nodeVersion: detection.nodeVersion,
        package: SKILLS_CLI_PACKAGE,
      };
}

/**
 * What a terminal shows of one line: spinners redraw it after `\r`, so only the text after the
 * last `\r` stays. A trailing `\r` overwrites nothing.
 */
function lastRedraw(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
}

/** Apply `\r` redraws, strip ANSI escapes line by line (the helper drops newlines), keep the tail. */
function cleanOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n");
  const text = combined
    .split(/\r?\n/)
    .map((line) => stripAnsiControlChars(lastRedraw(line)))
    .join("\n")
    .trimEnd();
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `[Xum shows only the last ${MAX_OUTPUT_CHARS / 1024} KiB of output]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

interface CapturedRun {
  /** null when the process did not exit normally or did not start. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The rejection message; for a spawn error or an output overflow it is the only clue. */
  error: string | null;
  /** Spawn errors (ENOENT, EACCES) carry a string code; process failures carry a number or null. */
  startFailed: boolean;
}

/** The fields execFileAsync puts on its rejection. */
function capturedFailure(error: unknown): Omit<CapturedRun, "timedOut"> {
  const fields: { code?: unknown; stdout?: unknown; stderr?: unknown } =
    typeof error === "object" && error !== null ? error : {};
  return {
    exitCode: typeof fields.code === "number" ? fields.code : null,
    stdout: typeof fields.stdout === "string" ? fields.stdout : "",
    stderr: typeof fields.stderr === "string" ? fields.stderr : "",
    error: getErrorMessage(error),
    startFailed: typeof fields.code === "string",
  };
}

async function captureRun(
  npxPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CapturedRun> {
  // An empty working folder: the CLI must not pick up a project's skills or config.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xum-skills-cli-"));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    using proc = execFileAsync(npxPath, args, {
      cwd,
      env: {
        ...env,
        // The CLI sends telemetry unless one of these is set.
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        // No prompts, no spinners, no npm update notice.
        CI: "1",
      },
      signal: controller.signal,
      // npx starts node, which starts git: a timeout must stop all of them.
      killTreeOnTermination: true,
      maxOutputBytes: MAX_BUFFERED_OUTPUT_BYTES,
    });
    const { stdout, stderr } = await proc.result;
    return { exitCode: 0, stdout, stderr, timedOut, error: null, startFailed: false };
  } catch (error) {
    return { ...capturedFailure(error), timedOut };
  } finally {
    clearTimeout(timer);
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

/** Why the process failed, or null when it exited 0. */
function processFailure(run: CapturedRun, timeoutMs: number): string | null {
  if (run.timedOut) {
    return `The skills CLI did not finish in ${Math.round(timeoutMs / 1000)} seconds. Xum stopped it.`;
  }
  if (run.startFailed) return `Xum could not start npx: ${run.error ?? "unknown error"}`;
  if (run.exitCode === null) {
    return `The skills CLI stopped before it finished (${run.error ?? "unknown error"}).`;
  }
  if (run.exitCode !== 0) return `The skills CLI failed with exit code ${run.exitCode}.`;
  return null;
}

async function hasSkillFile(homeDir: string, skill: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(homeDir, ".agents", "skills", skill, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

/** The requested skills that already have an entry in ~/.agents/skills (even a dangling link). */
async function existingSkillFolders(homeDir: string, skills: string[]): Promise<string[]> {
  const entries = await Promise.all(
    skills.map((skill) =>
      fs.lstat(path.join(homeDir, ".agents", "skills", skill)).catch(() => null)
    )
  );
  return skills.filter((_skill, index) => entries[index] !== null);
}

/** The requested skills without ~/.agents/skills/<name>/SKILL.md. */
async function missingSkillFiles(homeDir: string, skills: string[]): Promise<string[]> {
  const present = await Promise.all(skills.map((skill) => hasSkillFile(homeDir, skill)));
  return skills.filter((_skill, index) => !present[index]);
}

async function runSkillsCli(
  npxPath: string,
  args: string[],
  command: string,
  skills: string[],
  options: SkillsCliOptions | undefined
): Promise<SkillsCliRun> {
  const timeoutMs = options?.timeoutMs ?? RUN_TIMEOUT_MS;
  const run = await captureRun(npxPath, args, mergedEnv(options), timeoutMs);
  const ran = {
    status: "ran" as const,
    exitCode: run.timedOut ? null : run.exitCode,
    timedOut: run.timedOut,
    output: cleanOutput(run.stdout, run.stderr),
    command,
  };
  const failure = processFailure(run, timeoutMs);
  if (failure !== null) return { ...ran, ok: false, missingSkills: [], failure };

  // Exit 0 is not proof: the CLI also exits 0 when the repository has no skill with that name.
  // No requested folder existed before the run (installWithSkillsCli), so a SKILL.md now is
  // this run's.
  const missingSkills = await missingSkillFiles(options?.homeDir ?? os.homedir(), skills);
  if (missingSkills.length > 0) {
    return {
      ...ran,
      ok: false,
      missingSkills,
      failure: `The skills CLI finished, but ~/.agents/skills has no SKILL.md for: ${missingSkills.join(", ")}.`,
    };
  }
  return { ...ran, ok: true, missingSkills: [], failure: null };
}

/**
 * Validate the input, then run the pinned CLI (one run at a time). Throws a
 * user-facing error for invalid input. Without a usable Node.js, Xum does not
 * run anything and returns the command for the user to run in a terminal.
 */
export async function installWithSkillsCli(
  input: { source: string; skills: string[] },
  options?: SkillsCliOptions
): Promise<SkillsCliRun> {
  const args = skillsCliArgs(input.source, input.skills);
  const command = formatCommand(["npx", ...args]);
  const homeDir = options?.homeDir ?? os.homedir();
  await using _lock = await runMutex.acquire();
  await using _fileLock = await acquireProcessFileLock({
    lockPath: path.join(homeDir, ".agents", RUN_LOCK_FILE),
    timeoutMs: RUN_LOCK_TIMEOUT_MS,
    label: "skills CLI run lock",
  });
  // SECURITY: `--copy --yes` makes the CLI delete and replace an existing skill folder without
  // asking. Xum has no consent step for that, so it refuses (also before it shows the command
  // to copy, which carries the same flags).
  const existing = await existingSkillFolders(homeDir, input.skills);
  if (existing.length > 0) {
    throw new Error(
      `~/.agents/skills already has ${existing.join(", ")}. The skills CLI would replace ${existing.length === 1 ? "that folder" : "those folders"} without asking, so Xum did not run it. Remove or rename ${existing.length === 1 ? "it" : "them"} first, or install only the other skills.`
    );
  }
  const detection = await detectNode(mergedEnv(options));
  if (!detection.available) {
    return { status: "unavailable", reason: detection.reason, command };
  }
  return runSkillsCli(detection.npxPath, args, command, input.skills, options);
}

/** The ORPC shape: invalid input becomes the error branch; a failed run is `ok: false` data. */
export async function installWithSkillsCliResult(
  input: { source: string; skills: string[] },
  options?: SkillsCliOptions
): Promise<{ success: true; data: SkillsCliRun } | { success: false; error: string }> {
  try {
    return { success: true, data: await installWithSkillsCli(input, options) };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
