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
  /** First UserKnownHostsFile, home-expanded (ssh2 verifies pinned Daytona keys against it). */
  userKnownHostsFile?: string;
  hostKeyAlias?: string;
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
const HOST_LINE_PATTERN = /^\s*host(?:\s*=\s*|\s+)(.+?)\s*$/i;
const MATCH_ALL_LINE_PATTERN = /^\s*match(?:\s*=\s*|\s+)all\s*$/i;

/**
 * A config line's arguments, split as OpenSSH 8.6+ does (misc.c's argv_split): quotes may
 * appear anywhere in an argument, a backslash escapes a quote, a backslash or (unquoted) a
 * space, and an argument that starts with # ends the line. An unclosed quote makes OpenSSH
 * reject the line: it yields no arguments here.
 */
function splitIncludeArgs(value: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (isConfigBlank(value[index])) {
      index++;
      continue;
    }
    if (value[index] === "#") break;
    const read = readConfigArg(value, index);
    if (!read) return [];
    if (read.arg) args.push(read.arg);
    index = read.end;
  }
  return args;
}

function readConfigArg(value: string, start: number): { arg: string; end: number } | undefined {
  let arg = "";
  let quote = "";
  let index = start;
  while (index < value.length && (quote || !isConfigBlank(value[index]))) {
    const step = configArgStep(value, index, quote);
    arg += step.text;
    quote = step.quote;
    index += step.length;
  }
  return quote ? undefined : { arg, end: index };
}

/** One character (or escape pair) of an argument: the text it adds and the quote after it. */
function configArgStep(
  value: string,
  index: number,
  quote: string
): { text: string; quote: string; length: number } {
  const char = value[index];
  const next = value[index + 1];
  if (char === "\\" && isConfigEscape(next, quote)) return { text: next, quote, length: 2 };
  if (quote)
    return { text: char === quote ? "" : char, quote: char === quote ? "" : quote, length: 1 };
  if (char === '"' || char === "'") return { text: "", quote: char, length: 1 };
  return { text: char, quote, length: 1 };
}

function isConfigBlank(char: string): boolean {
  return char === " " || char === "\t";
}

function isConfigEscape(next: string | undefined, quote: string): boolean {
  return next === "'" || next === '"' || next === "\\" || (!quote && next === " ");
}

/**
 * An Include argument with its `${VAR}` references and %-tokens expanded, as OpenSSH 9.9+
 * does (readconf.c's percent_dollar_expand). Undefined skips the argument, as OpenSSH does
 * on an expansion error: an unset variable or an unknown token. The tokens that depend on
 * options set earlier in the parse (%h after a HostName, %k, %p, %r, %C, %j) are not tracked
 * by this pass and skip it too: skipping can only miss an option, where a guess could read
 * another host's file.
 */
function expandIncludeArg(arg: string, homeDir: string, host: string): string | undefined {
  const localHost = os.hostname();
  const tokens: Record<string, string | undefined> = {
    "%": "%",
    d: homeDir,
    i: process.getuid?.().toString(),
    L: localHost.split(".")[0],
    l: localHost,
    n: host,
    u: getDefaultUsername(),
  };
  let failed = false;
  // `${NAME}` (an unclosed `${` fails) or `%` and the character after it.
  const expanded = arg.replace(
    /\$\{([^}]*)(\})?|%(.?)/gs,
    (match, name: string | undefined, close: string | undefined, token: string | undefined) => {
      const variable = close ? process.env[name ?? ""] : undefined;
      const value = token === undefined ? variable : tokens[token];
      if (value === undefined) failed = true;
      return value ?? match;
    }
  );
  if (failed) {
    log.debug("Skipping an SSH config Include argument that does not expand", { include: arg });
    return undefined;
  }
  return expanded;
}

async function resolveIncludePaths(
  value: string,
  homeDir: string,
  host: string
): Promise<string[]> {
  const files: string[] = [];
  for (const arg of splitIncludeArgs(value)) {
    const tokenized = expandIncludeArg(arg, homeDir, host);
    if (tokenized === undefined) continue;
    const expanded = expandHomePath(tokenized, homeDir);
    // OpenSSH resolves relative user-config Include paths against ~/.ssh.
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(homeDir, ".ssh", expanded);
    files.push(...(await globPath(absolute)));
  }
  return files;
}

/**
 * The paths `pattern` names, as OpenSSH's glob(3) of an Include: any segment may hold a
 * wildcard, matches are existing paths sorted, and no match includes nothing. A pattern
 * without wildcards names its one path, read (or skipped when missing) like any other.
 */
