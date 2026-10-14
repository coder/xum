import * as path from "node:path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { getXumHome } from "@/common/constants/paths";

const CHILD_ENV_KEYS_TO_STRIP = [
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_STREAM_PORT",
  // Strip both generations so a child cannot re-inherit either vendored-bin pointer.
  "XUM_VENDORED_BIN_DIR",
  "MUX_VENDORED_BIN_DIR",
  // Linux desktop identity (app_id source). Electron sets it in our process env
  // (from package.json desktopName, or main.ts for launch modes without a
  // package.json). Chromium/Electron apps launched from a mux terminal would
  // inherit it and group under mux's taskbar entry.
  "CHROME_DESKTOP",
] as const;

function normalizePathEntry(entry: string): string {
  const resolved = path.resolve(entry);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getXumVendoredBinDirs(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    resolveXumEnvironmentValue("VENDORED_BIN_DIR", env),
    path.join(getXumHome(), "bin"),
  ];
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizePathEntry(value.trim()));
}

export function sanitizeXumChildPath(
  pathValue: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (pathValue == null) {
    return pathValue;
  }

  const vendoredBinDirs = getXumVendoredBinDirs(env);
  if (vendoredBinDirs.length === 0) {
    return pathValue;
  }

  const sanitizedEntries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !vendoredBinDirs.includes(normalizePathEntry(entry)));

  return sanitizedEntries.join(path.delimiter);
}

export function sanitizeXumChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  const sanitizedPath = sanitizeXumChildPath(env.PATH ?? env.Path, env);

  for (const key of CHILD_ENV_KEYS_TO_STRIP) {
    delete sanitizedEnv[key];
  }

  if (sanitizedPath !== undefined) {
    sanitizedEnv.PATH = sanitizedPath;
    sanitizedEnv.Path = sanitizedPath;
  }

  return sanitizedEnv;
}

/**
 * #6509: host variables a child started with `hostEnv: "minimal"` (managed
 * plugin stdio MCP servers) still receives. Mirrors Codex, the reference host
 * for the `.mcp.json` dialect: codex-rs/rmcp-client/src/utils.rs
 * DEFAULT_ENV_VARS (Unix) and protocol/src/shell_environment.rs
 * WINDOWS_CORE_ENV_VARS. The Agent Plugins spec lets a client choose this base
 * ("may inherit, omit, or sanitize ambient environment variables").
 * Proxy variables are left out on purpose, as in Codex: their URLs can carry
 * credentials.
 */
const MINIMAL_POSIX_ENV_VARS = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

const MINIMAL_WINDOWS_ENV_VARS = [
  "PATH",
  "PATHEXT",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "POWERSHELL",
  "PWSH",
  // Not in the Codex list: Xum runs commands through Git Bash, which reads HOME.
  "HOME",
] as const;

/**
 * CA bundle paths, so servers behind a TLS-inspecting proxy still connect.
 * Codex's CUSTOM_CA_ENV_KEYS (codex-rs network-proxy certs.rs) minus its own
 * CODEX_CA_CERTIFICATE, plus SSL_CERT_DIR (OpenSSL's directory variant).
 */
const CA_BUNDLE_ENV_VARS = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "BUNDLE_SSL_CA_CERT",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
] as const;

/**
 * Pick the minimal host environment for a sandboxed child. Windows names match
 * case-insensitively (the env block is case-insensitive there) and keep their
 * casing. Values that start with "()" are exported bash functions and are
 * dropped, as in the MCP TypeScript SDK's getDefaultEnvironment.
 */
export function pickMinimalChildEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const isWindows = platform === "win32";
  const allowed = new Set<string>(
    [...(isWindows ? MINIMAL_WINDOWS_ENV_VARS : MINIMAL_POSIX_ENV_VARS), ...CA_BUNDLE_ENV_VARS].map(
      (name) => (isWindows ? name.toUpperCase() : name)
    )
  );
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.startsWith("()")) continue;
    if (allowed.has(isWindows ? name.toUpperCase() : name)) {
      picked[name] = value;
    }
  }
  return picked;
}

/** The host environment a child starts from, per ExecOptions.hostEnv (#6509). */
export function hostChildEnv(mode: "inherit" | "minimal" | undefined): NodeJS.ProcessEnv {
  return mode === "minimal" ? pickMinimalChildEnv(process.env) : process.env;
}
