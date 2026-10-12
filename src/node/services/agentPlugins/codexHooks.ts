/**
 * Codex-format plugin hooks (`hooks/hooks.json`, or `extensions["com.openai"].hooks`): discovery,
 * parsing and a hash per hook. Nothing here runs a hook.
 *
 * Sources: https://developers.openai.com/plugins/build/plugins.md (bundled lifecycle hooks) and
 * https://learn.chatgpt.com/docs/hooks (shape, events, handlers, trust).
 *
 * - Shape: `{ hooks: { <Event>: [{ matcher?: regex, hooks: [handler] }] } }`.
 * - Only `mcp_tool` handlers on the four mapped events can run (in a later change). `command`,
 *   `prompt` and `agent` handlers are parsed and never run; other Codex events are parsed and
 *   ignored. Both are listed so the user sees what the plugin declares.
 * - Trust: Codex trusts each hook by the hash of its exact definition, so a new or changed hook
 *   is skipped until the user trusts it. `hash` is that key (see pluginHookTrust.ts).
 *
 * Fail-soft like the manifest: every invalid file, group or handler is dropped with a warning.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type {
  AgentPluginHook,
  PluginHookHandler,
  PluginHookStatus,
} from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";
import { ensurePathContained } from "@/node/services/tools/skillFileUtils";
import { readPluginFileWithinRootCapped, type AgentPluginInfo } from "./discovery";
import { isPlainObject, isSafeContributesPath, type AgentPluginManifest } from "./manifest";

/** Codex events Xum maps to its own hook points. */
export const MAPPED_CODEX_HOOK_EVENTS = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  UserPromptSubmit: "message.send",
  Stop: "turn.stop",
} as const;
export type MappedCodexHookEvent = keyof typeof MAPPED_CODEX_HOOK_EVENTS;

/** Other Codex events: parsed and listed, never run. */
const IGNORED_CODEX_HOOK_EVENTS = new Set([
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Interrupt",
]);

/** Codex ignores the matcher on these events (codex-rs/hooks/src/events/common.rs). */
const MATCHERLESS_CODEX_HOOK_EVENTS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);

const DEFAULT_HOOKS_FILE = "hooks/hooks.json";
const MAX_HOOKS_FILE_BYTES = 256 * 1024;
/**
 * Bounds for one plugin. Install Preview loads the hooks of an untrusted repository, and a
 * 256 KiB manifest can repeat one path tens of thousands of times: without them one Preview
 * could reread the same file each time and exhaust the backend's memory.
 */
const MAX_HOOK_POINTER_ENTRIES = 32;
const MAX_PLUGIN_HOOKS = 256;
/** Warnings kept per plugin: each file can hold ~100k invalid groups, each one a warning. */
const MAX_HOOK_WARNINGS = 50;

/** A parsed hook; the trust review state is added by pluginHookTrust.ts. */
export type PluginHookDefinition = Omit<AgentPluginHook, "review">;

export interface PluginHooksLoadResult {
  hooks: PluginHookDefinition[];
  warnings: string[];
}

/** One `extensions["com.openai"].hooks` entry: a relative hooks-file path or an inline object. */
export type OpenAIPluginHooksEntry = string | Record<string, unknown>;

/**
 * Adapter for the `extensions["com.openai"].hooks` pointer (path | path[] | object | object[]).
 * The A1 stack (`plugin-openai-extension`) parses the same field in `readOpenAIExtension`, with
 * the `.codex-plugin/plugin.json` fallback. When the stacks meet, replace this body with
 * `readOpenAIExtension(manifest).extension?.hooks` (same result type and rules).
 */
export function readOpenAIHooksPointer(
  manifest: Pick<AgentPluginManifest, "extensions">,
  warnings: string[]
): OpenAIPluginHooksEntry[] | undefined {
  const openai = manifest.extensions?.["com.openai"];
  if (!isPlainObject(openai) || openai.hooks === undefined) return undefined;
  const entries: unknown[] = Array.isArray(openai.hooks) ? openai.hooks : [openai.hooks];
  // Capped before validation: each invalid raw entry would add a warning.
  if (entries.length > MAX_HOOK_POINTER_ENTRIES) {
    warnings.push(
      `'extensions["com.openai"].hooks' has ${entries.length} entries; reading only the first ${MAX_HOOK_POINTER_ENTRIES}`
    );
  }
  const hooks: OpenAIPluginHooksEntry[] = [];
  for (const entry of entries.slice(0, MAX_HOOK_POINTER_ENTRIES)) {
    if (isPlainObject(entry)) {
      hooks.push(entry);
      continue;
    }
    const relative = typeof entry === "string" ? entry.replace(/[/\\]+$/, "") : undefined;
    if (relative === undefined || !isSafeContributesPath(relative)) {
      warnings.push(
        `'extensions["com.openai"].hooks' entries must be relative paths inside the plugin or hooks objects; ignoring an entry`
      );
      continue;
    }
    hooks.push(relative);
  }
  return hooks;
}

