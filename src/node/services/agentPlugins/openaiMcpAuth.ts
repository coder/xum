/**
 * OpenAI MCP server auth (`extensions["com.openai"].auth` on an mcp.json
 * server entry) and the Codex `.mcp.json` dialect.
 *
 * Source: https://developers.openai.com/plugins/build/plugins.md ("Configure
 * MCP authentication"); dialect checked against github.com/openai/plugins
 * (figma, notion, slack, github, gmail `.mcp.json`).
 *
 * `toServerOAuthConfig` hands mcpOauthService what it can use: a provided
 * client, its token auth method, both endpoint overrides together, scopes and
 * the resource. Discovery + DCR fill in the rest. Every setting it cannot use
 * is listed in `ignored`, which the caller reports as one consent-preview
 * warning; the server keeps loading.
 *
 * SECURITY AUDIT: a client secret is never copied into parsed results, logged
 * or quoted. Messages carry field NAMES only, never values, because any value
 * here can be a credential (including URLs with embedded user information).
 * Only the Codex `oauth.client_secret` is used: readPluginClientSecret
 * re-reads it from the consented file at flow time (memory only). The
 * `clientSecret` the OpenAI schema forbids is never used.
 */
import { checkResourceAllowed } from "@modelcontextprotocol/client";
import type { MCPServerOAuthConfig } from "@/common/types/mcp";
import { MAX_PLUGIN_MANIFEST_BYTES, readPluginFileWithinRootCapped } from "./discovery";
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

/** Valid fields the OAuth flow has no use for (discovery covers them). */
const UNUSED_FIELDS = [
  "oidcConfigurationUrl",
  "oidcUserinfoEndpoint",
  "oidcScopesSupported",
  "oidcEnabled",
] as const;
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

  // Keep in sync with toServerOAuthConfig: name everything it drops.
  const ignore = (field: string): number => result.ignored.push(field);
  if (auth.type === "api_key") ignore("type: api_key (no plugin API key storage)");
  const client = auth.client;
  if (client?.mode === "cimd" || (client?.mode === "provided" && client.clientId === undefined))
    ignore(`client.mode: ${client.mode}`);
  for (const key of [...UNUSED_FIELDS, "headerScheme", "headerName"]) {
    if (key in auth) ignore(key);
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
 * `auth` wins). Callback settings are only NAMED in `ignored`. The secret
 * value is dropped here; `hasClientSecret` tells the caller to point the
 * OAuth service at the file (see readPluginClientSecret).
 */
export function translateCodexMcpEntry(entry: Record<string, unknown>): {
  entry: Record<string, unknown>;
  ignored: string[];
  warnings: string[];
  hasClientSecret?: boolean;
} {
  const { oauth, scopes, oauth_resource: resource, ...rest } = entry;
  const ignored: string[] = [];
  const warnings: string[] = [];
  let hasClientSecret = false;
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
        else if (key === "client_secret" && typeof oauth.client_secret === "string")
          hasClientSecret = true;
        // A fixed loopback callback is not honored: Xum binds a random port.
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
  return { entry: rest, ignored, warnings, hasClientSecret };
}

type TokenAuthMethod = NonNullable<MCPServerOAuthConfig["tokenEndpointAuthMethod"]>;
const SECRET_AUTH_METHODS = new Set<string>(["none", "client_secret_basic", "client_secret_post"]);

/**
 * The settings mcpOauthService uses (`config` undefined when nothing applies:
 * discovery + DCR). `ignored` names settings dropped here; the caller adds
 * them to the server's one consent-preview warning.
 */
