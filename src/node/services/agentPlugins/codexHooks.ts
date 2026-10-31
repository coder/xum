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
 * - Claude Code plugins use the same file shape (`hooks/hooks.json`, plus the manifest's `hooks`
 *   files). Xum lists their hooks on every Claude event and never runs any of them, `mcp_tool`
 *   included: Claude matchers name Claude tools, and Xum maps only Codex tool names.
 * - Trust: Codex trusts each hook by the hash of its exact definition, so a new or changed hook
 *   is skipped until the user trusts it. `hash` is that key (see pluginHookTrust.ts).
 *
 * Fail-soft like the manifest: every invalid file, group or handler is dropped with a warning.
 *
 * Where Xum accepts more than Codex (each one is intended):
 * - A float literal with a whole value (`30.0`, `3e1`) is a valid `timeout`: JSON.parse returns
 *   the same number as for `30`, so the text cannot be told apart. Codex's u64 parse rejects it.
 * - An invalid handler drops only itself (with a warning). Codex rejects the whole file.
 * - `timeout: null` and an omitted `timeout` both mean the default, but they hash differently
 *   (the hash covers the raw definition), so changing one into the other needs a new review.
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
import {
  PLUGIN_MANIFEST_RELATIVE_PATH,
  readPluginFileWithinRootCapped,
  type AgentPluginInfo,
} from "./discovery";
import { isPlainObject } from "./manifest";
import { MAX_HOOK_POINTER_ENTRIES, type OpenAIPluginHooksEntry } from "./openaiExtension";

/** Codex events Xum maps to its own hook points. */
export const MAPPED_CODEX_HOOK_EVENTS = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  UserPromptSubmit: "message.send",
  Stop: "turn.stop",
} as const;

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

/**
 * Claude Code hook events (https://code.claude.com/docs/en/hooks.md). A Claude package's hooks on
 * these events are listed and never run.
 */
const CLAUDE_HOOK_EVENTS = new Set([
  ...Object.keys(MAPPED_CODEX_HOOK_EVENTS),
  ...IGNORED_CODEX_HOOK_EVENTS,
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionDenied",
  "Notification",
  "UserPromptExpansion",
  "MessageDisplay",
  "TaskCreated",
  "TaskCompleted",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreModelSwitch",
  "PostModelSwitch",
  "Setup",
  "InstructionsLoaded",
  "Elicitation",
  "ElicitationResult",
]);

/** Codex ignores the matcher on these events (codex-rs/hooks/src/events/common.rs). */
const MATCHERLESS_CODEX_HOOK_EVENTS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);

/**
 * Claude Code has no matcher support on these events and silently ignores a matcher there
 * (hooks.md "Matcher patterns"), so Xum does not check it: the never-run hook stays listed.
 */
const MATCHERLESS_CLAUDE_HOOK_EVENTS = new Set([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "MessageDisplay",
  "CwdChanged",
]);

const DEFAULT_HOOKS_FILE = "hooks/hooks.json";
const MAX_HOOKS_FILE_BYTES = 256 * 1024;
/**
 * Codex reads `timeout` as a u64 (whole seconds); the runner caps it at 30 s anyway. JSON.parse
 * rounds u64::MAX (18446744073709551615) up to 2^64, so the bound is inclusive: the one value it
 * also lets through, 2^64 itself, cannot be told apart after parsing (PRRT_kwDOPxxmWM6sSOZI).
 */
const U64_MAX_AFTER_PARSE = 2 ** 64;
/**
 * Bounds for one plugin. Install Preview loads the hooks of an untrusted repository, and a
 * 256 KiB manifest can repeat one path tens of thousands of times: without them one Preview
 * could reread the same file each time and exhaust the backend's memory. The pointer entry cap
 * (MAX_HOOK_POINTER_ENTRIES) is shared with discovery's readOpenAIExtension.
 */
const MAX_PLUGIN_HOOKS = 256;
/** Warnings kept per plugin: each file can hold ~100k invalid groups, each one a warning. */
const MAX_HOOK_WARNINGS = 50;

/**
 * Keeps the first MAX_HOOK_WARNINGS warnings and counts the rest, so a file with ~100k invalid
 * groups never holds ~100k strings (Codex PRRT_kwDOPxxmWM6rRIkV).
 */
class HookWarnings {
  private readonly kept: string[] = [];
  private omitted = 0;

  push(warning: string): void {
    if (this.kept.length < MAX_HOOK_WARNINGS) this.kept.push(warning);
    else this.omitted++;
  }

  list(): string[] {
    const omitted = this.omitted > 0 ? [`${this.omitted} more hook warnings not shown`] : [];
    return [...this.kept, ...omitted];
  }
}

