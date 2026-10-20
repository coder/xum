/**
 * SSH config parsing utilities (ssh-config wrapper).
 */

import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import SSHConfig, { glob } from "ssh-config";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";

interface ParsedValueToken {
  val: string;
  separator: string;
  quoted?: boolean;
}
const DEFAULT_SSH_PORT = 22;

export interface ResolvedSSHConfig {
  host: string;
  hostName: string;
  user?: string;
  port: number;
  identityFiles: string[];
  proxyCommand?: string;
}

function getHomeDir(): string {
  return process.env.USERPROFILE ?? os.homedir();
}
function getDefaultUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "";
  }
}

function expandHomePath(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }

  return value;
}

function normalizeIdentityFile(value: string, homeDir: string): string {
  const expanded = expandHomePath(value, homeDir);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  return path.join(homeDir, expanded);
}

function parseHostAndUser(host: string): { host: string; user?: string } {
  const trimmed = host.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > 0) {
    const user = trimmed.slice(0, atIndex).trim();
    const hostname = trimmed.slice(atIndex + 1).trim();
    if (user && hostname) {
      return { host: hostname, user };
    }
  }

  return { host: trimmed };
}

function isParsedValueToken(value: unknown): value is ParsedValueToken {
  return typeof value === "object" && value !== null && "val" in value && "separator" in value;
}

function tokensToString(tokens: ParsedValueToken[]): string {
  return tokens
    .map(({ val, separator, quoted }) => {
      const rendered = quoted ? `"${val}"` : val;
      return `${separator}${rendered}`;
    })
    .join("")
    .trimStart();
}

type ComputedConfigValue = string | string[] | ParsedValueToken[];

function getConfigValue(
  config: Record<string, ComputedConfigValue>,
  key: string
): ComputedConfigValue | undefined {
  const match = Object.entries(config).find(
    ([configKey]) => configKey.toLowerCase() === key.toLowerCase()
  );
  return match?.[1];
}

function toStringValue(value: ComputedConfigValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") {
      return first;
    }
    if (isParsedValueToken(first)) {
      return tokensToString(value as ParsedValueToken[]);
    }
  }

  return undefined;
}

type MatchCriteriaValue = string | Array<{ val: string; separator: string; quoted?: boolean }>;

function getCriteriaValue(
  criteria: Record<string, MatchCriteriaValue>,
  key: string
): MatchCriteriaValue | undefined {
  const match = Object.entries(criteria).find(
    ([criteriaKey]) => criteriaKey.toLowerCase() === key.toLowerCase()
  );
  return match?.[1];
}

function criteriaToString(value: MatchCriteriaValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0]?.val;
  }

  return undefined;
}

function criteriaToStringArray(value: MatchCriteriaValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.map(({ val }) => val);
  }

  return [];
}

function expandMatchExecTokens(command: string, hostName: string, user?: string): string {
  return command.replace(/%(%|h|r)/g, (_match, token) => {
    switch (token) {
      case "%":
        return "%";
      case "h":
        return hostName;
      case "r":
        return user ?? "";
      default:
        return _match;
    }
  });
}

/**
 * Handle `Match host ... !exec ...` blocks that ssh-config doesn't evaluate.
 *
 * Limitation: Only applies ProxyCommand from matching Match blocks. Other directives
 * like User, Port, IdentityFile in the same block are ignored. This is sufficient for
 * Coder configs which only set ProxyCommand in Match blocks.
 */
function applyNegatedExecMatch(
  config: SSHConfig,
  hostName: string,
  user: string | undefined,
  computed: Record<string, ComputedConfigValue>
): void {
  if (getConfigValue(computed, "ProxyCommand")) {
    return;
  }

  for (const line of config) {
    if (line.type !== SSHConfig.DIRECTIVE || line.param !== "Match") {
      continue;
    }

    if (!("criteria" in line)) {
      continue;
    }

    const criteria = line.criteria as Record<string, MatchCriteriaValue>;
    const hostCriterion = getCriteriaValue(criteria, "host");
    const negatedExec = getCriteriaValue(criteria, "!exec");

    if (!hostCriterion || !negatedExec) {
      continue;
    }

    const hostPatterns = criteriaToStringArray(hostCriterion);
    if (!glob(hostPatterns, hostName)) {
      continue;
    }

    const execCommand = criteriaToString(negatedExec);
    if (!execCommand) {
      continue;
    }

    const expandedCommand = expandMatchExecTokens(execCommand, hostName, user);
    const execResult = spawnSync(expandedCommand, { shell: true });

    if (execResult.status === 0) {
      continue;
    }

    const proxyLine = line.config.find(
      (subline) =>
        subline.type === SSHConfig.DIRECTIVE && subline.param.toLowerCase() === "proxycommand"
    );

    if (proxyLine?.type === SSHConfig.DIRECTIVE) {
      computed.ProxyCommand = proxyLine.value as ComputedConfigValue;
      return;
    }
  }
}

function toStringArray(value: ComputedConfigValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") {
      return value as string[];
    }
    if (isParsedValueToken(first)) {
      return [tokensToString(value as ParsedValueToken[])];
    }
  }

  return [];
}