/**
 * Read and parse a plugin's Codex hooks. An explicit `com.openai` pointer replaces the default
 * `hooks/hooks.json`; it never adds to it.
 */
export async function loadPluginCodexHooks(
  plugin: Pick<AgentPluginInfo, "rootPath" | "manifest">
): Promise<PluginHooksLoadResult> {
  const warnings: string[] = [];
  const hooks: PluginHookDefinition[] = [];
  const pointer = readOpenAIHooksPointer(plugin.manifest, warnings);
  const entries = pointer ?? [DEFAULT_HOOKS_FILE];
  const seenFiles = new Set<string>();
  let omittedWarnings = 0;
  for (const [index, entry] of entries.entries()) {
    // Trimmed after each entry, so at most one file's warnings are held at a time.
    omittedWarnings += Math.max(0, warnings.length - MAX_HOOK_WARNINGS);
    warnings.length = Math.min(warnings.length, MAX_HOOK_WARNINGS);
    if (hooks.length > MAX_PLUGIN_HOOKS) break;
    if (typeof entry !== "string") {
      parseHooksDocument(entry, `plugin.json#hooks[${index}]`, hooks, warnings);
      continue;
    }
    // A hook key is `<source>#<event>[group][handler]`, and an inline source is
    // `plugin.json#hooks[i]`. A file path with `#` could produce an inline source's keys and
    // share or overwrite its trust, so such paths are refused.
    if (entry.includes("#")) {
      warnings.push(`${entry}: a hooks file path must not contain '#'; ignoring it`);
      continue;
    }
    if (seenFiles.has(path.normalize(entry))) {
      warnings.push(`${entry} is listed more than once; reading it once`);
      continue;
    }
    seenFiles.add(path.normalize(entry));
    const content = await readHooksFile(plugin.rootPath, entry, pointer == null, warnings);
    if (content === undefined) continue;
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch (error) {
      warnings.push(`${entry} is not valid JSON; ignoring it: ${getErrorMessage(error)}`);
      continue;
    }
    parseHooksDocument(document, path.normalize(entry), hooks, warnings);
  }
  omittedWarnings += Math.max(0, warnings.length - MAX_HOOK_WARNINGS);
  warnings.length = Math.min(warnings.length, MAX_HOOK_WARNINGS);
  if (omittedWarnings > 0) warnings.push(`${omittedWarnings} more hook warnings not shown`);
  if (hooks.length > MAX_PLUGIN_HOOKS) {
    warnings.push(`More than ${MAX_PLUGIN_HOOKS} hooks; ignoring the rest`);
    hooks.length = MAX_PLUGIN_HOOKS;
  }
  return { hooks, warnings };
}

async function readHooksFile(
  rootPath: string,
  relativePath: string,
  isDefault: boolean,
  warnings: string[]
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await ensurePathContained(rootPath, path.join(rootPath, relativePath));
  } catch (error) {
    // The default file is optional; a pointer naming a missing file is a plugin bug.
    if (isDefault && getErrorCode(error) === "ENOENT") return undefined;
    warnings.push(`${relativePath} cannot be read; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
  try {
    const result = await readPluginFileWithinRootCapped({
      filePath: canonical,
      pluginRoot: rootPath,
      maxBytes: MAX_HOOKS_FILE_BYTES,
      label: relativePath,
    });
    return result.content;
  } catch (error) {
    warnings.push(`${relativePath} cannot be read; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
}

function getErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function parseHooksDocument(
  document: unknown,
  source: string,
  out: PluginHookDefinition[],
  warnings: string[]
): void {
  if (!isPlainObject(document) || !isPlainObject(document.hooks)) {
    warnings.push(`${source}: expected { "hooks": { <Event>: [...] } }; ignoring it`);
    return;
  }
  for (const [event, groups] of Object.entries(document.hooks)) {
    const mapped = Object.hasOwn(MAPPED_CODEX_HOOK_EVENTS, event);
    if (!mapped && !IGNORED_CODEX_HOOK_EVENTS.has(event)) {
      warnings.push(`${source}: unknown hook event '${event}'; ignoring it`);
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`${source}: '${event}' must be an array of matcher groups; ignoring it`);
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      const groupKey = `${source}#${event}[${groupIndex}]`;
      parseMatcherGroup(group, { source, groupKey, event, mapped }, out, warnings);
    }
  }
}