/** A parsed hook; the trust review state is added by pluginHookTrust.ts. */
export type PluginHookDefinition = Omit<AgentPluginHook, "review">;

export interface PluginHooksLoadResult {
  hooks: PluginHookDefinition[];
  warnings: string[];
}

/**
 * Read and parse a plugin's Codex hooks. An explicit `com.openai` pointer replaces the default
 * `hooks/hooks.json`; it never adds to it. A Claude package's manifest `hooks` files add to the
 * default (the Claude rule), and every one of its hooks gets the `claude-plugin` status.
 *
 * The pointer is the `com.openai` extension discovery selected (root `plugin.json`, a Codex-only
 * `.codex-plugin/plugin.json`, or the overlay next to a root manifest without one), already
 * validated by readOpenAIExtension: the loader never reads `plugin.manifest` for it (Codex
 * PRRT_kwDOPxxmWM6r2kUR). Inline entries are labeled with that manifest's path
 * (PRRT_kwDOPxxmWM6r2kUY).
 */
export async function loadPluginCodexHooks(
  plugin: Pick<
    AgentPluginInfo,
    | "rootPath"
    | "openai"
    | "openaiManifestPath"
    | "claudeFallback"
    | "claude"
    | "skillsOnly"
    | "cursorFallback"
  >
): Promise<PluginHooksLoadResult> {
  // A skills-only package has no hooks, not even the default hooks/hooks.json. A Cursor package's
  // hooks.json is in the Cursor format, which this loader does not read (discovery lists it).
  if (plugin.skillsOnly === true || plugin.cursorFallback === true) {
    return { hooks: [], warnings: [] };
  }
  const warnings = new HookWarnings();
  const hooks: PluginHookDefinition[] = [];
  const { entries, defaultFileListed } = listHookEntries(plugin, warnings);
  const claude = plugin.claudeFallback === true;
  const seenFiles = new Set<string>();
  const inlineSource = path.normalize(plugin.openaiManifestPath ?? PLUGIN_MANIFEST_RELATIVE_PATH);
  for (const [index, entry] of entries.entries()) {
    if (hooks.length > MAX_PLUGIN_HOOKS) break;
    if (typeof entry !== "string") {
      parseHooksDocument(
        entry.inline,
        { source: `${inlineSource}#hooks[${entry.index}]`, claude },
        hooks,
        warnings
      );
      continue;
    }
    // A hook key is `<source>#<event>[group][handler]`, and an inline source is
    // `<manifest>#hooks[i]` (plugin.json or .codex-plugin/plugin.json). A file path with `#` could
    // produce an inline source's keys and share or overwrite its trust, so such paths are refused.
    if (entry.includes("#")) {
      warnings.push(`${entry}: a hooks file path must not contain '#'; ignoring it`);
      continue;
    }
    if (seenFiles.has(path.normalize(entry))) {
      warnings.push(`${entry} is listed more than once; reading it once`);
      continue;
    }
    seenFiles.add(path.normalize(entry));
    // Only the default file is optional: a listed file that is missing is a plugin bug.
    const isDefault = defaultFileListed && index === 0;
    const document = await readHooksDocument(plugin.rootPath, entry, isDefault, warnings);
    if (document === undefined) continue;
    parseHooksDocument(document, { source: path.normalize(entry), claude }, hooks, warnings);
  }
  const list = warnings.list();
  if (hooks.length > MAX_PLUGIN_HOOKS) {
    list.push(`More than ${MAX_PLUGIN_HOOKS} hooks; ignoring the rest`);
    hooks.length = MAX_PLUGIN_HOOKS;
  }
  return { hooks, warnings: list };
}

/**
 * The hook sources to read, in order: the com.openai pointer, or the default file followed by a
 * Claude package's manifest `hooks` files. A Claude package has no com.openai pointer (discovery
 * drops its extensions). `defaultFileListed`: the first entry is the optional default file.
 */
function listHookEntries(
  plugin: Pick<AgentPluginInfo, "openai" | "claudeFallback" | "claude">,
  warnings: HookWarnings
): { entries: OpenAIPluginHooksEntry[]; defaultFileListed: boolean } {
  const pointer = plugin.openai?.hooks;
  if (pointer == null) {
    const claudeFiles = plugin.claudeFallback === true ? (plugin.claude?.hooks ?? []) : [];
    return { entries: [DEFAULT_HOOKS_FILE, ...claudeFiles], defaultFileListed: true };
  }
  // Discovery already caps the entries; this guards any other caller of the loader.
  if (pointer.length > MAX_HOOK_POINTER_ENTRIES) {
    warnings.push(
      `'extensions["com.openai"].hooks' has ${pointer.length} entries; reading only the first ${MAX_HOOK_POINTER_ENTRIES}`
    );
  }
  return { entries: pointer.slice(0, MAX_HOOK_POINTER_ENTRIES), defaultFileListed: false };
}

