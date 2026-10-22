import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MUX_CODER_HOST_SUFFIX,
  MUX_CODER_SSH_BLOCK_END,
  MUX_CODER_SSH_BLOCK_START,
} from "@/constants/coder";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";

interface EnsureMuxCoderSSHConfigFileOptions {
  coderBinaryPath: string;
  sshConfigPath?: string;
}

/**
 * Quote a string for safe embedding in an SSH ProxyCommand directive.
 * Uses double-quoting so the value works in both POSIX shells (/bin/sh -c)
 * and Windows cmd.exe (/d /s /c). Single quotes are not recognized by cmd.exe.
 *
 * Matches the strategy from coder/vscode-coder's escapeCommandArg.
 * Rejects paths containing newlines (would corrupt SSH config file format).
 */
function escapeCommandArg(arg: string): string {
  if (arg.includes("\n") || arg.includes("\r")) {
    throw new Error("Invalid coder binary path: newline characters are not allowed.");
  }

  // Escape embedded double quotes; wrap in double quotes.
  // Backslashes preserved as-is (important for Windows paths like C:\Program Files\...).
  const escaped = arg.replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

function renderProxyCommand(coderBinaryPath: string): string {
  const argv = [
    coderBinaryPath,
    "ssh",
    "--stdio",
    "--hostname-suffix",
    MUX_CODER_HOST_SUFFIX,
    "%h",
  ];

  return `ProxyCommand ${argv.map(escapeCommandArg).join(" ")}`;
}

function renderMuxBlock(coderBinaryPath: string): string {
  return [
    MUX_CODER_SSH_BLOCK_START,
    `Host *.${MUX_CODER_HOST_SUFFIX}`,
    "  ConnectTimeout 0",
    "  LogLevel ERROR",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    `  ${renderProxyCommand(coderBinaryPath)}`,
    MUX_CODER_SSH_BLOCK_END,
  ].join("\n");
}

function countOccurrences(content: string, marker: string): number {
  if (marker.length === 0) {
    return 0;
  }

  return content.split(marker).length - 1;
}

export interface ManagedBlockMarkers {
  start: string;
  end: string;
  /** Names the block in corruption errors (e.g. "Coder"). */
  label: string;
}

/** The marked block's full lines: from its start marker's line through its end marker's newline. */
function findBlockLines(
  existingContent: string,
  markers: ManagedBlockMarkers
): { start: number; end: number; hadTrailingNewline: boolean } {
  const startMarkerIndex = existingContent.indexOf(markers.start);
  const endMarkerIndex = existingContent.indexOf(markers.end, startMarkerIndex);

  if (startMarkerIndex === -1 || endMarkerIndex === -1 || endMarkerIndex < startMarkerIndex) {
    throw new Error(`Corrupted SSH config: invalid Xum ${markers.label} SSH marker order.`);
  }

  const lineStartIndex = existingContent.lastIndexOf("\n", startMarkerIndex);
  const lineEndIndex = existingContent.indexOf("\n", endMarkerIndex);
  return {
    start: lineStartIndex === -1 ? 0 : lineStartIndex + 1,
    end: lineEndIndex === -1 ? existingContent.length : lineEndIndex + 1,
    hadTrailingNewline: lineEndIndex !== -1,
  };
}

function replaceMuxBlock(
  existingContent: string,
  nextMuxBlock: string,
  markers: ManagedBlockMarkers
): string {
  const lines = findBlockLines(existingContent, markers);
  const beforeBlock = existingContent.slice(0, lines.start);
  const afterBlock = existingContent.slice(lines.end);

  if (afterBlock.length === 0) {
    const suffix = lines.hadTrailingNewline ? "\n" : "";
    return `${beforeBlock}${nextMuxBlock}${suffix}`;
  }

  return `${beforeBlock}${nextMuxBlock}\n${afterBlock}`;
}

/** Puts the block on the first line, moving it there if it sits anywhere else. */
function prependMuxBlock(
  existingContent: string,
  nextMuxBlock: string,
  markers: ManagedBlockMarkers,
  hasBlock: boolean
): string {
  let rest = existingContent;
  if (hasBlock) {
    const lines = findBlockLines(existingContent, markers);
    rest = existingContent.slice(0, lines.start) + existingContent.slice(lines.end);
  }
  return `${nextMuxBlock}\n${rest}`;
}

function appendMuxBlock(existingContent: string, nextMuxBlock: string): string {
  if (existingContent.length === 0) {
    return `${nextMuxBlock}\n`;
  }

  if (existingContent.endsWith("\n")) {
    return `${existingContent}${nextMuxBlock}\n`;
  }

  return `${existingContent}\n${nextMuxBlock}\n`;
}

/**
 * Manually follow a symlink chain to find the intended final target,
 * even when the final target file doesn't exist yet (dangling).
 * Throws on symlink loops (visited set check).
 */
async function followSymlinkChain(symlinkPath: string): Promise<string> {
  const maxHops = 40; // SYMLOOP_MAX on most systems
  let current = symlinkPath;
  const visited = new Set<string>();

  for (let i = 0; i < maxHops; i++) {
    const target = await fs.readlink(current);
    const resolved = path.resolve(path.dirname(current), target);

    if (visited.has(resolved)) {
      const err = new Error(`Symlink loop detected: ${resolved}`) as NodeJS.ErrnoException;
      err.code = "ELOOP";
      throw err;
    }
    visited.add(resolved);

    try {
      const stats = await fs.lstat(resolved);
      if (!stats.isSymbolicLink()) {
        return resolved;
      }
      current = resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return resolved;
      }
      throw error;
    }
  }

  const err = new Error(`Too many levels of symbolic links: ${current}`) as NodeJS.ErrnoException;
  err.code = "ELOOP";
  throw err;
}

