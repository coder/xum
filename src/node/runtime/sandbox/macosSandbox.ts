import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import {
  AgentSandboxStartError,
  agentSandboxSettingsFor,
  buildAgentSandboxPolicy,
  type AgentSandboxPolicy,
} from "./agentSandboxTargets";

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Whether this backend can sandbox agent commands: macOS with Seatbelt's sandbox-exec. */
export function isAgentSandboxSupported(): boolean {
  // eslint-disable-next-line local/no-sync-fs-methods -- a cheap check on a sync path (exec, settings).
  return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC_PATH);
}

/**
 * srt's base profile allows these, and srt has no option to drop them. They reach the keychain
 * (SecurityServer, securityd) and other apps' preferences, so they are cut from every profile.
 */
export const SRT_RULES_TO_REMOVE: readonly string[] = [
  "(allow user-preference-read)",
  '  (global-name "com.apple.securityd.xpc")',
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
];

// Go verifies TLS certificates through trustd (measured on macOS 27.2).
const ALLOW_MACH_LOOKUP = ["com.apple.trustd.agent"];

/**
 * Refused for allow-listed names on top of srt's own loopback, link-local and metadata set, the
 * same ranges web_fetch's DNS pin refuses: an allowed name must not lead into the local network.
 */
const DENIED_RESOLVED_ADDRESSES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

/**
 * One srt session serves every workspace. Its own allow list stays empty: each command presents
 * the hosts of its project under its unguessable commandId (registerCommandNetworkLists).
 */
const BASE_SRT_CONFIG: SandboxRuntimeConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
    deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES,
    allowLocalBinding: true,
    allowMachLookup: ALLOW_MACH_LOOKUP,
  },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};

let srtSession: Promise<void> | undefined;

/**
 * Starts srt's HTTP and SOCKS proxy on 127.0.0.1 and its violation log monitor, once. A failed
 * start is retried by the next caller; until one succeeds, sandboxed commands fail closed.
 */
export function ensureAgentSandboxRuntime(): Promise<void> {
  srtSession ??= SandboxManager.initialize(BASE_SRT_CONFIG, undefined, true).catch(
    (error: unknown) => {
      srtSession = undefined;
      throw error;
    }
  );
  return srtSession;
}

/** Stops the srt proxies and log monitor (shutdown and tests). */
export async function resetAgentSandboxRuntime(): Promise<void> {
  if (srtSession === undefined) return;
  srtSession = undefined;
  await SandboxManager.reset();
}

/** The srt config that turns `policy` into one command's Seatbelt profile. */
function srtConfigForPolicy(policy: AgentSandboxPolicy): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      denyRead: policy.denyRead,
      allowRead: policy.allowRead,
      allowWrite: [...policy.writeRoots, ...(policy.gitCommonDir ? [policy.gitCommonDir] : [])],
      denyWrite: policy.denyWrite,
    },
    network: {
      // Present (and empty) so srt restricts the network and routes it through its proxy; the
      // hosts this command may reach are registered under its commandId.
      allowedDomains: [],
      deniedDomains: [],
    },
  };
}

/** What exec() spawns instead of bash for a sandboxed command. */
export interface AgentSandboxWrap {
  command: string;
  args: string[];
  /** Only the keys srt adds (proxy variables and the like), to overlay onto Xum's own env. */
  env: Record<string, string>;
  commandId: string;
  /** Unregisters the command's network allow list: call when the child exits or never started. */
  dispose: () => void;
}

export interface WrapForAgentSandboxOptions {
  bashPath: string;
  abortSignal?: AbortSignal;
  /** Set only for MCP servers and a bash call the user approved to run outside the sandbox. */
  optOut?: boolean;
  /** Workspace folders opened like cwd (ExecOptions.sandboxRoots). */
  workspaceRoots?: readonly string[];
  /** The command's $XUM_SCRATCH_DIR, writable like the workspace. */
  scratchDir?: string;
  /** The command's PATH: folders on it under ~ open for reads. */
  pathEnv?: string;
}

