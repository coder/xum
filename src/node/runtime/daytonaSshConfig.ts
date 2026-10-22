import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
  XUM_DAYTONA_HOST_SUFFIX,
  XUM_DAYTONA_SSH_BLOCK_END,
  XUM_DAYTONA_SSH_BLOCK_START,
  toXumDaytonaHost,
} from "@/common/constants/daytona";
import { getXumHome } from "@/common/constants/paths";
import { ensureManagedSSHConfigBlock } from "@/node/runtime/muxSshConfigWriter";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * SSH plumbing for Daytona sandboxes, reached through Daytona's SSH gateway where the access
 * token is the ssh username.
 *
 * Tokens stay out of argv and persisted runtime config: each sandbox gets a `Host
 * <id>.xum--daytona` block in a 0600 include file under the Xum home, and `~/.ssh/config` only
 * carries a managed block that includes that file. Token refresh rewrites only the include
 * file; the ssh connection pool keys on the alias, so pooled masters survive a refresh.
 */

export interface DaytonaSshGateway {
  host: string;
  port: number;
  /** OpenSSH public key lines (`<type> <base64>`) from Daytona's `/config`. */
  hostKeys: string[];
}

export interface DaytonaSshPaths {
  dir: string;
  includePath: string;
  knownHostsPath: string;
}

export function getDaytonaSshPaths(xumHome: string): DaytonaSshPaths {
  const dir = path.join(xumHome, "ssh");
  return {
    dir,
    includePath: path.join(dir, "daytona.conf"),
    knownHostsPath: path.join(dir, "daytona_known_hosts"),
  };
}

// The include file of the writer this backend built last (its DaytonaService's, which may use
// a root other than getXumHome()).
let activeIncludePath: string | undefined;

/**
 * The only ssh config a Daytona alias is resolved from, by OpenSSH (`-F`) and ssh2 alike. A user
 * entry matching the alias (a `Host *` KnownHostsCommand, `Match exec`, ProxyCommand) would run
 * a local command that gets the token as `%r`, and `-o` cannot override a Match exec.
 */
export function getDaytonaSshConfigPath(): string {
  return activeIncludePath ?? getDaytonaSshPaths(getXumHome()).includePath;
}

export class DaytonaSshConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaSshConfigError";
  }
}

