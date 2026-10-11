/**
 * OpenAI MCP server auth (`extensions["com.openai"].auth` on an mcp.json
 * server entry) and the Codex `.mcp.json` dialect.
 *
 * Source: https://developers.openai.com/plugins/build/plugins.md ("Configure
 * MCP authentication"); dialect checked against github.com/openai/plugins
 * (figma, notion, slack, github, gmail `.mcp.json`).
 *
 * Xum only reads and checks these fields for now. Its MCP OAuth
 * (mcpOauthService) still uses OAuth discovery plus dynamic client
 * registration, so `oauth`/`mixed` with no client or a `dcr` client work as
 * before. Every setting it cannot use yet is listed in `ignored`, which the
 * caller reports as one consent-preview warning; the server keeps loading.
 *
 * SECURITY AUDIT: a client secret (Codex `oauth.client_secret`, or the
 * `clientSecret` the OpenAI schema forbids) is never copied, logged or quoted.
 * Messages carry field NAMES only, never values, because any value here can
 * be a credential (including URLs with embedded user information).
 */
import { isPlainObject } from "./manifest";
import { OPENAI_EXTENSION_NAMESPACE } from "./openaiExtension";

export type OpenAIMcpAuthType = "none" | "oauth" | "mixed" | "api_key";
export type OpenAIMcpClientMode = "provided" | "dcr" | "cimd";

const URL_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "registrationUrl",
  "authorizationServerBase",
  "resource",
  "oidcConfigurationUrl",
  "oidcUserinfoEndpoint",
] as const;
const SCOPE_FIELDS = ["baseScopes", "defaultScopes", "oidcScopesSupported"] as const;
type UrlField = (typeof URL_FIELDS)[number];
type ScopeField = (typeof SCOPE_FIELDS)[number];

export type OpenAIMcpAuth = {
  type: OpenAIMcpAuthType;
  client?: { mode: OpenAIMcpClientMode; clientId?: string; tokenEndpointAuthMethod?: string };
  oidcEnabled?: boolean;
  headerScheme?: "bearer" | "basic" | "custom_header";
  headerName?: string;
} & Partial<Record<UrlField, string>> &
  Partial<Record<ScopeField, string[]>>;

export interface ReadOpenAIMcpAuthResult {
  auth?: OpenAIMcpAuth;
  /** Malformed fields that were dropped. */
  warnings: string[];
  /** Valid (or secret) fields Xum's OAuth flow cannot use yet. */
  ignored: string[];
}

const AUTH_TYPES = new Set<string>(["none", "oauth", "mixed", "api_key"]);
const CLIENT_MODES = new Set<string>(["provided", "dcr", "cimd"]);
const TOKEN_AUTH_METHODS = new Set<string>([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);
const HEADER_SCHEMES = new Set<string>(["bearer", "basic", "custom_header"]);
const SECRET_KEYS = new Set<string>(["clientSecret", "client_secret"]);
const KNOWN_AUTH_KEYS = new Set<string>([
  "type",
  "client",
  "oidcEnabled",
  "headerScheme",
  "headerName",
  ...URL_FIELDS,
  ...SCOPE_FIELDS,
]);
const AUTH = `extensions["${OPENAI_EXTENSION_NAMESPACE}"].auth`;

/** Loopback hosts, the only ones an http: endpoint override may name (RFC 8252 §8.3 dev use). */
const LOOPBACK_HOSTS = new Set<string>(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Absolute https URL without user information or a fragment. OpenAI's reference allows http
 * too, but a token endpoint on plain http across the network would expose the authorization
 * code and the client secret, so http is kept only for a loopback development server.
 */
function isSafeEndpointUrl(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  const secureScheme =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secureScheme && url.username === "" && url.password === "" && !url.hash;
}

function isScopeList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((scope) => typeof scope === "string" && scope.trim().length > 0)
  );
}