/**
 * The sandboxed spawn of `script` for a command of `projectPath` in `cwd`, or null when the
 * sandbox is off, this is not macOS, or the caller opts out. Fails closed: when the sandbox
 * applies but cannot be set up, it throws AgentSandboxStartError and the caller runs nothing.
 */
export async function wrapForAgentSandbox(
  projectPath: string | undefined,
  cwd: string,
  script: string,
  options: WrapForAgentSandboxOptions
): Promise<AgentSandboxWrap | null> {
  if (options.optOut === true || process.platform !== "darwin") return null;
  const settings = agentSandboxSettingsFor(projectPath);
  if (settings === null) return null;
  if (!isAgentSandboxSupported()) {
    throw new AgentSandboxStartError(`${SANDBOX_EXEC_PATH} is missing`);
  }
  const policy = buildAgentSandboxPolicy(settings, {
    cwd,
    workspaceRoots: options.workspaceRoots,
    scratchDir: options.scratchDir,
    pathEnv: options.pathEnv,
  });
  return wrapWithPolicy(policy, script, options);
}

/** wrapForAgentSandbox() for an explicit policy (also used by the darwin tests). */
export async function wrapWithPolicy(
  policy: AgentSandboxPolicy,
  script: string,
  options: Pick<WrapForAgentSandboxOptions, "bashPath" | "abortSignal">
): Promise<AgentSandboxWrap> {
  try {
    await ensureAgentSandboxRuntime();
  } catch (error) {
    throw new AgentSandboxStartError(`srt failed to initialize: ${getErrorMessage(error)}`);
  }
  // srt requires an unguessable id: the proxy username is the only thing binding a connection to
  // a command's allow list.
  const commandId = randomBytes(16).toString("base64url");
  let wrapped: { argv: string[] };
  try {
    wrapped = await SandboxManager.wrapWithSandboxArgv(
      script,
      options.bashPath,
      srtConfigForPolicy(policy),
      options.abortSignal,
      undefined,
      { commandId }
    );
  } catch (error) {
    if (options.abortSignal?.aborted) throw error;
    throw new AgentSandboxStartError(getErrorMessage(error));
  }
  const spawnPlan = parseSrtMacosArgv(wrapped.argv, script);
  const profile = postProcessProfile(spawnPlan.profile, policy.network);
  const env = srtEnvOverlay(spawnPlan.assignments, policy.network);
  if (policy.network === "allowlist") {
    registerAllowedHosts(commandId, policy.allowedHosts);
  }
  return {
    command: SANDBOX_EXEC_PATH,
    args: ["-p", profile, spawnPlan.shell, "-c", script],
    env,
    commandId,
    dispose: () => SandboxManager.unregisterCommandNetworkLists(commandId),
  };
}

/**
 * Registers the hosts one at a time when the whole list is refused, so one invalid hand-edited
 * entry does not cut a project off from its other hosts.
 */
function registerAllowedHosts(commandId: string, hosts: string[]): void {
  try {
    SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: hosts });
    return;
  } catch (error) {
    log.warn(`agent sandbox: allowed hosts list refused: ${getErrorMessage(error)}`);
  }
  const valid = hosts.filter((host) => {
    try {
      SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: [host] });
      return true;
    } catch {
      return false;
    }
  });
  SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: valid });
}

interface SrtMacosSpawnPlan {
  /** `NAME=value` arguments srt passes through `env`. */
  assignments: Array<[string, string]>;
  profile: string;
  shell: string;
}

// The exact quoting of srt's utils/shell-quote.js: bare words, or single quotes with each `'`
// written as '"'"'. A wrapped string that does not re-quote to itself is not one srt made.
const BARE_WORD = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;

function srtQuote(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg === "") return "''";
      if (BARE_WORD.test(arg)) return arg;
      return "'" + arg.replace(/'/g, `'"'"'`) + "'";
    })
    .join(" ");
}