function parseMatcherGroup(
  group: unknown,
  where: { source: string; groupKey: string; event: string; mapped: boolean },
  out: PluginHookDefinition[],
  warnings: string[]
): void {
  const { source, groupKey, event, mapped } = where;
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
    warnings.push(`${source}: a '${event}' matcher group needs a "hooks" array; ignoring it`);
    return;
  }
  // Codex treats "*", "" and an omitted matcher as match-all, and "*" is not a valid regex.
  // All three become "no matcher", which the runtime matches against every tool. On the events
  // where Codex ignores the matcher, an invalid one must not drop the group, so it is ignored too.
  let matcher: string | undefined;
  if (
    group.matcher !== undefined &&
    group.matcher !== "*" &&
    group.matcher !== "" &&
    !MATCHERLESS_CODEX_HOOK_EVENTS.has(event)
  ) {
    const error =
      typeof group.matcher === "string" ? hookMatcherError(group.matcher) : "not a string";
    if (typeof group.matcher !== "string" || error !== undefined) {
      // Name the matcher: a plugin can have several groups per event, and the warning must say
      // which one Xum refused.
      warnings.push(
        `${source}: a '${event}' matcher is not a valid regex (${String(error)}); ignoring its group ${quoteForWarning(group.matcher)}`
      );
      return;
    }
    matcher = group.matcher;
  }
  for (const [handlerIndex, raw] of group.hooks.entries()) {
    const handler = parseHandler(raw, `${source}: '${event}'`, warnings);
    if (handler === undefined) continue;
    let hash: string;
    try {
      hash = hashHookDefinition(event, matcher, raw);
    } catch (error) {
      // Drop only this handler: one malformed hook must not fail the plugin's whole hook load.
      warnings.push(`${source}: '${event}': ${getErrorMessage(error)}; ignoring a handler`);
      continue;
    }
    const status: PluginHookStatus = !mapped
      ? "ignored-event"
      : handler.type === "mcp_tool"
        ? "runnable"
        : "unsupported-handler";
    out.push({
      key: `${groupKey}[${handlerIndex}]`,
      hash,
      event,
      ...(matcher !== undefined ? { matcher } : {}),
      handler,
      status,
      source,
    });
  }
}

function parseHandler(
  raw: unknown,
  where: string,
  warnings: string[]
): PluginHookHandler | undefined {
  if (!isPlainObject(raw)) {
    warnings.push(`${where}: a hook handler must be an object; ignoring it`);
    return undefined;
  }
  let invalid = "";
  switch (raw.type) {
    case "mcp_tool": {
      const { server, tool, input, timeout, statusMessage } = raw;
      // Codex skips a blank (whitespace-only) server or tool, so no blank target looks runnable.
      if (typeof server !== "string" || server.trim().length === 0) {
        invalid = "server";
        break;
      }
      if (typeof tool !== "string" || tool.trim().length === 0) {
        invalid = "tool";
        break;
      }
      if (input !== undefined && !isPlainObject(input)) {
        invalid = "input";
        break;
      }
      // Codex raises a timeout below one second (including 0) to one second instead of dropping
      // the hook. Finite: `1e400` parses to Infinity.
      if (
        timeout !== undefined &&
        !(typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0)
      ) {
        invalid = "timeout";
        break;
      }
      return {
        type: "mcp_tool",
        server,
        tool,
        input: input ?? {},
        ...(typeof timeout === "number" ? { timeoutSeconds: Math.max(1, timeout) } : {}),
        ...(typeof statusMessage === "string" ? { statusMessage } : {}),
      };
    }
    case "command":
      if (typeof raw.command !== "string") {
        invalid = "command";
        break;
      }
      return { type: "command", summary: raw.command };
    case "prompt":
    case "agent":
      return { type: raw.type, summary: `${raw.type} handler` };
    default:
      warnings.push(`${where}: unknown handler type; ignoring it`);
      return undefined;
  }
  // Name the bad field and, when it has one, the handler's tool: two broken handlers in one
  // event must not produce the same warning.
  const tool = typeof raw.tool === "string" ? ` of tool ${quoteForWarning(raw.tool)}` : "";
  warnings.push(
    `${where}: a '${String(raw.type)}' handler has missing or invalid fields ('${invalid}'${tool}); ignoring it`
  );
  return undefined;
}

/**
 * A plugin-written value inside a warning: a string is quoted and cut, so a long value cannot
 * flood it. Any other value is named by its type and never serialized: `JSON.stringify` throws a
 * RangeError on a value nested about 100,000 levels deep (it fits in a hooks file), and that throw
 * would fail the plugin's whole hook load instead of dropping one group.
 */
