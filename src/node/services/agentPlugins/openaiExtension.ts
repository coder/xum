/**
 * OpenAI plugin extension (`extensions["com.openai"]`) reader and the Codex
 * compatibility manifest (`.codex-plugin/plugin.json`) normalizer.
 *
 * Source: https://developers.openai.com/plugins/build/plugins.md. Xum only
 * parses and exposes these fields for now: nothing registers `apps`, runs
 * `hooks` or invokes `onboardingSkill` yet. Every invalid field is dropped
 * with a warning (never fatal), matching manifest.ts.
 *
 * Paths are checked lexically here (relative, no `..`, no absolute/home
 * prefix). A future consumer that opens one MUST resolve it through
 * discovery's realpath containment (ensurePluginPathContained, which also refuses .git) first.
 */
import { getOwn } from "@/common/utils/getOwn";
import {
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  isPlainObject,
  isSafeContributesPath,
  type AgentPluginManifest,
} from "./manifest";

export const OPENAI_EXTENSION_NAMESPACE = "com.openai";

/** Presentation metadata. Plain text only: the renderer never parses it as HTML or markdown. */
export interface OpenAIPluginInterface {
  displayName: string;
  shortDescription: string;
  developerName: string;
  longDescription?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  supportURL?: string;
  /** The spec allows a string or an array; normalized to an array. */
  defaultPrompt?: string[];
  brandColor?: string;
  brandColorDark?: string;
  /** Image paths: relative to the plugin root, read only through the contained capped reader. */
  composerIcon?: string;
  composerIconDark?: string;
  logo?: string;
  logoDark?: string;
  screenshots?: string[];
}

/** One `hooks` entry: a relative hooks-file path or an inline hooks object (kept opaque). */
export type OpenAIPluginHooksEntry = string | Record<string, unknown>;

export interface OpenAIPluginExtension {
  /** Relative path to the registered MCP server mapping (`.app.json`). */
  apps?: string;
  /** Replaces the default `hooks/hooks.json` when present. Parsed only, never run. */
  hooks?: OpenAIPluginHooksEntry[];
  /** Relative path to a packaged skill's SKILL.md. */
  onboardingSkill?: string;
  interface?: OpenAIPluginInterface;
}

const FIELD = `extensions["${OPENAI_EXTENSION_NAMESPACE}"]`;

// OpenAI's package-validation limits
// (https://developers.openai.com/plugins/deploy/submission-errors). Directory
// submission is stricter (30-char display name and subtitle), but installable
// packages only pass package validation, so a tighter cap here would drop a
// valid required name and with it the whole interface.
type FieldKind = "name" | "text" | "url" | "color" | "path" | "labels" | "prompts" | "paths";
const INTERFACE_FIELDS: Record<keyof OpenAIPluginInterface, FieldKind> = {
  displayName: "name",
  shortDescription: "name",
  developerName: "name",
  longDescription: "text",
  category: "text",
  capabilities: "labels",
  websiteURL: "url",
  privacyPolicyURL: "url",
  termsOfServiceURL: "url",
  supportURL: "url",
  defaultPrompt: "prompts",
  brandColor: "color",
  brandColorDark: "color",
  composerIcon: "path",
  composerIconDark: "path",
  logo: "path",
  logoDark: "path",
  screenshots: "paths",
};
const TEXT_CAPS: Partial<Record<keyof OpenAIPluginInterface, number>> = {
  displayName: 80,
  shortDescription: 240,
  developerName: 120,
  longDescription: 4000,
  category: 64,
};
const RULES: Record<FieldKind, string> = {
  name: "a non-empty single line without control or direction characters",
  text: "a string without control or direction characters",
  url: "an https URL (max 2048 characters)",
  color: "a #RRGGBB color",
  path: "a relative path inside the plugin",
  labels: "at most 20 strings of at most 120 characters",
  prompts: "at most 3 strings of at most 512 characters",
  paths: "at most 10 relative paths inside the plugin",
};

/**
 * Characters manifest text must not carry (OpenAI's package rules exclude them too): C0 and C1
 * controls, the Unicode line and paragraph separators, and the invisible direction controls
 * (LRM/RLM/ALM, embeddings/overrides, isolates), which can spoof a displayed plugin or developer.
 * `longDescription` may break lines with \n only.
 */
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
const isText = (value: unknown, max: number, multiline = false): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  !UNSAFE_TEXT.test(value) &&
  (multiline || !value.includes("\n"));
