/**
 * Component consent fingerprints (#6498). A managed plugin's skill or MCP server is bound to the
 * fingerprint the user reviewed, not to its name: when a newer Xum parses more of an installed
 * package (a Codex dialect field, an extra skills root), the component's fingerprint changes and
 * it needs a new review instead of loading under an approved name.
 *
 * The same functions run at review time (install, component picker, update, re-review) and at
 * load time, so the two cannot drift. Accepted limitations: a bare command resolves through PATH
 * at launch, and the bytes of a `./` command and of other files in a skill directory are not
 * hashed (a local writer inside the plugin directory can change reviewed bytes either way).
 */
import { createHash } from "node:crypto";

import type {
  MCPHttpServerInfo,
  MCPServerInfo,
  MCPServerOAuthConfig,
  MCPStdioServerInfo,
} from "@/common/types/mcp";
import { getOwn } from "@/common/utils/getOwn";
import { stableStringify } from "@/common/utils/stableStringify";

/** Bump when the fingerprint input changes: every record then needs a new review (fails closed). */
const CONSENT_SCHEME = 1;

type FieldRule = "include" | "exclude";

/**
 * Every server field, by name. A new field is a compile error here until someone decides, so a
 * parser widening changes the fingerprint (fails closed) instead of slipping past it. Excluded:
 * fields the user or the UI owns (`disabled`, `toolAllowlist` only narrows), and provenance.
 */
const STDIO_FIELDS: Record<keyof MCPStdioServerInfo, FieldRule> = {
  transport: "include",
  command: "include",
  args: "include",
  env: "include",
  cwd: "include",
  disabled: "exclude",
  toolAllowlist: "exclude",
  plugin: "exclude",
  configLayer: "exclude",
};
const HTTP_FIELDS: Record<keyof MCPHttpServerInfo, FieldRule> = {
  transport: "include",
  url: "include",
  headers: "include",
  oauth: "include",
  managed: "include",
  disabled: "exclude",
  toolAllowlist: "exclude",
  plugin: "exclude",
  configLayer: "exclude",
};
/** `clientSecretSource` only says where Xum rereads the secret, not what the server does. */
const OAUTH_FIELDS: Record<keyof MCPServerOAuthConfig, FieldRule> = {
  clientId: "include",
  tokenEndpointAuthMethod: "include",
  discovery: "include",
  baseScopes: "include",
  defaultScopes: "include",
  resource: "include",
  clientSecretSource: "exclude",
};

export interface ConsentPaths {
  /**
   * Plugin root spellings that mean "this plugin": the tree this load or review reads, plus the
   * final install path when a review reads a staged clone (a manifest can name it literally).
   */
  rootPaths: readonly string[];
  /** The instance's PLUGIN_DATA directory spellings, the same way. */
  dataPaths: readonly string[];
}

/**
 * Replace the plugin root and data directory with tags, so a staged clone and the installed tree
 * hash alike. Longer spellings go first, and `%` and `<` are escaped in the remaining text: a
 * literal `<root>/x` in a manifest must never hash like the plugin's own `x`.
 */
function normalizePaths(value: string, paths: ConsentPaths): string {
  const tokens = [
    ...paths.rootPaths.map((needle) => [needle, "<root>"] as const),
    ...paths.dataPaths.map((needle) => [needle, "<data>"] as const),
  ]
    .filter(([needle]) => needle.length > 0)
    .sort(([a], [b]) => b.length - a.length);
  const replace = (text: string, index: number): string => {
    if (index === tokens.length) return text.replaceAll("%", "%25").replaceAll("<", "%3C");
    const [needle, tag] = tokens[index];
    return text
      .split(needle)
      .map((part) => replace(part, index + 1))
      .join(tag);
  };
  return replace(value, 0);
}

function normalizeValue(value: unknown, paths: ConsentPaths): unknown {
  if (typeof value === "string") return normalizePaths(value, paths);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, paths));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, paths)])
    );
  }
  return value;
}

function pick<T extends object>(value: T, rules: Record<keyof T, FieldRule>): Partial<T> {
  const picked: Partial<T> = {};
  for (const key of Object.keys(rules) as Array<keyof T>) {
    if (rules[key] === "include" && value[key] !== undefined) picked[key] = value[key];
  }
  return picked;
}

function digest(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/** Fingerprint of everything a plugin MCP server launches or connects with. */
export function serverConsentFingerprint(info: MCPServerInfo, paths: ConsentPaths): string {
  const server =
    info.transport === "stdio"
      ? pick(info, STDIO_FIELDS)
      : {
          ...pick(info, HTTP_FIELDS),
          ...(info.oauth !== undefined ? { oauth: pick(info.oauth, OAUTH_FIELDS) } : {}),
        };
  return digest({
    scheme: CONSENT_SCHEME,
    kind: "mcpServer",
    server: normalizeValue(server, paths),
  });
}

/**
 * Fingerprint of one skill: where it lives in the plugin (the #6494 `extra/foo` vs `skills/foo`
 * case) and its whole parsed frontmatter, so a new frontmatter field fails closed. The body is
 * not covered: no review shows it, and the update review has always treated a body edit as
 * capability-neutral. `paths` patterns are OR-ed, so their order does not count.
 */
export function skillConsentFingerprint(args: {
  relativeDir: string;
  frontmatter: Readonly<Record<string, unknown>>;
}): string {
  const { paths } = args.frontmatter;
  return digest({
    scheme: CONSENT_SCHEME,
    kind: "skill",
    dir: args.relativeDir.replaceAll("\\", "/"),
    frontmatter: {
      ...args.frontmatter,
      ...(Array.isArray(paths) ? { paths: [...(paths as unknown[])].map(String).sort() } : {}),
    },
  });
}

/** Reviewed fingerprints of one install, by component name (registry `componentConsent`). */
export interface ComponentConsent {
  skills: Record<string, string>;
  mcpServers: Record<string, string>;
}

/** True only when the user reviewed exactly this fingerprint. No record (every older install) means no. */
export function isComponentConsented(
  consent: ComponentConsent | undefined,
  kind: keyof ComponentConsent,
  name: string,
  fingerprint: string
): boolean {
  return consent !== undefined && getOwn(consent[kind], name) === fingerprint;
}

export interface ComponentSelection {
  skills: string[];
  mcpServers: string[];
}

/**
 * Consent records after the user saves `selection`, given the fingerprints the review showed
 * (`shown`). Without `previous` (install), every selected component was in the consent preview.
 * With `previous` (the component picker), only components newly added to the selection were
 * shown for consent: a component that stays selected keeps its old record or stays without one,
 * so a picker save never approves a component that changed since its review (#6498 review B1).
 * Deselected components lose their record.
 */
export function consentForSelection(args: {
  selection: ComponentSelection;
  shown: ComponentConsent;
  previous?: { selection: ComponentSelection; consent: ComponentConsent | undefined };
}): ComponentConsent {
  // Built from entries, never by assignment: a component named `__proto__` must stay an own key.
  const records = (kind: keyof ComponentConsent): Record<string, string> =>
    Object.fromEntries(
      args.selection[kind].flatMap((name) => {
        const kept = args.previous?.selection[kind].includes(name) === true;
        const fingerprint = kept
          ? args.previous?.consent !== undefined
            ? getOwn(args.previous.consent[kind], name)
            : undefined
          : getOwn(args.shown[kind], name);
        return fingerprint !== undefined ? [[name, fingerprint] as const] : [];
      })
    );
  return { skills: records("skills"), mcpServers: records("mcpServers") };
}