function srtUnquote(quoted: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < quoted.length) {
    const read = readSrtWord(quoted, index);
    if (read.word !== undefined) args.push(read.word);
    index = read.next + 1;
  }
  if (srtQuote(args) !== quoted) throw new Error("not in srt's quoting");
  return args;
}

/** The word that starts at `start` (undefined for an empty run of spaces) and where it ends. */
function readSrtWord(quoted: string, start: number): { word: string | undefined; next: number } {
  let word = "";
  let sawQuote = false;
  let index = start;
  while (index < quoted.length && quoted[index] !== " ") {
    const char = quoted[index];
    if (char === "'" || char === '"') {
      const end = quoted.indexOf(char, index + 1);
      if (end === -1) throw new Error("unterminated quote");
      word += quoted.slice(index + 1, end);
      index = end + 1;
      sawQuote = true;
    } else {
      word += char;
      index += 1;
    }
  }
  return { word: word.length > 0 || sawQuote ? word : undefined, next: index };
}

function failSrtWrap(why: string): never {
  throw new AgentSandboxStartError(`unexpected srt wrap (${why})`);
}

/**
 * srt 0.0.81 on macOS returns `[shell, "-c", "env [-u NAME]... [NAME=value]...
 * /usr/bin/sandbox-exec -p <profile> <shell> -c <command>"]`. Xum spawns sandbox-exec itself, so
 * it can edit the profile and keep its own child env; any other shape fails closed.
 */
function parseSrtMacosArgv(argv: readonly string[], script: string): SrtMacosSpawnPlan {
  if (argv.length !== 3 || argv[1] !== "-c") failSrtWrap("argv shape");
  const words = unquoteSrtWrap(argv[2]);
  if (words[0] !== "env") failSrtWrap("no env prefix");
  const { assignments, rest } = splitEnvAssignments(words.slice(1));
  if (rest.length !== 6 || rest[1] !== "-p" || rest[4] !== "-c") {
    failSrtWrap("sandbox-exec arguments");
  }
  if (rest[5] !== script) failSrtWrap("wrapped command");
  return { assignments, profile: rest[2], shell: rest[3] };
}

function unquoteSrtWrap(quoted: string): string[] {
  try {
    return srtUnquote(quoted);
  } catch (error) {
    return failSrtWrap(getErrorMessage(error));
  }
}

/** The `NAME=value` words before sandbox-exec, and the words from sandbox-exec on. */
function splitEnvAssignments(words: string[]): {
  assignments: Array<[string, string]>;
  rest: string[];
} {
  const execIndex = words.indexOf(SANDBOX_EXEC_PATH);
  const envWords = execIndex === -1 ? words : words.slice(0, execIndex);
  const assignments = envWords.map((word): [string, string] => {
    // srt writes `-u NAME` only for credential env denies, which Xum does not configure.
    if (word === "-u") failSrtWrap("env -u");
    const eq = word.indexOf("=");
    if (eq <= 0) failSrtWrap("env argument");
    return [word.slice(0, eq), word.slice(eq + 1)];
  });
  return { assignments, rest: execIndex === -1 ? [] : words.slice(execIndex) };
}

/**
 * Removes the keychain and preference rules (SRT_RULES_TO_REMOVE), and in the "open" network
 * mode replaces the network block with an allow: srt restricts the network of every command
 * once its base config has an allow list, and has no per-command opt-out. Throws when the
 * profile does not have the expected text, so an srt upgrade that changes it fails closed.
 */
function postProcessProfile(profile: string, network: AgentSandboxPolicy["network"]): string {
  const lines = profile.split("\n");
  for (const rule of SRT_RULES_TO_REMOVE) {
    const at = lines.indexOf(rule);
    if (at === -1) {
      throw new AgentSandboxStartError(`the srt profile has no rule ${rule.trim()} to remove`);
    }
    lines.splice(at, 1);
  }
  let edited = lines;
  if (network === "open") {
    const start = edited.indexOf("; Network");
    const end = start === -1 ? -1 : edited.indexOf("", start);
    if (start === -1 || end === -1) {
      throw new AgentSandboxStartError("the srt profile has no network block");
    }
    edited = [...edited.slice(0, start + 1), "(allow network*)", ...edited.slice(end)];
  }
  const result = edited.join("\n");
  const leftover = SRT_RULES_TO_REMOVE.find((rule) => result.includes(rule.trim()));
  if (leftover !== undefined) {
    throw new AgentSandboxStartError(`the srt profile still has ${leftover.trim()}`);
  }
  return result;
}

