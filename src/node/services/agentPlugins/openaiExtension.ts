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
import {
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  isPlainObject,
  isSafeContributesPath,
  type AgentPluginManifest,
} from "./manifest";

export const OPENAI_EXTENSION_NAMESPACE = "com.openai";

/** One `hooks` entry: a relative hooks-file path or an inline hooks object (kept opaque). */
export type OpenAIPluginHooksEntry = string | Record<string, unknown>;

export interface OpenAIPluginExtension {
  /** Relative path to the registered MCP server mapping (`.app.json`). */
  apps?: string;
  /** Replaces the default `hooks/hooks.json` when present. Parsed only, never run. */
  hooks?: OpenAIPluginHooksEntry[];
  /** Relative path to a packaged skill's SKILL.md. */
  onboardingSkill?: string;
  // `interface` (presentation metadata) stays opaque in
  // `manifest.extensions["com.openai"]` until the UI that renders it lands
  // with its own field validation.
}

const FIELD = `extensions["${OPENAI_EXTENSION_NAMESPACE}"]`;

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