function readClient(
  raw: unknown,
  result: ReadOpenAIMcpAuthResult
): OpenAIMcpAuth["client"] | undefined {
  if (!isPlainObject(raw) || typeof raw.mode !== "string" || !CLIENT_MODES.has(raw.mode)) {
    result.warnings.push(
      `'${AUTH}.client.mode' must be provided, dcr or cimd; ignoring the client`
    );
    return undefined;
  }
  const client: NonNullable<OpenAIMcpAuth["client"]> = { mode: raw.mode as OpenAIMcpClientMode };
  for (const key of Object.keys(raw)) {
    if (SECRET_KEYS.has(key)) result.ignored.push(`client.${key}`);
    else if (key !== "mode" && key !== "clientId" && key !== "tokenEndpointAuthMethod")
      result.warnings.push(`Unknown '${AUTH}.client.${key}' ignored`);
  }
  if (raw.clientId !== undefined) {
    if (client.mode === "provided" && typeof raw.clientId === "string" && raw.clientId.length > 0)
      client.clientId = raw.clientId;
    else
      result.warnings.push(
        `'${AUTH}.client.clientId' must be a non-empty string on a provided client; ignoring`
      );
  }
  if (client.mode === "provided" && client.clientId === undefined) {
    result.warnings.push(
      `'${AUTH}.client.clientId' is required for a provided client; ignoring the client`
    );
    return undefined;
  }
  if (raw.tokenEndpointAuthMethod !== undefined) {
    if (
      typeof raw.tokenEndpointAuthMethod === "string" &&
      TOKEN_AUTH_METHODS.has(raw.tokenEndpointAuthMethod)
    )
      client.tokenEndpointAuthMethod = raw.tokenEndpointAuthMethod;
    else
      result.warnings.push(`'${AUTH}.client.tokenEndpointAuthMethod' is not supported; ignoring`);
  }
  return client;
}

/** The parsed auth block; fields the flow cannot use yet go to `result.ignored`. */
function readAuth(raw: Record<string, unknown>, result: ReadOpenAIMcpAuthResult): void {
  if (typeof raw.type !== "string" || !AUTH_TYPES.has(raw.type)) {
    result.warnings.push(`'${AUTH}.type' must be none, oauth, mixed or api_key; ignoring auth`);
    return;
  }
  const auth: OpenAIMcpAuth = { type: raw.type as OpenAIMcpAuthType };
  for (const key of Object.keys(raw)) {
    if (SECRET_KEYS.has(key)) result.ignored.push(key);
    else if (!KNOWN_AUTH_KEYS.has(key)) result.warnings.push(`Unknown '${AUTH}.${key}' ignored`);
  }
  if (raw.client !== undefined) {
    const client = readClient(raw.client, result);
    if (client !== undefined) auth.client = client;
  }
  for (const key of URL_FIELDS) {
    if (raw[key] === undefined) continue;
    if (isSafeEndpointUrl(raw[key])) auth[key] = raw[key];
    else
      result.warnings.push(
        `'${AUTH}.${key}' must be an https (or loopback http) URL without credentials or a fragment; ignoring`
      );
  }
  for (const key of SCOPE_FIELDS) {
    if (raw[key] === undefined) continue;
    if (isScopeList(raw[key])) auth[key] = raw[key];
    else result.warnings.push(`'${AUTH}.${key}' must be an array of non-blank scopes; ignoring`);
  }
  if (raw.oidcEnabled !== undefined) {
    if (typeof raw.oidcEnabled === "boolean") auth.oidcEnabled = raw.oidcEnabled;
    else result.warnings.push(`'${AUTH}.oidcEnabled' must be a boolean; ignoring`);
  }
  if (raw.headerScheme !== undefined) {
    if (typeof raw.headerScheme === "string" && HEADER_SCHEMES.has(raw.headerScheme))
      auth.headerScheme = raw.headerScheme as NonNullable<OpenAIMcpAuth["headerScheme"]>;
    else result.warnings.push(`'${AUTH}.headerScheme' must be bearer, basic or custom_header`);
  }
  if (raw.headerName !== undefined) {
    const valid =
      auth.headerScheme === "custom_header" &&
      typeof raw.headerName === "string" &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(raw.headerName) &&
      raw.headerName.toLowerCase() !== "host";
    if (valid) auth.headerName = raw.headerName as string;
    else result.warnings.push(`'${AUTH}.headerName' needs headerScheme custom_header; ignoring`);
  }

  // Only discovery + DCR is wired today (mcpOauthService); list everything else.
  if (auth.type === "api_key") result.ignored.push("type: api_key (no plugin API key storage)");
  if (auth.client !== undefined && auth.client.mode !== "dcr")
    result.ignored.push(`client.mode: ${auth.client.mode}`);
  for (const key of ["clientId", "tokenEndpointAuthMethod"] as const) {
    if (auth.client?.[key] !== undefined) result.ignored.push(`client.${key}`);
  }
  for (const key of [...URL_FIELDS, ...SCOPE_FIELDS, "oidcEnabled", "headerScheme", "headerName"]) {
    if (key in auth) result.ignored.push(key);
  }
  result.auth = auth;
}