// Everything rendered into ssh config is validated first: a newline or quote in a control-plane
// value would let it inject arbitrary ssh directives (ProxyCommand runs local commands).
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;
// Dot-separated labels (no empty one), optionally absolute: one trailing dot.
const HOSTNAME_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*\\.?$`);
const HOST_KEY_PATTERN = /^([A-Za-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/;

function assertValid(value: string, pattern: RegExp, what: string): void {
  if (!pattern.test(value)) {
    throw new DaytonaSshConfigError(`Refusing to write an invalid Daytona ${what} to ssh config`);
  }
}

/**
 * A DNS name or an IP literal: self-hosted deployments may advertise an IPv6 gateway, which
 * OpenSSH takes in HostName and HostKeyAlias. A zone id (`%eth0`) is refused: ssh config
 * would expand its `%` as a token. An absolute name keeps its trailing dot: HostName,
 * HostKeyAlias and the pinned known_hosts lines all carry the same string, which OpenSSH and
 * the ssh2 pin check use as written.
 */
function isGatewayHost(host: string): boolean {
  return HOSTNAME_PATTERN.test(host) || (net.isIPv6(host) && !host.includes("%"));
}

function validateGateway(gateway: DaytonaSshGateway): void {
  if (!isGatewayHost(gateway.host)) {
    throw new DaytonaSshConfigError(
      "Refusing to write an invalid Daytona gateway host to ssh config"
    );
  }
  if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535) {
    throw new DaytonaSshConfigError("Refusing to write an invalid Daytona gateway port");
  }
}

// Letters (with combining marks, as macOS may store them decomposed), digits, a few punctuation
// marks and the platform's separators; Windows paths also carry `\` and the drive's `:`.
const SSH_LITERAL_PATH_CHAR =
  process.platform === "win32"
    ? /^[\p{L}\p{M}\p{N} ._\-+@,=~/\\:]$/u
    : /^[\p{L}\p{M}\p{N} ._\-+@,=~/]$/u;

function quoteConfigPath(filePath: string): string {
  if (/["\r\n]/.test(filePath)) {
    throw new DaytonaSshConfigError(`Unsupported characters in path for ssh config: ${filePath}`);
  }
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/**
 * The block in `~/.ssh/config`, which an editor's own ssh reads (Xum's ssh reads the include
 * file alone, via `-F`). It goes first in the file: OpenSSH keeps the first value it reads for an
 * option, so the alias's hardening beats any user entry such as a `Host *` that turns off host
 * key checking or forwards the agent. The Include is scoped to `Host *.xum--daytona` so it
 * reaches no other host, and the closing `Host *` puts the user's top-level lines that follow
 * back in scope for every host, as they were before the block.
 */
export function renderDaytonaManagedBlock(includePath: string): string {
  return [
    XUM_DAYTONA_SSH_BLOCK_START,
    `Host *.${XUM_DAYTONA_HOST_SUFFIX}`,
    `  Include ${quoteConfigPath(includePath)}`,
    "Host *",
    XUM_DAYTONA_SSH_BLOCK_END,
  ].join("\n");
}

/**
 * known_hosts lines for the gateway. With `HostKeyAlias` set OpenSSH looks keys up under the bare
 * alias, while `[host]:port` is the form the Daytona spec documents for a non-22 port (and what
 * non-alias clients look up), so a non-22 gateway gets both forms.
 */
export function renderDaytonaKnownHosts(gateway: DaytonaSshGateway): string {
  validateGateway(gateway);
  const hostPatterns =
    gateway.port === 22 ? [gateway.host] : [gateway.host, `[${gateway.host}]:${gateway.port}`];
  const lines: string[] = [];
  for (const rawKey of gateway.hostKeys) {
    const match = HOST_KEY_PATTERN.exec(rawKey.trim());
    if (!match) {
      log.warn("Skipping a malformed Daytona gateway host key", { gatewayHost: gateway.host });
      continue;
    }
    for (const hostPattern of hostPatterns) {
      lines.push(`${hostPattern} ${match[1]} ${match[2]}`);
    }
  }
  if (lines.length === 0) {
    throw new DaytonaSshConfigError(
      `Daytona did not provide a usable host key for its SSH gateway ${gateway.host}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderDaytonaHostBlock(input: {
  sandboxId: string;
  token: string;
  gateway: DaytonaSshGateway;
  knownHostsPath: string;
}): string {
  assertValid(input.sandboxId, SANDBOX_ID_PATTERN, "sandbox id");
  assertValid(input.token, TOKEN_PATTERN, "SSH token");
  validateGateway(input.gateway);
  // The sandbox and the network path to the gateway are untrusted, and an editor's ssh reads
  // this block before the user's entries, so it must not inherit their proxy (which would see
  // the token), agent, display or local commands. `ProxyCommand none` comes first: OpenSSH then
  // ignores a later ProxyJump too. KnownHostsCommand is left alone: OpenSSH before 8.5 rejects it
  // unless an `IgnoreUnknown` covers it, and ours would replace the user's own `IgnoreUnknown`
  // (first value wins). `Tunnel no` keeps a user's `Tunnel` from giving the sandbox a tun device.
  // Forwards are not first-value-wins (see hasInheritedRemoteForward), and those an editor asks
  // for on its command line are left alone.
  return [
    `Host ${toXumDaytonaHost(input.sandboxId)}`,
    "  ProxyCommand none",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PermitLocalCommand no",
    "  Tunnel no",
    `  HostName ${input.gateway.host}`,
    `  Port ${input.gateway.port}`,
    `  User ${input.token}`,
    `  HostKeyAlias ${input.gateway.host}`,
    `  UserKnownHostsFile ${quoteConfigPath(input.knownHostsPath)}`,
    "  StrictHostKeyChecking yes",
  ].join("\n");
}

const RESOLVE_ALIAS_TIMEOUT_MS = 10_000;

/**
 * Whether an editor's ssh would open a reverse forward into the sandbox for `alias`: OpenSSH
 * adds up every RemoteForward that matches instead of keeping the first, so Xum's block cannot
 * turn a user's `Host *` one off, and ClearAllForwardings would also drop the tunnel an editor
 * opens on its command line. Resolved as the editor does (`ssh -G` with the user's and the
 * system config). Throws when ssh cannot resolve the alias, so a caller fails closed. The output
 * holds the token (as `user`): it is never logged or put in an error.
 */