export function toServerOAuthConfig(
  auth: OpenAIMcpAuth | undefined,
  ctx: { serverUrl: string; clientSecretSource?: MCPServerOAuthConfig["clientSecretSource"] }
): { config?: MCPServerOAuthConfig; ignored: string[] } {
  const ignored: string[] = [];
  if (auth?.type !== "oauth" && auth?.type !== "mixed") return { ignored };
  let clientId = auth.client?.mode === "provided" ? auth.client.clientId : undefined;
  const method = auth.client?.tokenEndpointAuthMethod;
  // Xum cannot sign a private_key_jwt assertion; the provider would reject every token
  // request, so drop the provided client and let discovery + DCR recover.
  if (clientId !== undefined && method === "private_key_jwt") {
    ignored.push("client (private_key_jwt is not supported)");
    clientId = undefined;
  }
  // A secret method needs a secret, and only the Codex dialect can supply one.
  // Without it the provider rejects every token request, so use discovery + DCR.
  if (
    clientId !== undefined &&
    (method === "client_secret_basic" || method === "client_secret_post") &&
    ctx.clientSecretSource === undefined
  ) {
    ignored.push(`client (${method} needs a client secret)`);
    clientId = undefined;
  }
  // SECURITY AUDIT: authorization and token endpoint overrides are not applied; discovery
  // supplies them. Pinning them to one origin was not enough (tenants share origins), and
  // nothing bound them to verified issuer metadata. Follow-up #6142 binds them.
  if (auth.authorizationUrl !== undefined || auth.tokenUrl !== undefined) {
    ignored.push(
      [
        auth.authorizationUrl !== undefined ? "authorizationUrl" : undefined,
        auth.tokenUrl !== undefined ? "tokenUrl" : undefined,
      ]
        .filter((key) => key !== undefined)
        .join(", ") + " (discovery supplies the endpoints)"
    );
  }
  // authorizationServerBase moves discovery; registrationUrl is checked against the
  // discovered, issuer-verified metadata at sign-in (mcpOauthService pluginFlowDiscoveryState).
  const registrationUrl = clientId === undefined ? auth.registrationUrl : undefined;
  const base = auth.authorizationServerBase;
  const discovery: MCPServerOAuthConfig["discovery"] =
    base !== undefined || registrationUrl !== undefined
      ? {
          ...(base !== undefined ? { authorizationServerBase: base } : {}),
          ...(registrationUrl !== undefined ? { registrationUrl } : {}),
        }
      : undefined;
  // SECURITY AUDIT: a token for another resource would be sent to this
  // server. Apply the MCP SDK's own rule: the resource must cover the server
  // URL (same origin, path prefix).
  let resource = auth.resource;
  if (
    resource !== undefined &&
    !checkResourceAllowed({ requestedResource: ctx.serverUrl, configuredResource: resource })
  ) {
    ignored.push("resource (does not cover the server URL)");
    resource = undefined;
  }
  const config: MCPServerOAuthConfig = {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientId !== undefined && method !== undefined && SECRET_AUTH_METHODS.has(method)
      ? { tokenEndpointAuthMethod: method as TokenAuthMethod }
      : {}),
    ...(discovery !== undefined ? { discovery } : {}),
    ...(auth.baseScopes !== undefined ? { baseScopes: auth.baseScopes } : {}),
    ...(auth.defaultScopes !== undefined ? { defaultScopes: auth.defaultScopes } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(clientId !== undefined && ctx.clientSecretSource !== undefined
      ? { clientSecretSource: ctx.clientSecretSource }
      : {}),
  };
  return Object.keys(config).length > 0 ? { config, ignored } : { ignored };
}

/**
/**
 * Fixed message for a plugin MCP config file that is not valid JSON. SECURITY AUDIT: a
 * `JSON.parse` error quotes source text, which can include a nearby `client_secret`, so
 * callers report this category and never the parser message (#6297).
 */
export const PLUGIN_MCP_CONFIG_PARSE_ERROR = "the plugin's MCP config file could not be parsed";

/** A Codex `.mcp.json` client secret and the `oauth.client_id` it sits next to. */
export interface PluginClientSecret {
  clientId: string | undefined;
  secret: string;
}

/**
 * Every client secret in a consented Codex `.mcp.json` (bounded,
 * containment-checked read), keyed by server name, each with the client ID
 * beside it. One read and parse serves all of the file's servers. The caller
 * keeps the values in memory only.
 */
export async function readPluginClientSecrets(
  source: Pick<
    NonNullable<MCPServerOAuthConfig["clientSecretSource"]>,
    "pluginRoot" | "mcpConfigPath"
  >
): Promise<Map<string, PluginClientSecret>> {
  const { content } = await readPluginFileWithinRootCapped({
    filePath: source.mcpConfigPath,
    pluginRoot: source.pluginRoot,
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    label: ".mcp.json",
  });
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(PLUGIN_MCP_CONFIG_PARSE_ERROR);
  }
  // Wrapped (`mcpServers`) or the flat Codex map, like loadPluginMcpServers.
  const servers = !isPlainObject(raw)
    ? {}
    : "mcpServers" in raw
      ? isPlainObject(raw.mcpServers)
        ? raw.mcpServers
        : {}
      : raw;
  const secrets = new Map<string, PluginClientSecret>();
  for (const [name, entry] of Object.entries(servers)) {
    const oauth = isPlainObject(entry) ? entry.oauth : undefined;
    if (!isPlainObject(oauth)) continue;
    const secret = oauth.client_secret;
    if (typeof secret !== "string" || secret.length === 0) continue;
    const clientId = typeof oauth.client_id === "string" ? oauth.client_id : undefined;
    secrets.set(name, { clientId, secret });
  }
  return secrets;
}

/**
 * One server's client secret (see readPluginClientSecrets), returned only
 * while the file's `oauth.client_id` is still `clientId`: an edit or update
 * can replace the client between the config capture and this read, and a
 * stale flow must not send the replacement secret to the old client's token
 * endpoint (#6297).
 */
export function pluginClientSecretFor(
  secrets: Map<string, PluginClientSecret>,
  serverName: string,
  clientId: string
): string | undefined {
  const entry = secrets.get(serverName);
  return entry?.clientId === clientId ? entry.secret : undefined;
}

/** One server's client secret for the client `clientId` (see pluginClientSecretFor). */
export async function readPluginClientSecret(
  source: NonNullable<MCPServerOAuthConfig["clientSecretSource"]>,
  clientId: string
): Promise<string | undefined> {
  return pluginClientSecretFor(await readPluginClientSecrets(source), source.serverName, clientId);
}