/** A hooks file parsed as JSON, or undefined (with a warning) when it cannot be read or parsed. */
async function readHooksDocument(
  rootPath: string,
  relativePath: string,
  isDefault: boolean,
  warnings: HookWarnings
): Promise<unknown> {
  const content = await readHooksFile(rootPath, relativePath, isDefault, warnings);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    warnings.push(`${relativePath} is not valid JSON; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
}

async function readHooksFile(
  rootPath: string,
  relativePath: string,
  isDefault: boolean,
  warnings: HookWarnings
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
  where: { source: string; claude: boolean },
  out: PluginHookDefinition[],
  warnings: HookWarnings
): void {
  const { source, claude } = where;
  if (!isPlainObject(document) || !isPlainObject(document.hooks)) {
    warnings.push(`${source}: expected { "hooks": { <Event>: [...] } }; ignoring it`);
    return;
  }
  for (const [event, value] of Object.entries(document.hooks)) {
    const groups = readEventGroups(event, value, where, warnings);
    if (groups === undefined) continue;
    const status: PluginHookStatus | undefined = claude
      ? "claude-plugin"
      : Object.hasOwn(MAPPED_CODEX_HOOK_EVENTS, event)
        ? undefined
        : "ignored-event";
    for (const [groupIndex, group] of groups.entries()) {
      // The plugin's hook budget is checked inside each document too (PRRT_kwDOPxxmWM6rRIkV).
      if (out.length > MAX_PLUGIN_HOOKS) return;
      const groupKey = `${source}#${event}[${groupIndex}]`;
      parseMatcherGroup(group, { source, groupKey, event, status }, out, warnings);
    }
  }
}

/** An event's matcher groups, or undefined (with a warning) for an unknown event or a non-array. */
function readEventGroups(
  event: string,
  groups: unknown,
  where: { source: string; claude: boolean },
  warnings: HookWarnings
): unknown[] | undefined {
  const { source } = where;
  const known = where.claude
    ? CLAUDE_HOOK_EVENTS.has(event)
    : Object.hasOwn(MAPPED_CODEX_HOOK_EVENTS, event) || IGNORED_CODEX_HOOK_EVENTS.has(event);
  if (!known) {
    warnings.push(`${source}: unknown hook event '${event}'; ignoring it`);
    return undefined;
  }
  if (!Array.isArray(groups)) {
    warnings.push(`${source}: '${event}' must be an array of matcher groups; ignoring it`);
    return undefined;
  }
  const list: unknown[] = groups;
  return list;
}

function parseMatcherGroup(
  group: unknown,
  where: {
    source: string;
    groupKey: string;
    event: string;
    /** Fixed status of every hook in the group; undefined: decided by the handler type. */
    status: PluginHookStatus | undefined;
  },
  out: PluginHookDefinition[],
  warnings: HookWarnings
): void {
  const { source, groupKey, event } = where;
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
    warnings.push(`${source}: a '${event}' matcher group needs a "hooks" array; ignoring it`);
    return;
  }
  const claude = where.status === "claude-plugin";
  const matcher = readGroupMatcher(group.matcher, source, event, warnings, claude);
  if (matcher === null) return;
  for (const [handlerIndex, raw] of group.hooks.entries()) {
    if (out.length > MAX_PLUGIN_HOOKS) return;
    const handler = parseHandler(raw, `${source}: '${event}'`, warnings, { claude });
    if (handler === undefined) continue;
    let hash: string;
    try {
      hash = hashHookDefinition(event, matcher, raw);
    } catch (error) {
      // Drop only this handler: one malformed hook must not fail the plugin's whole hook load.
      warnings.push(`${source}: '${event}': ${getErrorMessage(error)}; ignoring a handler`);
      continue;
    }
    const status: PluginHookStatus =
      where.status ?? (handler.type === "mcp_tool" ? "runnable" : "unsupported-handler");
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

/**
 * The group's matcher: undefined for match-all, null (with a warning) when Xum refuses it.
 *
 * Codex treats "*", "", null and an omitted matcher as match-all (`matcher: Option<String>`), and
 * "*" is not a valid regex. All of them become "no matcher", which the runtime matches against
 * every tool. On the events where Codex ignores the matcher, an invalid one must not drop the
 * group, so it is ignored too.
 */
function readGroupMatcher(
  matcher: unknown,
  source: string,
  event: string,
  warnings: HookWarnings,
  claude: boolean
): string | undefined | null {
  const matcherless = claude ? MATCHERLESS_CLAUDE_HOOK_EVENTS : MATCHERLESS_CODEX_HOOK_EVENTS;
  if (matcher == null || matcher === "*" || matcher === "" || matcherless.has(event)) {
    return undefined;
  }
  const error = typeof matcher === "string" ? hookMatcherError(matcher) : "not a string";
  if (typeof matcher === "string" && error === undefined) return matcher;
  // Name the matcher: a plugin can have several groups per event, and the warning must say which
  // one Xum refused.
  warnings.push(
    `${source}: a '${event}' matcher is not a valid regex (${String(error)}); ignoring its group ${quoteForWarning(matcher)}`
  );
  return null;
}

function isU64(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= U64_MAX_AFTER_PARSE
  );
}