const isTextList = (value: unknown, count: number, max: number): value is string[] =>
  Array.isArray(value) && value.length <= count && value.every((entry) => isText(entry, max));

/** The validated value, or undefined when `value` breaks the rule for `kind`. */
function parseField(kind: FieldKind, value: unknown, cap: number, multiline: boolean): unknown {
  switch (kind) {
    case "name":
      return isText(value, cap) && value.trim().length > 0 ? value : undefined;
    case "text":
      return isText(value, cap, multiline) ? value : undefined;
    case "url": {
      if (!isText(value, 2048) || !URL.canParse(value)) return undefined;
      const url = new URL(value);
      // The parsed spelling: the renderer checks a literal `https://` prefix,
      // so `HTTPS://example.com` must reach it normalized.
      return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
    }
    case "color":
      return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
    case "path":
      return normalizeOpenAIRelativePath(value);
    case "labels":
      return isTextList(value, 20, 120) ? value : undefined;
    case "prompts": {
      const prompts = typeof value === "string" ? [value] : value;
      return isTextList(prompts, 3, 512) ? prompts : undefined;
    }
    case "paths": {
      if (!Array.isArray(value) || value.length > 10) return undefined;
      const paths = value.map(normalizeOpenAIRelativePath);
      return paths.every((entry) => entry !== undefined) ? paths : undefined;
    }
  }
}

function readInterface(raw: unknown, warnings: string[]): OpenAIPluginInterface | undefined {
  if (!isPlainObject(raw)) {
    warnings.push(`'${FIELD}.interface' must be an object; ignoring`);
    return undefined;
  }
  const result: Partial<Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = getOwn(INTERFACE_FIELDS, key);
    if (kind === undefined) {
      warnings.push(`Unknown '${FIELD}.interface.${key}' ignored`);
      continue;
    }
    const parsed = parseField(kind, value, getOwn(TEXT_CAPS, key) ?? 0, key === "longDescription");
    if (parsed !== undefined) result[key] = parsed;
    else warnings.push(`'${FIELD}.interface.${key}' must be ${RULES[kind]}; ignoring`);
  }
  const { displayName, shortDescription, developerName } = result;
  if (
    typeof displayName !== "string" ||
    typeof shortDescription !== "string" ||
    typeof developerName !== "string"
  ) {
    warnings.push(
      `'${FIELD}.interface' needs displayName, shortDescription and developerName; ignoring the interface`
    );
    return undefined;
  }
  return { ...result, displayName, shortDescription, developerName };
}

/**
 * Accept `./skills/`-style package paths: drop trailing slashes, then apply
 * the manifest's safe-relative-path rule. A path naming only the root is refused.
 */
export function normalizeOpenAIRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[/\\]+$/, "");
  if (!isSafeContributesPath(trimmed)) return undefined;
  const segments = trimmed.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment === ".") ? undefined : trimmed;
}

function readHooks(raw: unknown, warnings: string[]): OpenAIPluginHooksEntry[] | undefined {
  const entries: unknown[] = Array.isArray(raw) ? raw : [raw];
  const hooks: OpenAIPluginHooksEntry[] = [];
  for (const entry of entries) {
    if (isPlainObject(entry)) {
      hooks.push(entry);
      continue;
    }
    const relative = normalizeOpenAIRelativePath(entry);
    if (relative === undefined) {
      warnings.push(
        `'${FIELD}.hooks' entries must be relative paths inside the plugin or hooks objects; ignoring an entry`
      );
      continue;
    }
    hooks.push(relative);
  }
  return hooks.length > 0 ? hooks : undefined;
}

