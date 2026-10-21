import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  XUM_DAYTONA_HOST_SUFFIX,
  XUM_DAYTONA_SSH_BLOCK_END,
  XUM_DAYTONA_SSH_BLOCK_START,
  toXumDaytonaHost,
} from "@/common/constants/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import { ensureManagedSSHConfigBlock } from "@/node/runtime/muxSshConfigWriter";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

const execFileAsync = promisify(execFile);

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
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const HOST_KEY_PATTERN = /^([A-Za-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/;

function assertValid(value: string, pattern: RegExp, what: string): void {
  if (!pattern.test(value)) {
    throw new DaytonaSshConfigError(`Refusing to write an invalid Daytona ${what} to ssh config`);
  }
}

/**
 * A DNS name or an IP literal: self-hosted deployments may advertise an IPv6 gateway, which
 * OpenSSH takes in HostName and HostKeyAlias. A zone id (`%eth0`) is refused: ssh config
 * would expand its `%` as a token.
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

function quoteConfigPath(filePath: string): string {
  if (/["\r\n]/.test(filePath)) {
    throw new DaytonaSshConfigError(`Unsupported characters in path for ssh config: ${filePath}`);
  }
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/**
 * The block in `~/.ssh/config`. OpenSSH scopes an Include to the Host/Match block above it and
 * the managed block sits at the end of the file, so a bare Include would land inside the user's
 * last Host block. Scoping it to `Host *.xum--daytona` keeps it from leaking to other hosts.
 */
export function renderDaytonaManagedBlock(includePath: string): string {
  return [
    XUM_DAYTONA_SSH_BLOCK_START,
    `Host *.${XUM_DAYTONA_HOST_SUFFIX}`,
    `  Include ${quoteConfigPath(includePath)}`,
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
  return [
    `Host ${toXumDaytonaHost(input.sandboxId)}`,
    `  HostName ${input.gateway.host}`,
    `  Port ${input.gateway.port}`,
    `  User ${input.token}`,
    `  HostKeyAlias ${input.gateway.host}`,
    `  UserKnownHostsFile ${quoteConfigPath(input.knownHostsPath)}`,
    "  StrictHostKeyChecking yes",
  ].join("\n");
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

// One lock per include file across writer instances: blocks of different sandboxes share it.
const includeFileLocks = new MutexMap<string>();

export interface DaytonaSshConfigWriterOptions {
  xumHome: string;
  /** Defaults to `~/.ssh/config`; tests point it at a temp file. */
  sshConfigPath?: string;
  sshBinary?: string;
}

export class DaytonaSshConfigWriter {
  readonly paths: DaytonaSshPaths;
  private readonly sshConfigPath?: string;
  private readonly sshBinary: string;

  constructor(options: DaytonaSshConfigWriterOptions) {
    this.paths = getDaytonaSshPaths(options.xumHome);
    this.sshConfigPath = options.sshConfigPath;
    this.sshBinary = options.sshBinary ?? "ssh";
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
    await ensureManagedSSHConfigBlock({
      markers: {
        start: XUM_DAYTONA_SSH_BLOCK_START,
        end: XUM_DAYTONA_SSH_BLOCK_END,
        label: "Daytona",
      },
      block: renderDaytonaManagedBlock(this.paths.includePath),
      sshConfigPath: this.sshConfigPath,
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
    await ensurePrivateDir(this.paths.dir);
    const knownHosts = renderDaytonaKnownHosts(gateway);
    await includeFileLocks.withLock(this.paths.includePath, async () => {
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
    await ensurePrivateDir(this.paths.dir);
    await this.upsertBlock(input);
  }

  async removeSandbox(sandboxId: string): Promise<void> {
    const alias = toXumDaytonaHost(sandboxId);
    await includeFileLocks.withLock(this.paths.includePath, async () => {
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
    const block = this.renderBlock(input);
    const alias = toXumDaytonaHost(input.sandboxId);
    return includeFileLocks.withLock(this.paths.includePath, async () => {
      const blocks = await this.readBlocks();
      blocks.set(alias, block);
      await this.writeBlocks(blocks);
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

  /**
   * OpenSSH keeps the first value it sees, so a user `Host *` entry above Xum's managed block
   * silently replaces the token (`User`) or the pinned known_hosts file (`UserKnownHostsFile`).
   * Resolve the alias with `ssh -G` and fail with a clear message instead of an opaque auth or
   * host key failure. The token is never printed. A shadowed StrictHostKeyChecking needs no check
   * here: every OpenSSH invocation forces it on the command line (appendDaytonaOpenSSHArgs).
   * Skipped when no OpenSSH client is installed (the ssh2 path parses the config itself).
   */
  async verifyResolvedConfig(sandboxId: string, token: string): Promise<void> {
    const alias = toXumDaytonaHost(sandboxId);
    const args = ["-G", ...(this.sshConfigPath ? ["-F", this.sshConfigPath] : []), alias];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.sshBinary, args, { timeout: 10_000 }));
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        log.debug("Skipping Daytona ssh user check: no OpenSSH client found");
        return;
      }
      throw new DaytonaSshConfigError(
        `Could not check the ssh config for ${alias} with ssh -G (${getErrorMessage(error).split("\n")[0]})`
      );
    }
    const resolved = (key: string) =>
      stdout
        .split("\n")
        .find((line) => line.startsWith(`${key} `))
        ?.slice(key.length + 1)
        .trim();
    const shadowedBy = (setting: string) =>
      new DaytonaSshConfigError(
        `Your ssh config sets ${setting} for ${alias} before Xum's Daytona block (often a ` +
          `"Host *" entry with ${setting}), and OpenSSH keeps the first value. Move that ` +
          `${setting} line below the "${XUM_DAYTONA_SSH_BLOCK_START}" block in ~/.ssh/config or ` +
          `scope it to specific hosts.`
      );
    if (resolved("user") !== token) {
      throw shadowedBy("User");
    }
    // ssh -G prints every known_hosts file on one line, separated by spaces.
    const knownHostsFiles = ` ${resolved("userknownhostsfile") ?? ""} `;
    if (!knownHostsFiles.includes(` ${this.paths.knownHostsPath} `)) {
      throw shadowedBy("UserKnownHostsFile");
    }
  }
}
