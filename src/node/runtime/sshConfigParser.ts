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

async function loadSSHConfig(): Promise<SSHConfig | null> {
  const homeDir = getHomeDir();
  const configPath = path.join(homeDir, ".ssh", "config");

  try {
    const content = await fs.readFile(configPath, "utf8");
    const parsed = SSHConfig.parse(content);
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
