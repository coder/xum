import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import { MCPServerIdentitySchema, MCPToolCallDisplaySchema } from "@/common/orpc/schemas/mcp";
import type {
  MCPConnectionRef,
  MCPServerIdentity,
  MCPServerInfo,
  MCPToolCallDisplay,
  MCPToolCallDisplaySource,
} from "@/common/types/mcp";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { httpsOriginOf, isHttpsUrlWithoutUserinfo } from "@/common/utils/mcp/httpsUrl";

/**
 * Pure helpers that turn server-reported MCP identity (`Implementation`
 * metadata from the handshake or from a tool result's `_meta`) into the
 * bounded, credential-free display values Xum persists and renders.
 *
 * Everything a server reports here is untrusted and display-only: it is
 * never used for namespacing, enablement, allowlists, OAuth, or trust
 * decisions. These functions therefore never throw on hostile input — a
 * malformed identity simply yields `undefined`.
 */

/** Standard result-level `_meta` key servers use to identify themselves on every result (MCP 2026-07-28). */
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** `Implementation.icons` entry kept for later resolution; nothing here has been fetched or validated as an image. */
export interface IconCandidate {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface NormalizedServerIdentity {
  identity: MCPServerIdentity;
  iconCandidates: IconCandidate[];
}

/**
 * Characters that can hide, reorder, or terminate display text: C0/C1
 * controls, line/paragraph separators, and the Unicode bidi controls.
 */
const UNSAFE_TEXT = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu;

const ICON_MIME_TYPE_MAX_CHARS = 64;
const ICON_SIZES_MAX = 8;
const ICON_SIZE_MAX_CHARS = 16;

/**
 * Display-text sanitizer over a bounded raw prefix. `maxChars` is the raw
 * UTF-16 inspection budget (the unit zod's string `max` counts): the value is
 * clipped to it first, never splitting a surrogate pair (a pair straddling
 * the boundary is dropped, not halved), and only that prefix is sanitized:
 * unsafe characters become a space, whitespace runs collapse, the result is
 * trimmed. Nothing beyond the prefix is ever read, so a field whose in-budget
 * prefix normalizes to nothing yields undefined even if valid text follows,
 * and normalized text can be shorter than the budget. Replacements never
 * lengthen text, so the result always fits the limit. Returns undefined for
 * non-strings and empty results. This bounds work per field; it is not a
 * latency guarantee for MCP parsing as a whole.
 */
function sanitizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let prefix = value;
  if (value.length > maxChars) {
    const lastUnit = value.charCodeAt(maxChars - 1);
    const cut = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? maxChars - 1 : maxChars;
    prefix = value.slice(0, cut);
  }
  const cleaned = prefix.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeWebsiteUrl(value: unknown): string | undefined {
  // URLs are never truncated (that would change their meaning). The raw length
  // is guarded before any trim or parse, so padding counts against the limit.
  if (typeof value !== "string" || value.length > MCP_IDENTITY_LIMITS.websiteUrlMaxChars) {
    return undefined;
  }
  const trimmed = value.trim();
  return isHttpsUrlWithoutUserinfo(trimmed) ? trimmed : undefined;
}

function isAcceptableIconSrc(src: string): boolean {
  if (src.startsWith("https://")) {
    return src.length <= MCP_IDENTITY_LIMITS.iconHttpsSrcMaxChars && isHttpsUrlWithoutUserinfo(src);
  }
  return src.startsWith("data:") && src.length <= MCP_IDENTITY_LIMITS.iconDataSrcMaxChars;
}

function normalizeIconCandidate(raw: unknown): IconCandidate | undefined {
  if (!isPlainObject(raw) || typeof raw.src !== "string" || !isAcceptableIconSrc(raw.src)) {
    return undefined;
  }
  const candidate: IconCandidate = { src: raw.src };
  const mimeType = sanitizeText(raw.mimeType, ICON_MIME_TYPE_MAX_CHARS);
  if (mimeType) {
    candidate.mimeType = mimeType;
  }
  if (Array.isArray(raw.sizes)) {
    // Bounded prefix (see normalizeIconCandidates): slice before any per-entry work.
    const sizes = raw.sizes
      .slice(0, ICON_SIZES_MAX)
      .map((size) => sanitizeText(size, ICON_SIZE_MAX_CHARS))
      .filter((size): size is string => size !== undefined);
    if (sizes.length > 0) {
      candidate.sizes = sizes;
    }
  }
  if (raw.theme === "light" || raw.theme === "dark") {
    candidate.theme = raw.theme;
  }
  return candidate;
}

function normalizeIconCandidates(raw: unknown): IconCandidate[] {
  const candidates: IconCandidate[] = [];
  if (!Array.isArray(raw)) {
    return candidates;
  }
  // Bounded prefix: only the first `iconCandidatesMax` raw entries are ever
  // inspected. Invalid entries consume that budget and valid entries beyond it
  // are ignored, so a huge or hostile `icons` array costs bounded work (the
  // per-entry string bounds are unchanged). The text identity is unaffected.
  for (const entry of raw.slice(0, MCP_IDENTITY_LIMITS.iconCandidatesMax)) {
    const candidate = normalizeIconCandidate(entry);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Normalize anything a server reported as its `Implementation`. Returns
 * undefined unless `name` and `version` are non-empty strings after
 * sanitizing; optional fields are kept only when valid. Never throws.
 */
export function normalizeServerIdentity(raw: unknown): NormalizedServerIdentity | undefined {
  try {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    const name = sanitizeText(raw.name, MCP_IDENTITY_LIMITS.nameMaxChars);
    const version = sanitizeText(raw.version, MCP_IDENTITY_LIMITS.versionMaxChars);
    if (!name || !version) {
      return undefined;
    }
    const identity: MCPServerIdentity = { name, version };
    const title = sanitizeText(raw.title, MCP_IDENTITY_LIMITS.titleMaxChars);
    if (title) {
      identity.title = title;
    }
    const description = sanitizeText(raw.description, MCP_IDENTITY_LIMITS.descriptionMaxChars);
    if (description) {
      identity.description = description;
    }
    const websiteUrl = normalizeWebsiteUrl(raw.websiteUrl);
    if (websiteUrl) {
      identity.websiteUrl = websiteUrl;
    }
    // The schema is the single source of truth for bounds; sanitizing above
    // is what makes real-world input fit it, so a disagreement means the
    // identity is unusable, not that we should crash a tool call.
    if (!MCPServerIdentitySchema.safeParse(identity).success) {
      return undefined;
    }
    return { identity, iconCandidates: normalizeIconCandidates(raw.icons) };
  } catch {
    return undefined;
  }
}

/**
 * Credential-free description of a configured connection for display beside
 * an identity. stdio servers contribute only their key (command and args can
 * carry tokens); url servers contribute the https origin of their URL —
 * never path, query, userinfo, or headers.
 *
 * `actualTransport` is the transport the manager resolved (an `auto`
 * configuration becomes http or sse at connect time). A stdio configuration
 * is always reported as stdio and a url configuration never as stdio; an
 * unresolved `auto` defaults to http.
 *
 * The key is sanitized like other display text; if it sanitizes to nothing
 * the ref is invalid and `buildToolCallDisplay` yields no snapshot.
 */
export function describeConnection(
  key: string,
  config: MCPServerInfo,
  actualTransport?: "stdio" | "http" | "sse"
): MCPConnectionRef {
  const ref: MCPConnectionRef = {
    key: sanitizeText(key, MCP_IDENTITY_LIMITS.connectionKeyMaxChars) ?? "",
    transport: "stdio",
  };
  if (config.transport === "stdio") {
    return ref;
  }
  if (actualTransport === "http" || actualTransport === "sse") {
    ref.transport = actualTransport;
  } else {
    ref.transport = config.transport === "auto" ? "http" : config.transport;
  }
  const origin = httpsOriginOf(config.url);
  if (origin) {
    ref.origin = origin;
  }
  return ref;
}

/** Optional identity fields, in the order they are dropped to meet the snapshot byte budget. */
const DISPLAY_TRIM_ORDER = ["description", "websiteUrl", "title"] as const;

function withoutUndefinedValues<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Build the per-call snapshot persisted on an MCP tool part. Returns
 * undefined when there is no identity or the connection ref is invalid;
 * otherwise drops optional identity fields (description, then websiteUrl,
 * then title) until the snapshot passes `MCPToolCallDisplaySchema`,
 * including its aggregate byte budget. The result carries no
 * undefined-valued keys.
 */
export function buildToolCallDisplay(input: {
  connection: MCPConnectionRef;
  identity: MCPServerIdentity | undefined;
  source: MCPToolCallDisplaySource;
  iconRef?: string;
}): MCPToolCallDisplay | undefined {
  if (!input.identity) {
    return undefined;
  }
  const identity: MCPServerIdentity = { ...input.identity };
  const candidate = {
    connection: input.connection,
    identity,
    source: input.source,
    iconRef: input.iconRef,
  };
  for (let attempt = 0; ; attempt++) {
    const parsed = MCPToolCallDisplaySchema.safeParse(candidate);
    if (parsed.success) {
      return {
        connection: withoutUndefinedValues(parsed.data.connection),
        identity: withoutUndefinedValues(parsed.data.identity),
        source: parsed.data.source,
        ...(parsed.data.iconRef ? { iconRef: parsed.data.iconRef } : {}),
      };
    }
    const field = DISPLAY_TRIM_ORDER[attempt];
    if (field === undefined) {
      return undefined;
    }
    delete identity[field];
  }
}

/**
 * Split the standard display key out of a raw MCP tool result's `_meta`
 * without mutating the result. Only `_meta[MCP_SERVER_INFO_META_KEY]` is
 * removed — content and unrelated `_meta` keys are untouched (and `_meta`
 * disappears entirely once it is empty). When there is nothing to remove,
 * `rest` is the input itself.
 */
export function takeStandardDisplayMeta(raw: unknown): { rest: unknown; displayKeyValue: unknown } {
  if (
    !isPlainObject(raw) ||
    !isPlainObject(raw._meta) ||
    !Object.hasOwn(raw._meta, MCP_SERVER_INFO_META_KEY)
  ) {
    return { rest: raw, displayKeyValue: undefined };
  }
  const { [MCP_SERVER_INFO_META_KEY]: displayKeyValue, ...meta } = raw._meta;
  const { _meta, ...rest } = raw;
  return {
    rest: Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest,
    displayKeyValue,
  };
}