// OpenSSH's READCONF_MAX_DEPTH.
const MAX_INCLUDE_DEPTH = 16;
const INCLUDE_LINE_PATTERN = /^\s*include(?:\s*=\s*|\s+)(.+?)\s*$/i;
const SECTION_LINE_PATTERN = /^\s*(?:host|match)(?:\s*=\s*|\s+)\S/i;

function splitIncludeArgs(value: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const arg = match[1] ?? match[2];
    if (arg) args.push(arg);
  }
  return args;
}

async function resolveIncludePaths(value: string, homeDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const arg of splitIncludeArgs(value)) {
    const expanded = expandHomePath(arg, homeDir);
    // OpenSSH resolves relative user-config Include paths against ~/.ssh.
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(homeDir, ".ssh", expanded);
    const baseName = path.basename(absolute);
    if (!/[*?]/.test(baseName)) {
      files.push(absolute);
      continue;
    }
    // Wildcards are supported in the file name only (OpenSSH globs the whole path).
    try {
      const entries = await fs.readdir(path.dirname(absolute));
      files.push(
        ...entries
          .filter((entry) => glob([baseName], entry))
          .sort()
          .map((entry) => path.join(path.dirname(absolute), entry))
      );
    } catch (error) {
      log.debug("Failed to expand SSH config Include", {
        include: absolute,
        error: getErrorMessage(error),
      });
    }
  }
  return files;
}

/** The expanded content of each file one Include line names, in order. */
async function readIncludedFiles(value: string, homeDir: string, depth: number): Promise<string[]> {
  const contents: string[] = [];
  for (const file of await resolveIncludePaths(value, homeDir)) {
    try {
      contents.push(await expandIncludes(await fs.readFile(file, "utf8"), homeDir, depth));
    } catch (error) {
      // OpenSSH skips missing include files silently.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        log.debug("Failed to read SSH config Include", {
          include: file,
          error: getErrorMessage(error),
        });
      }
    }
  }
  return contents;
}

/**
 * Inline `Include` directives, which the ssh-config package does not resolve (Xum's Daytona
 * block relies on one). An Include inside a Host/Match block is followed by that block's header
 * again, so later lines of the block stay scoped to it as in OpenSSH. Approximation: Host blocks
 * inside the included file are not additionally gated by the enclosing block's pattern.
 */
async function expandIncludes(content: string, homeDir: string, depth: number): Promise<string> {
  const out: string[] = [];
  let sectionHeader: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (SECTION_LINE_PATTERN.test(line)) {
      sectionHeader = line.trim();
      out.push(line);
      continue;
    }
    const includeMatch = INCLUDE_LINE_PATTERN.exec(line);
    if (!includeMatch) {
      out.push(line);
      continue;
    }
    if (depth >= MAX_INCLUDE_DEPTH) {
      log.debug("SSH config Include nesting too deep; ignoring", { include: includeMatch[1] });
      continue;
    }
    out.push(...(await readIncludedFiles(includeMatch[1], homeDir, depth + 1)));
    if (sectionHeader) {
      out.push(sectionHeader);
    }
  }
  return out.join("\n");
}

async function loadSSHConfig(): Promise<SSHConfig | null> {
  const homeDir = getHomeDir();
  const configPath = path.join(homeDir, ".ssh", "config");

  try {
    const content = await fs.readFile(configPath, "utf8");
    const parsed = SSHConfig.parse(await expandIncludes(content, homeDir, 0));
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      log.debug("Failed to read SSH config", {
        configPath,
        error: getErrorMessage(error),
      });
    }
    return null;
  }
}

export async function resolveSSHConfig(host: string): Promise<ResolvedSSHConfig> {
  const { host: hostAlias, user: userOverride } = parseHostAndUser(host);
  const homeDir = getHomeDir();

  const config = await loadSSHConfig();
  const computed = config
    ? userOverride
      ? config.compute({ Host: hostAlias, User: userOverride })
      : config.compute(hostAlias)
    : {};

  const hostName = toStringValue(getConfigValue(computed, "HostName")) ?? hostAlias;
  const userFromConfig = toStringValue(getConfigValue(computed, "User"));

  if (config) {
    // Default to local username for %r expansion if no User is specified
    const matchExecUser = userOverride ?? userFromConfig ?? getDefaultUsername();
    applyNegatedExecMatch(config, hostName, matchExecUser, computed);
  }

  const portValue = toStringValue(getConfigValue(computed, "Port"));
  const identityValues = toStringArray(getConfigValue(computed, "IdentityFile"));
  const proxyCommandRaw = toStringValue(getConfigValue(computed, "ProxyCommand"));

  const port = portValue ? Number.parseInt(portValue, 10) : DEFAULT_SSH_PORT;

  const identityFiles = identityValues.map((value) => normalizeIdentityFile(value, homeDir));

  const proxyCommand =
    proxyCommandRaw && proxyCommandRaw.toLowerCase() !== "none"
      ? proxyCommandRaw.trim()
      : undefined;

  return {
    host: hostAlias,
    hostName,
    user: userOverride ?? userFromConfig,
    port: Number.isFinite(port) ? port : DEFAULT_SSH_PORT,
    identityFiles,
    proxyCommand,
  };
}