function parseHandler(
  raw: unknown,
  where: string,
  warnings: HookWarnings,
  dialect: { claude: boolean }
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
      // Codex reads `timeout: Option<u64>` (codex-rs/config/src/hook_config.rs): null is the
      // default, and a fraction or a negative number does not parse. Codex then raises 0 to one
      // second instead of dropping the hook. Codex drops the whole file on a parse error; Xum
      // drops only this handler, as for every invalid field. Integer also excludes `1e400`
      // (Infinity), which JSON and the review RPC cannot carry.
      if (timeout != null && !isU64(timeout)) {
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
      {
        const summary = commandSummary(raw.command, dialect.claude ? raw.args : undefined);
        if (summary !== undefined) return { type: "command", summary };
        invalid = "args";
        break;
      }
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
 * A command hook's summary. Claude's exec form adds `args`, the argument vector, so the
 * disclosure shows it too: each argument is quoted when it is empty or has a space or quote.
 * Undefined when `args` is not a list of strings.
 */
function commandSummary(command: string, args: unknown): string | undefined {
  if (args === undefined) return command;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return undefined;
  const argv: string[] = [command, ...args];
  return argv
    .map((arg) => (arg === "" || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
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
 * - `(?P<name>...)` becomes `(?<name>...)`, and the `\A`/`\z` text anchors become lookarounds that
 *   ignore the m flag, as Rust's do (Codex PRRT_kwDOPxxmWM6rN8BF).
 * Other Rust-only syntax is not translated. JavaScript rejects some of it: inline flags after the
 * start or negated (`(?-i)`), and the `x`, `U`, `u` and `R` flags. It would accept the rest and
 * read it differently, so a guard would silently miss the tools it targets; Xum refuses that
 * syntax instead (see translateRustSyntax). Either way the group is dropped with a warning.
 * Callers handle match-all ("*", "" or no matcher) first. Throws a SyntaxError for a pattern
 * Xum cannot compile.
 */
export function compileHookMatcher(pattern: string): RegExp {
  if (/^[A-Za-z0-9_|]+$/.test(pattern)) return new RegExp(`^(?:${pattern})$`);
  const translated = translateRustSyntax(pattern);
  if (translated.refused !== undefined) {
    throw new SyntaxError(`${translated.refused} means something else in JavaScript`);
  }
  const source = translated.source;
  const flags = /^\(\?([ims]+)\)/.exec(source);
  if (flags === null) return new RegExp(source);
  return new RegExp(source.slice(flags[0].length), [...new Set(flags[1])].join(""));
}

/** Rust escapes outside a class with a JavaScript equivalent (the anchors ignore the m flag). */
const TRANSLATED_ESCAPES: Readonly<Record<string, string>> = {
  // Wrapped in a group: Rust lets an anchor take a quantifier (`\A+`), JavaScript a lookaround not.
  "\\A": "(?:(?<![\\s\\S]))",
  "\\z": "(?:(?![\\s\\S]))",
};

/**
 * The pattern with the translatable Rust syntax rewritten (see compileHookMatcher), or the first
 * construct that Rust `regex` and a JavaScript RegExp (without the `u` flag) both accept but read
 * differently:
 * - an escaped letter or `<`/`>` that JavaScript reads as a literal: `\A` and `\z` anchors,
 *   `\pL` and `\p{...}` classes, `\x{...}`, `\u{...}`, `\U...`, `\b{start}`, `\<`, `\>`;
 * - inside a class, `[` (a nested or POSIX class such as `[[:alpha:]]`), the set operators
 *   `&&`, `--` and `~~`, and a leading `]` (a literal in Rust, an empty class in JavaScript).
 */
function translateRustSyntax(pattern: string): { source: string; refused?: string } {
  let inClass = false;
  let source = "";
  const names = new Set<string>();
  for (let i = 0; i < pattern.length; ) {
    const step: SyntaxStep =
      pattern[i] === "\\"
        ? escapeStep(pattern, i, inClass)
        : inClass
          ? classStep(pattern, i)
          : textStep(pattern, i);
    const refused = step.refused ?? claimGroupName(names, step.groupName);
    if (refused !== undefined) return { source, refused };
    source += step.text;
    i += step.length;
    inClass = step.inClass ?? inClass;
  }
  return { source };
}

/** One step of translateRustSyntax: the text it emits, the characters it read, a class change. */
interface SyntaxStep {
  text: string;
  length: number;
  inClass?: boolean;
  refused?: string;
  /** The name of a named group this step opens. */
  groupName?: string;
}

/** Rust rejects a group name used twice, also across alternatives (JavaScript accepts that). */
function claimGroupName(names: Set<string>, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (names.has(name)) return "a group name used twice";
  names.add(name);
  return undefined;
}

function escapeStep(pattern: string, index: number, inClass: boolean): SyntaxStep {
  const escape = readEscape(pattern, index);
  const translated = inClass ? undefined : TRANSLATED_ESCAPES[escape];
  if (translated === undefined && !isSameEscape(escape)) {
    return { text: "", length: 0, refused: `'${escape}'` };
  }
  if (/^\\[bB]$/.test(escape) && pattern[index + 2] === "{") {
    return { text: "", length: 0, refused: `'${escape}{...}'` };
  }
  return { text: translated ?? escape, length: escape.length };
}

/**
 * Outside a class: `(?P<name>` becomes `(?<name>` (both dialects read `(?<name>`), and `[` opens a
 * class (with its `^`). Only a name both dialects accept passes: a letter or `_`, then letters,
 * decimal digits or `_` (Rust rejects `$`, JavaScript rejects `.`, `[` and `]`).
 */
function textStep(pattern: string, index: number): SyntaxStep {
  if (pattern.startsWith("(?", index)) {
    // Sticky and bounded, so a file of unclosed openers is read once, not once per opener (Codex
    // PRRT_kwDOPxxmWM6s4vbk). A longer name is refused.
    GROUP_OPENER.lastIndex = index;
    const group = GROUP_OPENER.exec(pattern);
    if (group !== null) return groupStep(group[1] === "P", group[2]);
    if (/^\(\?P?<(?![=!])/.test(pattern.slice(index, index + 4))) {
      return { text: "", length: 0, refused: "this '(?P<name>' group name" };
    }
  }
  if (pattern[index] !== "[") return { text: pattern[index], length: 1 };
  const open = pattern[index + 1] === "^" ? "[^" : "[";
  if (pattern[index + open.length] === "]") return { text: "", length: 0, refused: "'[]...]'" };
  return { text: open, length: open.length, inClass: true };
}

const GROUP_OPENER = /\(\?(P?)<(?![=!])([^>]{0,128})>/y;

/**
 * Rust's capture-name rule (a letter or `_`, then letters, numbers, `_`, `.`, `[` or `]`, with
 * Unicode's Alphabetic and Numeric properties; Codex PRRT_kwDOPxxmWM6s4vbi). JavaScript then
 * enforces its side when it compiles the pattern: it rejects `.`, `[` and `]`.
 */
function groupStep(rustOnlyForm: boolean, name: string): SyntaxStep {
  if (!/^[\p{Alphabetic}_][\p{Alphabetic}\p{N}_.[\]]*$/u.test(name)) {
    return { text: "", length: 0, refused: "this '(?P<name>' group name" };
  }
  return { text: "(?<", length: rustOnlyForm ? 4 : 3, groupName: name };
}

/** Inside a class: nested classes and set operators are refused, `]` closes it. */
function classStep(pattern: string, index: number): SyntaxStep {
  const char = pattern[index];
  const pair = pattern.slice(index, index + 2);
  if (char === "[" || pair === "&&" || pair === "--" || pair === "~~") {
    return { text: "", length: 0, refused: `'${char === "[" ? char : pair}' in a character class` };
  }
  return { text: char, length: 1, ...(char === "]" ? { inClass: false } : {}) };
}

/** The escape at `index`: `\` and one character, plus the hex digits of `\xhh` and `\uhhhh`. */
function readEscape(pattern: string, index: number): string {
  // A bounded slice: an escape is at most 6 characters, and each escape is read once.
  const hex = /^\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/.exec(pattern.slice(index, index + 6));
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