async function resolveSSHConfigWritePath(sshConfigPath: string): Promise<string> {
  try {
    const stats = await fs.lstat(sshConfigPath);
    if (!stats.isSymbolicLink()) {
      return sshConfigPath;
    }

    try {
      // Fast path: realpath follows full chain when target exists.
      return await fs.realpath(sshConfigPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        // Dangling symlink: target doesn't exist yet.
        // Manually follow the chain to find the intended write target.
        return await followSymlinkChain(sshConfigPath);
      }
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      // Path itself doesn't exist (not even as a symlink).
      return sshConfigPath;
    }

    throw error;
  }
}

async function loadSSHConfigContent(
  sshConfigPath: string
): Promise<{ content: string; mode: number }> {
  try {
    const [stats, content] = await Promise.all([
      fs.stat(sshConfigPath),
      fs.readFile(sshConfigPath, "utf8"),
    ]);

    return {
      content,
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        content: "",
        mode: 0o600,
      };
    }

    throw error;
  }
}

/** Per resolved ssh config path: serializes each managed block's read-modify-rename. */
const sshConfigFileLocks = new MutexMap<string>();

/** Collision-proof temp path: UUID nonce ensures uniqueness even when concurrent calls share a PID + timestamp. */
function makeAtomicTempPath(sshConfigPath: string): string {
  return `${sshConfigPath}.mux-tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
}

async function writeConfigAtomically(
  sshConfigPath: string,
  content: string,
  mode: number
): Promise<void> {
  const tempPath = makeAtomicTempPath(sshConfigPath);

  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, sshConfigPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Write one Xum-managed, marker-delimited block in the user's ssh config, leaving every other
 * line untouched. Shared by the Coder and Daytona providers.
 */
export async function ensureManagedSSHConfigBlock(opts: {
  markers: ManagedBlockMarkers;
  /** Full block text, markers included. */
  block: string;
  sshConfigPath?: string;
  /**
   * "end" (default) appends a new block and replaces an existing one in place. "top" keeps the
   * block on the first line, where OpenSSH's first-value-wins rule lets its options beat every
   * user entry; a block found elsewhere moves there.
   */
  placement?: "top" | "end";
}): Promise<void> {
  const { markers } = opts;
  const configuredSSHConfigPath = opts.sshConfigPath ?? path.join(os.homedir(), ".ssh", "config");
  // Preserve users' symlinked ~/.ssh/config setups by writing to the symlink target,
  // rather than replacing the symlink path itself.
  const sshConfigPath = await resolveSSHConfigWritePath(configuredSSHConfigPath);
  const sshConfigDir = path.dirname(sshConfigPath);

  await fs.mkdir(sshConfigDir, { recursive: true, mode: 0o700 });

  // Coder and Daytona setups can run at once, in this backend or another one sharing the config
  // (even under a different Xum root): without both locks two writers read the old file and the
  // last rename drops the other's block. The file lock sits next to the resolved config.
  await sshConfigFileLocks.withLock(sshConfigPath, async () => {
    const release = await acquireCrossProcessLock({
      lockPath: `${sshConfigPath}.xum.lock`,
      acquireTimeoutMs: 30_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is updating the ssh config.",
    });
    try {
      await writeManagedBlock(sshConfigPath, markers, opts.block, opts.placement ?? "end");
    } finally {
      await release();
    }
  });
}

async function writeManagedBlock(
  sshConfigPath: string,
  markers: ManagedBlockMarkers,
  block: string,
  placement: "top" | "end"
): Promise<void> {
  const { content: existingContent, mode: existingMode } =
    await loadSSHConfigContent(sshConfigPath);

  const startMarkerCount = countOccurrences(existingContent, markers.start);
  const endMarkerCount = countOccurrences(existingContent, markers.end);

  if (startMarkerCount > 1 || endMarkerCount > 1) {
    throw new Error(`Corrupted SSH config: duplicate Xum ${markers.label} SSH markers detected.`);
  }

  if (startMarkerCount !== endMarkerCount) {
    throw new Error(`Corrupted SSH config: mismatched Xum ${markers.label} SSH markers detected.`);
  }

  const hasBlock = startMarkerCount === 1;
  let nextContent: string;
  if (placement === "top") {
    nextContent = prependMuxBlock(existingContent, block, markers, hasBlock);
  } else {
    nextContent = hasBlock
      ? replaceMuxBlock(existingContent, block, markers)
      : appendMuxBlock(existingContent, block);
  }

  // Daytona checks its block on every ssh access: leave an unchanged file alone.
  if (nextContent === existingContent) return;
  await writeConfigAtomically(sshConfigPath, nextContent, existingMode);
}

export async function ensureMuxCoderSSHConfigFile(
  opts: EnsureMuxCoderSSHConfigFileOptions
): Promise<void> {
  await ensureManagedSSHConfigBlock({
    markers: { start: MUX_CODER_SSH_BLOCK_START, end: MUX_CODER_SSH_BLOCK_END, label: "Coder" },
    block: renderMuxBlock(opts.coderBinaryPath),
    sshConfigPath: opts.sshConfigPath,
  });
}