/** Typed, validated view of `extensions["com.openai"]`; undefined when absent or not an object. */
export function readOpenAIExtension(manifest: Pick<AgentPluginManifest, "extensions">): {
  extension: OpenAIPluginExtension | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];
  const raw = manifest.extensions?.[OPENAI_EXTENSION_NAMESPACE];
  if (raw === undefined) return { extension: undefined, warnings };
  if (!isPlainObject(raw)) {
    warnings.push(`'${FIELD}' must be an object; ignoring`);
    return { extension: undefined, warnings };
  }

  const extension: OpenAIPluginExtension = {};
  for (const key of ["apps", "onboardingSkill"] as const) {
    if (raw[key] === undefined) continue;
    const relative = normalizeOpenAIRelativePath(raw[key]);
    const isSkillFile = key !== "onboardingSkill" || relative?.split(/[/\\]/).pop() === "SKILL.md";
    if (relative !== undefined && isSkillFile) extension[key] = relative;
    else
      warnings.push(
        `'${FIELD}.${key}' must be a relative path inside the plugin${key === "onboardingSkill" ? " to a SKILL.md" : ""}; ignoring`
      );
  }
  if (raw.hooks !== undefined) {
    const hooks = readHooks(raw.hooks, warnings);
    if (hooks !== undefined) extension.hooks = hooks;
  }
  if (raw.interface !== undefined) {
    const parsed = readInterface(raw.interface, warnings);
    if (parsed !== undefined) extension.interface = parsed;
  }
  return { extension, warnings };
}

/** Codex top-level fields that move into `extensions["com.openai"]`. */
const CODEX_OPENAI_KEYS = ["interface", "apps", "hooks", "onboardingSkill"] as const;
/** Codex top-level component paths that map onto Xum's `contributes`. */
const CODEX_CONTRIBUTES_KEYS = [
  ["skills", "skills"],
  ["mcpServers", "mcp"],
] as const;

/**
 * Rewrite a `.codex-plugin/plugin.json` document into the Agent Plugins 1.0.0
 * shape before the regular validator runs. Used ONLY for that fallback file:
 * the root `plugin.json` parse stays strict. Codex manifests omit `$schema`
 * and keep OpenAI fields at the top level; an inline
 * `extensions["com.openai"]` value wins over a conflicting top-level one.
 *
 * SECURITY AUDIT: a Codex package was not written for Xum and is often
 * unmanaged (`~/.agents/plugins`, a repo), so it gets no Xum-only behavior:
 * `contributes` (slash commands, hooks/agents/workflows paths) and
 * `extensions.mux` (hook tool grants) are dropped here. Discovery also skips
 * the implicit hooks.js, agents/ and workflows/ defaults for these packages.
 */
export function normalizeCodexManifest(raw: unknown): { manifest: unknown; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { manifest: raw, warnings };

  const manifest: Record<string, unknown> = { ...raw };
  manifest.$schema ??= AGENT_PLUGIN_SCHEMA_ID_1_0_0;
  if ("contributes" in raw) {
    warnings.push("'contributes' is not supported in .codex-plugin/plugin.json; ignoring");
    delete manifest.contributes;
  }

  const extensions = isPlainObject(raw.extensions) ? { ...raw.extensions } : {};
  if ("mux" in extensions) {
    warnings.push("'extensions.mux' is not supported in .codex-plugin/plugin.json; ignoring");
    delete extensions.mux;
    manifest.extensions = extensions;
  }
  const openai = isPlainObject(extensions[OPENAI_EXTENSION_NAMESPACE])
    ? { ...extensions[OPENAI_EXTENSION_NAMESPACE] }
    : {};
  let folded = false;
  for (const key of CODEX_OPENAI_KEYS) {
    if (!(key in raw)) continue;
    if (key in openai) {
      warnings.push(
        `Top-level '${key}' conflicts with '${FIELD}.${key}'; using the extensions value`
      );
    } else {
      openai[key] = raw[key];
    }
    delete manifest[key];
    folded = true;
  }
  if (folded) {
    extensions[OPENAI_EXTENSION_NAMESPACE] = openai;
    manifest.extensions = extensions;
  }

  // Only a string path (or a one-entry array) maps: Xum has one skills root.
  // Other forms stay top-level and the validator reports them as unknown.
  const contributes: Record<string, unknown> = {};
  for (const [codexKey, contributesKey] of CODEX_CONTRIBUTES_KEYS) {
    const value: unknown = raw[codexKey];
    const single: unknown = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (typeof single !== "string") continue;
    // An unsafe path is passed through so the validator rejects it with its warning.
    contributes[contributesKey] = normalizeOpenAIRelativePath(single) ?? single;
    delete manifest[codexKey];
  }
  if (Object.keys(contributes).length > 0) manifest.contributes = contributes;

  return { manifest, warnings };
}