// srt points TMPDIR at its own folder; Xum keeps the user's TMPDIR, which is a write root.
const SRT_ENV_KEYS_NOT_COPIED = new Set(["TMPDIR"]);
// The proxy plumbing; without a restricted network ("open") nothing should go through it.
const SRT_KEYS_KEPT_WITH_OPEN_NETWORK = new Set(["SANDBOX_RUNTIME"]);

function srtEnvOverlay(
  assignments: ReadonlyArray<[string, string]>,
  network: AgentSandboxPolicy["network"]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of assignments) {
    if (SRT_ENV_KEYS_NOT_COPIED.has(key)) continue;
    if (network === "open" && !SRT_KEYS_KEPT_WITH_OPEN_NETWORK.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Short denial lines for one command, for example "write /Users/me/.zshrc". */
function agentSandboxDenialsFor(commandId: string): string[] {
  let violations: Array<{ line: string }>;
  try {
    violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
  } catch {
    return [];
  }
  const summaries = violations.flatMap((violation) => {
    const summary = summarizeViolation(violation.line);
    return summary === null ? [] : [summary];
  });
  return [...new Set(summaries)];
}

/**
 * macOS writes denials to the system log, and srt's log stream reads them about a second after
 * the command exits (measured ~1.5 s on macOS 27.2). There is no signal for "all denials of a
 * command arrived", so a failed command waits up to this long for its first one.
 */
const DENIAL_WAIT_MS = 2_000;
// Once one arrives, the rest of the same burst follow within this window.
const DENIAL_SETTLE_MS = 300;

/**
 * The denials of a command that just exited. Only a failed command waits for the log (bounded):
 * a command that succeeded gets the denials already read, so it never pays the wait.
 */
export function agentSandboxDenialsAfterExit(
  commandId: string,
  failed: boolean
): Promise<string[]> {
  const now = agentSandboxDenialsFor(commandId);
  if (!failed || now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(deadline);
      clearTimeout(settle);
      unsubscribe?.();
      resolve(agentSandboxDenialsFor(commandId));
    };
    const deadline = setTimeout(finish, DENIAL_WAIT_MS);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = SandboxManager.getSandboxViolationStore().subscribe(() => {
        if (settle === undefined && agentSandboxDenialsFor(commandId).length > 0) {
          settle = setTimeout(finish, DENIAL_SETTLE_MS);
        }
      });
    } catch {
      finish();
    }
  });
}

// The keychain services: the only Mach lookups worth reporting.
const REPORTED_MACH_SERVICES = new Set(["com.apple.SecurityServer", "com.apple.securityd.xpc"]);

/**
 * "bash(12) deny(1) file-write-create /x" -> "write /x"; "deny network-outbound h:443 (r)" ->
 * "network h". Null for the denials every command logs without failing (sysctl and disk-space
 * queries, global preference reads, configd lookups), which would bury the one that matters.
 */
function summarizeViolation(line: string): string | null {
  const network = /deny(?:\(\d+\))? network-outbound (\S+?)(?::\d+)?(?:\s|$)/.exec(line);
  if (network) return `network ${network[1]}`;
  const file = /deny(?:\(\d+\))? file-(read|write)[\w-]* (.+)$/.exec(line);
  if (file) {
    const target = file[2].trim();
    if (file[1] === "read" && target.includes("/Library/Preferences/")) return null;
    return `${file[1]} ${target}`;
  }
  const mach = /deny(?:\(\d+\))? mach-lookup (\S+)/.exec(line);
  if (mach) return REPORTED_MACH_SERVICES.has(mach[1]) ? `service ${mach[1]}` : null;
  return null;
}