export function hasInheritedRemoteForward(
  alias: string,
  /** Tests read a temp config instead of the user's (`-F` skips the system config too). */
  options: { sshConfigPath?: string } = {}
): Promise<boolean> {
  const args = options.sshConfigPath ? ["-G", "-F", options.sshConfigPath, alias] : ["-G", alias];
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      args,
      { timeout: RESOLVE_ALIAS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "unknown";
          reject(
            new DaytonaSshConfigError(
              `Could not check your SSH config for ${alias} (ssh -G failed: ${String(code)})`
            )
          );
          return;
        }
        resolve(/^remoteforward\s/im.test(stdout));
      }
    );
  });
}

const INCLUDE_FILE_HEADER =
  "# Managed by Xum (Daytona sandboxes). Xum rewrites this file; do not edit it.";

/** Split the include file into per-alias blocks (the file only ever holds what Xum rendered). */
function parseIncludeBlocks(content: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let currentAlias: string | undefined;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentAlias) blocks.set(currentAlias, currentLines.join("\n").trimEnd());
  };
  for (const line of content.split("\n")) {
    const hostMatch = /^Host\s+(\S+)\s*$/.exec(line);
    if (hostMatch) {
      flush();
      currentAlias = hostMatch[1];
      currentLines = [line];
    } else if (currentAlias) {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

function renderIncludeFile(blocks: Map<string, string>): string {
  return `${[INCLUDE_FILE_HEADER, ...blocks.values()].join("\n\n")}\n`;
}

function tokensIn(blocks: Map<string, string>): Array<{ sandboxId: string; token: string }> {
  const suffix = `.${XUM_DAYTONA_HOST_SUFFIX}`;
  const tokens: Array<{ sandboxId: string; token: string }> = [];
  for (const [alias, block] of blocks) {
    const token = /^\s*User\s+(\S+)\s*$/m.exec(block)?.[1];
    if (alias.endsWith(suffix) && token) {
      tokens.push({ sandboxId: alias.slice(0, -suffix.length), token });
    }
  }
  return tokens;
}

// One lock per include file across writer instances in this process (withIncludeFileLock adds
// the cross-process one): blocks of different sandboxes share it.
const includeFileLocks = new MutexMap<string>();

export interface DaytonaSshConfigWriterOptions {
  xumHome: string;
  /** Defaults to `~/.ssh/config`; tests point it at a temp file. */
  sshConfigPath?: string;
}

export class DaytonaSshConfigWriter {
  readonly paths: DaytonaSshPaths;
  private readonly sshConfigPath?: string;

  constructor(options: DaytonaSshConfigWriterOptions) {
    this.paths = getDaytonaSshPaths(options.xumHome);
    activeIncludePath = this.paths.includePath;
    this.sshConfigPath = options.sshConfigPath;
  }

  /** First write for a sandbox: known_hosts, its include block, and the managed ssh block. */
  async writeSandbox(input: {
    sandboxId: string;
    token: string;
    gateway: DaytonaSshGateway;
  }): Promise<void> {
    await this.installGateway(input.gateway, (blocks) =>
      blocks.set(toXumDaytonaHost(input.sandboxId), this.renderBlock(input))
    );
    await this.ensureManagedBlock();
  }

  /**
   * The `~/.ssh/config` block that includes the sandboxes' file for the user's own ssh clients.
   * Another tool may remove it while the include file and its tokens stay; no write when it is
   * already in place.
   */
  async ensureManagedBlock(): Promise<void> {
    await ensureManagedSSHConfigBlock({
      markers: {
        start: XUM_DAYTONA_SSH_BLOCK_START,
        end: XUM_DAYTONA_SSH_BLOCK_END,
        label: "Daytona",
      },
      block: renderDaytonaManagedBlock(this.paths.includePath),
      sshConfigPath: this.sshConfigPath,
      placement: "top",
    });
  }

  /** Daytona moved its gateway: repoint every sandbox's block (keeping its token) and pins. */
  async repointGateway(gateway: DaytonaSshGateway): Promise<void> {
    await this.installGateway(gateway, () => undefined);
  }

  /**
   * known_hosts is shared by every alias: a gateway change repoints them all (each keeps its
   * token) in the same step, or another sandbox's turn would dial the old host with new pins.
   */
  private async installGateway(
    gateway: DaytonaSshGateway,
    edit: (blocks: Map<string, string>) => void
  ): Promise<void> {
    const knownHosts = renderDaytonaKnownHosts(gateway);
    this.assertPathsReadLiterallyBySsh();
    await this.withIncludeFileLock(async () => {
      await writeFileAtomic(this.paths.knownHostsPath, knownHosts, {
        encoding: "utf-8",
        mode: 0o600,
      });
      const blocks = await this.readBlocks();
      for (const other of tokensIn(blocks)) {
        blocks.set(toXumDaytonaHost(other.sandboxId), this.renderBlock({ ...other, gateway }));
      }
      edit(blocks);
      await this.writeBlocks(blocks);
    });
  }

  /** Token refresh: rewrites only the include file, never `~/.ssh/config` or known_hosts. */
  async updateToken(input: {
    sandboxId: string;
    token: string;
    gateway: DaytonaSshGateway;
  }): Promise<void> {
    await this.upsertBlock(input);
  }

  async removeSandbox(sandboxId: string): Promise<void> {
    const alias = toXumDaytonaHost(sandboxId);
    await this.withIncludeFileLock(async () => {
      const blocks = await this.readBlocks();
      if (!blocks.delete(alias)) return;
      await this.writeBlocks(blocks);
    });
  }

  /** The sandbox ids and tokens the include file holds (written by this or an earlier process). */
  async readTokens(): Promise<Array<{ sandboxId: string; token: string }>> {
    return tokensIn(await this.readBlocks());
  }

  private renderBlock(input: { sandboxId: string; token: string; gateway: DaytonaSshGateway }) {
    return renderDaytonaHostBlock({ ...input, knownHostsPath: this.paths.knownHostsPath });
  }

  private upsertBlock(input: {
    sandboxId: string;
    token: string;
    gateway: DaytonaSshGateway;
  }): Promise<void> {
    this.assertPathsReadLiterallyBySsh();
    const block = this.renderBlock(input);
    const alias = toXumDaytonaHost(input.sandboxId);
    return this.withIncludeFileLock(async () => {
      const blocks = await this.readBlocks();
      blocks.set(alias, block);
      await this.writeBlocks(blocks);
    });
  }

  /**
   * The Include and UserKnownHostsFile paths go into ssh config, where OpenSSH reads `%` as a
   * token, globs Include paths and parses quotes and backslashes. Escaping is not an option:
   * OpenSSH versions disagree on it (older ones read Include paths without token expansion), so
   * only characters every version reads literally are allowed.
   */
  private assertPathsReadLiterallyBySsh(): void {
    const offending = [...this.paths.dir].find((char) => !SSH_LITERAL_PATH_CHAR.test(char));
    if (offending !== undefined) {
      throw new DaytonaSshConfigError(
        `Daytona ssh setup cannot use ${this.paths.dir}: ssh does not read ${JSON.stringify(offending)} ` +
          `in config paths literally. Use a Xum root (XUM_ROOT) and home directory without it.`
      );
    }
  }

  /**
   * Every read-modify-write of the include file (and known_hosts) runs under this. Another
   * backend on the same Xum root (a desktop app next to `xum server`) has its own MutexMap:
   * without the file lock, two writers read the same file and the later rename drops the
   * other's alias. Callers never nest it.
   */
  private async withIncludeFileLock(fn: () => Promise<void>): Promise<void> {
    await ensurePrivateDir(this.paths.dir);
    await includeFileLocks.withLock(this.paths.includePath, async () => {
      const release = await acquireCrossProcessLock({
        lockPath: `${this.paths.includePath}.lock`,
        acquireTimeoutMs: 30_000,
        staleMs: 60_000,
        timeoutMessage: "Another Xum process is updating the Daytona ssh config.",
      });
      try {
        await fn();
      } finally {
        await release();
      }
    });
  }

  private async readBlocks(): Promise<Map<string, string>> {
    try {
      return parseIncludeBlocks(await fs.readFile(this.paths.includePath, "utf-8"));
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return new Map();
      throw error;
    }
  }

  private async writeBlocks(blocks: Map<string, string>): Promise<void> {
    await writeFileAtomic(this.paths.includePath, renderIncludeFile(blocks), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}