async function globPath(pattern: string): Promise<string[]> {
  // Normalized so a Windows path split on path.sep keeps its "/" separators apart too.
  const normalized = path.normalize(pattern);
  const { root } = path.parse(normalized);
  let matches = [root];
  for (const segment of normalized.slice(root.length).split(path.sep).filter(Boolean)) {
    const matcher = segmentMatcher(segment);
    if (!matcher) {
      matches = matches.map((dir) => path.join(dir, segment));
      continue;
    }
    const next: string[][] = [];
    for (const dir of matches) next.push(await matchingEntries(dir, segment, matcher));
    matches = next.flat();
  }
  return matches.sort();
}

async function matchingEntries(dir: string, segment: string, matcher: RegExp): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    // glob(3) matches a leading "." only with a literal one.
    const dotFiles = segment.startsWith(".");
    return entries
      .filter((entry) => (dotFiles || !entry.startsWith(".")) && matcher.test(entry))
      .map((entry) => path.join(dir, entry));
  } catch (error) {
    log.debug("Failed to expand SSH config Include", {
      include: path.join(dir, segment),
      error: getErrorMessage(error),
    });
    return [];
  }
}

const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;
const escapeRegExp = (text: string) => text.replace(REGEXP_SPECIAL, "\\$&");

/**
 * One path segment of a glob(3) pattern as a RegExp: `*`, `?` (one character), bracket
 * expressions (`[ab]`, `[a-z]`, negated by a leading `!` or `^`; an unclosed `[` is literal)
 * and `\` escapes. Undefined when the segment has no wildcard.
 */
function segmentMatcher(segment: string): RegExp | undefined {
  let source = "";
  let wildcard = false;
  for (let i = 0; i < segment.length; i++) {
    const token = segmentToken(segment, i);
    source += token.source;
    wildcard ||= token.wildcard;
    i = token.end;
  }
  return wildcard ? new RegExp(`^${source}$`, "s") : undefined;
}

const WILDCARD_SOURCES = new Map([
  ["*", ".*"],
  ["?", "."],
]);

/** The RegExp source of the pattern element at `i`, and the index of its last character. */
function segmentToken(
  segment: string,
  i: number
): { source: string; end: number; wildcard: boolean } {
  const wildcardSource = WILDCARD_SOURCES.get(segment[i]);
  if (wildcardSource !== undefined) return { source: wildcardSource, end: i, wildcard: true };
  const bracket = segment[i] === "[" ? bracketExpression(segment, i) : undefined;
  if (bracket) return { ...bracket, wildcard: true };
  const end = segment[i] === "\\" && i + 1 < segment.length ? i + 1 : i;
  return { source: escapeRegExp(segment[end]), end, wildcard: false };
}

/** The bracket expression opening at `start`, or undefined when it never closes. */
function bracketExpression(
  segment: string,
  start: number
): { source: string; end: number } | undefined {
  const negated = segment[start + 1] === "!" || segment[start + 1] === "^";
  let i = start + (negated ? 2 : 1);
  const items: Array<string | undefined> = [];
  // A "]" right after the opening (and its negation) is a member, not the close.
  for (let first = true; i < segment.length && (first || segment[i] !== "]"); first = false) {
    const member = bracketMember(segment, i);
    items.push(member.source);
    i = member.next;
  }
  if (i >= segment.length) return undefined;
  return { source: bracketSource(items, negated), end: i };
}

/** An unknown named class makes the whole pattern match nothing, as glob(3) refuses it. */
function bracketSource(items: Array<string | undefined>, negated: boolean): string {
  if (items.includes(undefined)) return "(?!)";
  return `[${negated ? "^" : ""}${items.join("")}]`;
}

/** glob(3)'s named classes (`[[:digit:]]`) as RegExp class contents, for the C locale. */
const NAMED_CLASSES = new Map([
  ["alnum", "0-9A-Za-z"],
  ["alpha", "A-Za-z"],
  ["blank", " \\t"],
  ["cntrl", "\\x00-\\x1f\\x7f"],
  ["digit", "0-9"],
  ["graph", "\\x21-\\x7e"],
  ["lower", "a-z"],
  ["print", "\\x20-\\x7e"],
  ["punct", "!-/:-@\\[-`{-~"],
  ["space", "\\t-\\r "],
  ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"],
]);