/** Read `extensions["com.openai"].auth` from a remote server entry's `extensions` value. */
export function readOpenAIMcpAuth(extensions: unknown): ReadOpenAIMcpAuthResult {
  const result: ReadOpenAIMcpAuthResult = { warnings: [], ignored: [] };
  if (extensions === undefined) return result;
  if (!isPlainObject(extensions)) {
    result.warnings.push("'extensions' must be an object; ignoring");
    return result;
  }
  const namespace = extensions[OPENAI_EXTENSION_NAMESPACE];
  if (namespace === undefined) return result;
  if (
    !isPlainObject(namespace) ||
    (namespace.auth !== undefined && !isPlainObject(namespace.auth))
  ) {
    result.warnings.push(`'${AUTH}' must be an object; ignoring`);
    return result;
  }
  if (namespace.auth !== undefined) readAuth(namespace.auth, result);
  return result;
}

/** Codex's plugin parser (codex-mcp plugin_config.rs) accepts all three spellings. */
const CODEX_STREAMABLE_HTTP_TYPES = new Set<unknown>([
  "http",
  "streamable_http",
  "streamable-http",
]);

/**
 * Codex resolves a relative stdio cwd (`.`, `sub/dir`) against the plugin root; the portable
 * format spells that `./…`. Only the spelling changes: normalizeStdioEntry still applies its
 * containment check, so `../x` (now `./../x`) is still refused as an escape.
 */
function portableCodexCwd(cwd: unknown): unknown {
  if (typeof cwd !== "string" || cwd.length === 0) return cwd;
  if (cwd.startsWith("./") || cwd.startsWith("/") || cwd.startsWith("~") || cwd.startsWith("$"))
    return cwd;
  return cwd === "." ? "./" : `./${cwd}`;
}

/**
 * Rewrite one Codex `.mcp.json` server entry into the Agent Plugins shape:
 * `type: "http"` (or `streamable_http`) becomes `streamable-http`, a relative cwd gets
 * its `./` prefix, and `oauth.client_id`, `scopes`
 * and `oauth_resource` become an OpenAI `auth` block (an existing inline
 * `auth` wins). Callback settings and the client secret are only NAMED in
 * `ignored`; the secret value is dropped here and never copied.
 */
export function translateCodexMcpEntry(entry: Record<string, unknown>): {
  entry: Record<string, unknown>;
  ignored: string[];
  warnings: string[];
} {
  const { oauth, scopes, oauth_resource: resource, ...rest } = entry;
  const ignored: string[] = [];
  const warnings: string[] = [];
  if (CODEX_STREAMABLE_HTTP_TYPES.has(rest.type)) rest.type = "streamable-http";
  if (rest.cwd !== undefined) rest.cwd = portableCodexCwd(rest.cwd);
  // Codex stdio entries carry a `command` and no `type`.
  if (rest.type === undefined && typeof rest.command === "string") rest.type = "stdio";

  const auth: Record<string, unknown> = {};
  if (oauth !== undefined) {
    if (!isPlainObject(oauth)) warnings.push("'oauth' must be an object; ignoring");
    else
      for (const key of Object.keys(oauth)) {
        if (key === "client_id") auth.client = { mode: "provided", clientId: oauth.client_id };
        else ignored.push(`oauth.${key}`);
      }
  }
  if (scopes !== undefined) auth.defaultScopes = scopes;
  if (resource !== undefined) auth.resource = resource;
  if (Object.keys(auth).length === 0) return { entry: rest, ignored, warnings };

  const extensions = isPlainObject(rest.extensions) ? rest.extensions : {};
  const namespace = isPlainObject(extensions[OPENAI_EXTENSION_NAMESPACE])
    ? extensions[OPENAI_EXTENSION_NAMESPACE]
    : {};
  if (namespace.auth !== undefined) {
    warnings.push(`Codex 'oauth'/'scopes'/'oauth_resource' conflict with '${AUTH}'; using auth`);
    return { entry: rest, ignored, warnings };
  }
  rest.extensions = {
    ...extensions,
    [OPENAI_EXTENSION_NAMESPACE]: { ...namespace, auth: { type: "oauth", ...auth } },
  };
  return { entry: rest, ignored, warnings };
}