function quoteForWarning(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Compile a hook matcher the way Codex reads it (codex-rs/hooks/src/engine/matcher.rs). Codex
 * matchers use Rust `regex` syntax; Xum compiles them as JavaScript RegExps, with two rules:
 * - A list of names (only letters, digits, `_` and `|`, e.g. `Bash|Edit`) matches one of the
 *   names exactly, not as a substring.
 * - A leading inline-flag group of `i`, `m` and `s` (e.g. `(?i)`, `(?is)`) becomes RegExp flags.
 * Rust-only syntax is not translated. JavaScript rejects some of it: inline flags after the start
 * or negated (`(?-i)`), the `x`, `U`, `u` and `R` flags, and `(?P<name>...)`. It would accept the
 * rest and read it differently, so a guard would silently miss the tools it targets; Xum refuses
 * that syntax instead (see rustOnlySyntax). Either way the group is dropped with a warning.
 * Callers handle match-all ("*", "" or no matcher) first. Throws a SyntaxError for a pattern
 * Xum cannot compile.
 */
export function compileHookMatcher(pattern: string): RegExp {
  if (/^[A-Za-z0-9_|]+$/.test(pattern)) return new RegExp(`^(?:${pattern})$`);
  const rustOnly = rustOnlySyntax(pattern);
  if (rustOnly !== undefined) {
    throw new SyntaxError(`${rustOnly} means something else in JavaScript`);
  }
  const flags = /^\(\?([ims]+)\)/.exec(pattern);
  if (flags === null) return new RegExp(pattern);
  return new RegExp(pattern.slice(flags[0].length), [...new Set(flags[1])].join(""));
}

/**
 * The first construct that Rust `regex` and a JavaScript RegExp (without the `u` flag) both
 * accept but read differently, or undefined:
 * - an escaped letter or `<`/`>` that JavaScript reads as a literal: `\A` and `\z` anchors,
 *   `\pL` and `\p{...}` classes, `\x{...}`, `\u{...}`, `\U...`, `\b{start}`, `\<`, `\>`;
 * - inside a class, `[` (a nested or POSIX class such as `[[:alpha:]]`), the set operators
 *   `&&`, `--` and `~~`, and a leading `]` (a literal in Rust, an empty class in JavaScript).
 */
function rustOnlySyntax(pattern: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      const escape = readEscape(pattern, i);
      if (!isSameEscape(escape)) return `'${escape}'`;
      if (/^\\[bB]$/.test(escape) && pattern[i + 2] === "{") return `'${escape}{...}'`;
      i += escape.length - 1;
      continue;
    }
    if (!inClass) {
      if (char !== "[") continue;
      inClass = true;
      if (pattern[i + 1] === "^") i++;
      if (pattern[i + 1] === "]") return "'[]...]'";
      continue;
    }
    const pair = pattern.slice(i, i + 2);
    if (char === "[" || pair === "&&" || pair === "--" || pair === "~~") {
      return `'${char === "[" ? char : pair}' in a character class`;
    }
    if (char === "]") inClass = false;
  }
  return undefined;
}

/** The escape at `index`: `\` and one character, plus the hex digits of `\xhh` and `\uhhhh`. */
function readEscape(pattern: string, index: number): string {
  const hex = /^\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/.exec(pattern.slice(index));
  return hex?.[0] ?? pattern.slice(index, index + 2);
}

/** Escapes that both dialects read the same; escaped punctuation is a literal in both. */
function isSameEscape(escape: string): boolean {
  if (escape.length > 2) return true; // \xhh or \uhhhh
  const char = escape.slice(1);
  if (char === "<" || char === ">") return false;
  return !/[A-Za-z]/.test(char) || "dDsSwWbBfnrtv".includes(char);
}

/** undefined when the matcher compiles, else why it does not. */
function hookMatcherError(pattern: string): string | undefined {
  try {
    compileHookMatcher(pattern);
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/**
 * Nesting limit for a hashed definition. canonicalJson recurses, and a 256 KiB file can nest
 * far deeper than the stack allows; real hook inputs nest a few levels.
 */
const MAX_HOOK_DEFINITION_DEPTH = 64;

/**
 * The trust key. Canonical JSON (sorted keys) of the event, the matcher and the handler exactly
 * as declared, so reformatting the file keeps trust and any change to what runs drops it.
 * Throws when the definition nests deeper than MAX_HOOK_DEFINITION_DEPTH.
 */
export function hashHookDefinition(event: string, matcher: string | undefined, handler: unknown) {
  const canonical = canonicalJson({ event, matcher: matcher ?? null, handler });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_HOOK_DEFINITION_DEPTH) {
    throw new Error(`the hook definition nests deeper than ${MAX_HOOK_DEFINITION_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const fields = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`
    );
    return `{${fields.join(",")}}`;
  }
  // `1e400` parses to Infinity, which JSON.stringify writes as null, so two different inputs
  // would share one trust hash. Refuse it; the caller drops only this handler.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("the hook definition contains a non-finite number");
  }
  return JSON.stringify(value) ?? "null";
}