/**
 * The named class (`[:digit:]`) at `i`: as in glob(3), `[:` opens one only when its first `:`
 * is followed by `]`. Its source is undefined for an unknown class name.
 */
function namedClass(
  segment: string,
  i: number
): { source: string | undefined; next: number } | undefined {
  if (!segment.startsWith("[:", i)) return undefined;
  const colon = segment.indexOf(":", i + 2);
  if (colon === -1 || segment[colon + 1] !== "]") return undefined;
  return { source: NAMED_CLASSES.get(segment.slice(i + 2, colon)), next: colon + 2 };
}

/** One character, range or named class of a bracket expression, and the index after it. */
function bracketMember(segment: string, i: number): { source: string | undefined; next: number } {
  const named = namedClass(segment, i);
  if (named) return named;
  const range = segment[i + 1] === "-" && i + 2 < segment.length && segment[i + 2] !== "]";
  if (!range) return { source: escapeRegExp(segment[i]), next: i + 1 };
  const [low, high] = [segment[i], segment[i + 2]];
  // A reversed range matches nothing, as in glob(3); a RegExp would refuse it.
  return { source: low <= high ? `${escapeRegExp(low)}-${escapeRegExp(high)}` : "", next: i + 3 };
}

/**
 * Whether the section `header` (undefined: before any Host/Match) applies to `host`. OpenSSH
 * reads an Include inside an inactive block as matching nothing (readconf.c's
 * SSHCONF_NEVERMATCH), so such an include is skipped. A Host block uses the same pattern
 * matching as `compute`. Of Match blocks only `Match all` counts: the other criteria (exec,
 * user, canonical, final, the host after HostName) are not known here, and skipping an
 * include can only miss an option, where including it could apply one (a ProxyCommand) to a
 * host OpenSSH leaves alone.
 */
function sectionAppliesTo(header: string | undefined, host: string): boolean {
  if (header === undefined) return true;
  const hostLine = HOST_LINE_PATTERN.exec(header);
  if (hostLine) return glob(splitIncludeArgs(hostLine[1]), host);
  return MATCH_ALL_LINE_PATTERN.test(header);
}

/** The expanded content of each file one Include line names, in order. */
async function readIncludedFiles(
  value: string,
  homeDir: string,
  depth: number,
  host: string
): Promise<string[]> {
  const contents: string[] = [];
  for (const file of await resolveIncludePaths(value, homeDir, host)) {
    try {
      contents.push(await expandIncludes(await fs.readFile(file, "utf8"), homeDir, depth, host));
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
 * Inline `Include` directives for resolving `host`, which the ssh-config package does not
 * resolve (Xum's Daytona block relies on one). An Include inside a block that does not apply
 * to `host` is skipped, as OpenSSH does. One inside a block that applies is followed by that
 * block's header again, so later lines of the block stay scoped to it as in OpenSSH.
 */
async function expandIncludes(
  content: string,
  homeDir: string,
  depth: number,
  host: string
): Promise<string> {
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
    if (!sectionAppliesTo(sectionHeader, host)) continue;
    out.push(...(await readIncludedFiles(includeMatch[1], homeDir, depth + 1, host)));
    if (sectionHeader) {
      out.push(sectionHeader);
    }
  }
  return out.join("\n");
}

/** The user's ssh config with its Includes expanded for `host`. */
async function loadSSHConfig(host: string): Promise<SSHConfig | null> {
  const homeDir = getHomeDir();
  const configPath = path.join(homeDir, ".ssh", "config");

  try {
    const content = await fs.readFile(configPath, "utf8");
    const parsed = SSHConfig.parse(await expandIncludes(content, homeDir, 0, host));
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

  const config = await loadSSHConfig(hostAlias);
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
    ...readHostKeyPinning(computed, homeDir),
  };
}

function readHostKeyPinning(
  computed: Parameters<typeof getConfigValue>[0],
  homeDir: string
): Pick<ResolvedSSHConfig, "userKnownHostsFile" | "hostKeyAlias"> {
  const knownHostsValue = toStringValue(getConfigValue(computed, "UserKnownHostsFile"));
  const userKnownHostsFile = knownHostsValue
    ? splitIncludeArgs(knownHostsValue)
        .map((file) => expandHomePath(file, homeDir))
        .at(0)
    : undefined;
  const hostKeyAlias = toStringValue(getConfigValue(computed, "HostKeyAlias"));
  return {
    ...(userKnownHostsFile ? { userKnownHostsFile } : {}),
    ...(hostKeyAlias ? { hostKeyAlias } : {}),
  };
}
