/**
 * Cursor-format plugin hooks (`hooks/hooks.json`, or the `.cursor-plugin/plugin.json` `hooks`
 * value): parsing and a trust hash per hook. Nothing here runs a hook (cursorHookRunner.ts does).
 *
 * Source: https://cursor.com/docs/hooks.md. Shape:
 * `{ version: 1, hooks: { <event>: [{ command, type?, matcher?, timeout?, loop_limit?, failClosed? }] } }`.
 *
 * - Only a `command` entry on afterFileEdit, afterAgentResponse or stop without a matcher runs
 *   (Cursor plugin RFC D9). Every other entry is listed with its reason (cursorHookNotAppliedReason).
 * - Trust (D1): the hash covers the event, the matcher and the entry exactly as declared, unknown
 *   fields included, and `declared` carries that canonical entry so the review shows all of it.
 * - Fail-soft, as codexHooks.ts: an invalid file or entry is dropped with a warning. The Codex
 *   loader's bounds apply (file size, hooks per plugin, kept warnings).
 *
 * Discovery calls the loader with its own PluginFs, so this module imports discovery for types only.
 */
import * as path from "node:path";
import type { PluginHookStatus } from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";
import {
  MAX_PLUGIN_CONTINUATIONS_PER_USER_TURN,
  cursorHookNotAppliedReason,
} from "@/constants/pluginHooks";
import type { PluginHookDefinition, PluginHooksLoadResult } from "./codexHooks";
import type { AgentPluginNotApplied, PluginFs } from "./discovery";
import {
  HookWarnings,
  MAX_HOOKS_FILE_BYTES,
  MAX_PLUGIN_HOOKS,
  canonicalJson,
  hashHookDefinition,
} from "./hookDefinition";
import { isPlainObject } from "./manifest";

/** The source label of hooks declared inline in the manifest. */
const INLINE_HOOKS_SOURCE = "plugin.json#hooks";

export interface CursorHooksLoadResult extends PluginHooksLoadResult {
  /** One entry per listed hook that does not run, with its reason. */
  notApplied: AgentPluginNotApplied[];
}

/** The normalized manifest `hooks` value (normalizeCursorManifest): a plugin-relative path or an inline document. */
export type CursorHooksSource = string | Record<string, unknown> | undefined;

/**
 * Read and parse a Cursor package's hooks. A path is read only inside the plugin folder, through
 * `fs` (discovery's PluginFs): a path that leaves it, also through a symlink, gives no hooks and a
 * warning. A missing file gives no hooks.
 */
export async function loadPluginCursorHooks(args: {
  rootPath: string;
  source: CursorHooksSource;
  fs: Pick<PluginFs, "ensureContained" | "readFileCapped">;
}): Promise<CursorHooksLoadResult> {
  const warnings = new HookWarnings();
  const document =
    typeof args.source === "string"
      ? await readHooksDocument(args.rootPath, args.source, args.fs, warnings)
      : args.source;
  const label = typeof args.source === "string" ? path.normalize(args.source) : INLINE_HOOKS_SOURCE;
  const hooks: PluginHookDefinition[] =
    document === undefined ? [] : parseCursorHooksDocument(document, label, warnings);
  const list = warnings.list();
  if (hooks.length > MAX_PLUGIN_HOOKS) {
    list.push(`More than ${MAX_PLUGIN_HOOKS} hooks; ignoring the rest`);
    hooks.length = MAX_PLUGIN_HOOKS;
  }
  const notApplied = hooks.flatMap((hook): AgentPluginNotApplied[] => {
    const reason = cursorHookNotAppliedReason(hook);
    return reason === undefined ? [] : [{ part: "hook", name: hookName(hook), reason }];
  });
  return { hooks, warnings: list, notApplied };
}

/** `<event>[<index>]`, the name a warning and a not-applied row use for one entry. */
function hookName(hook: Pick<PluginHookDefinition, "key" | "source">): string {
  return hook.key.slice(`cursor:${hook.source}#`.length);
}

async function readHooksDocument(
  rootPath: string,
  relativePath: string,
  fs: Pick<PluginFs, "ensureContained" | "readFileCapped">,
  warnings: HookWarnings
): Promise<unknown> {
  // A key is `cursor:<source>#<event>[<index>]`, and the inline source holds a `#`: a file path
  // with one could take the inline source's keys (the rule of codexHooks.ts).
  if (relativePath.includes("#")) {
    warnings.push(`${relativePath}: a hooks file path must not contain '#'; ignoring it`);
    return undefined;
  }
  let canonical: string;
  try {
    canonical = await fs.ensureContained(rootPath, path.join(rootPath, relativePath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    warnings.push(`${relativePath} cannot be read; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
  let content: string;
  try {
    ({ content } = await fs.readFileCapped({
      filePath: canonical,
      pluginRoot: rootPath,
      maxBytes: MAX_HOOKS_FILE_BYTES,
      label: relativePath,
    }));
  } catch (error) {
    warnings.push(`${relativePath} cannot be read; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    warnings.push(`${relativePath} is not valid JSON; ignoring it: ${getErrorMessage(error)}`);
    return undefined;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** Up to MAX_PLUGIN_HOOKS + 1 hooks, so the caller can tell that the file holds more. */
function parseCursorHooksDocument(
  document: unknown,
  source: string,
  warnings: HookWarnings
): PluginHookDefinition[] {
  if (!isPlainObject(document) || !isPlainObject(document.hooks)) {
    warnings.push(`${source}: expected { "version": 1, "hooks": { <event>: [...] } }; ignoring it`);
    return [];
  }
  if (document.version !== undefined && document.version !== 1) {
    warnings.push(`${source}: only hooks.json version 1 is supported; ignoring it`);
    return [];
  }
  const hooks: PluginHookDefinition[] = [];
  for (const [event, entries] of Object.entries(document.hooks)) {
    if (!Array.isArray(entries)) {
      warnings.push(`${source}: '${event}' must be an array of hooks; ignoring it`);
      continue;
    }
    for (const [index, raw] of (entries as unknown[]).entries()) {
      if (hooks.length > MAX_PLUGIN_HOOKS) return hooks;
      const hook = parseEntry(raw, { source, event, index }, warnings);
      if (hook !== undefined) hooks.push(hook);
    }
  }
  return hooks;
}

function parseEntry(
  raw: unknown,
  where: { source: string; event: string; index: number },
  warnings: HookWarnings
): PluginHookDefinition | undefined {
  const name = `hook ${where.event}[${where.index}]`;
  const drop = (problem: string) => {
    warnings.push(`${where.source}: ${name}: ${problem}; ignoring this hook`);
    return undefined;
  };
  if (!isPlainObject(raw)) return drop("an entry must be an object");
  const type = raw.type ?? "command";
  if (type !== "command" && type !== "prompt") return drop("type must be command or prompt");
  if (raw.matcher != null && typeof raw.matcher !== "string") {
    return drop("matcher must be a string");
  }
  const matcher = typeof raw.matcher === "string" ? raw.matcher : undefined;
  let hash: string;
  let declared: string;
  try {
    hash = hashHookDefinition(where.event, matcher, raw);
    declared = canonicalJson(raw);
  } catch (error) {
    return drop(getErrorMessage(error));
  }
  const base = {
    key: `cursor:${where.source}#${where.event}[${where.index}]`,
    hash,
    event: where.event,
    ...(matcher !== undefined ? { matcher } : {}),
    source: where.source,
  };
  if (type === "prompt") {
    return withStatus({ ...base, handler: { type: "cursor-prompt", declared } });
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    return drop("an entry needs a command string");
  }
  const loopLimit = readLoopLimit(raw);
  if (loopLimit === "invalid") return drop("loop_limit must be a whole number or null");
  return withStatus({
    ...base,
    handler: {
      type: "cursor-command",
      command: raw.command,
      ...readTimeout(raw, `${where.source}: ${name}`, warnings),
      ...(loopLimit !== undefined ? { loopLimit } : {}),
      ...readFailClosed(raw, `${where.source}: ${name}`, warnings),
      declared,
    },
  });
}

function withStatus(hook: Omit<PluginHookDefinition, "status">): PluginHookDefinition {
  const reason = cursorHookNotAppliedReason(hook);
  const status: PluginHookStatus =
    reason === undefined
      ? "runnable"
      : hook.handler.type === "cursor-prompt"
        ? "unsupported-handler"
        : "ignored-event";
  return { ...hook, status };
}

/**
 * The hook's own continuation limit: a whole number from 0 (never continues) up to the per-user-turn
 * ceiling (a larger one runs as the ceiling; `declared` keeps it), null for none, undefined for the
 * shared default.
 */
function readLoopLimit(raw: Record<string, unknown>): number | null | undefined | "invalid" {
  if (!Object.hasOwn(raw, "loop_limit")) return undefined;
  const value = raw.loop_limit;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "invalid";
  return Math.min(value, MAX_PLUGIN_CONTINUATIONS_PER_USER_TURN);
}

function readTimeout(
  raw: Record<string, unknown>,
  where: string,
  warnings: HookWarnings
): { timeoutSeconds?: number } {
  const value = raw.timeout;
  if (value == null) return {};
  if (typeof value === "number" && value > 0) return { timeoutSeconds: value };
  warnings.push(`${where}: timeout must be a positive number; using the default`);
  return {};
}

/** Parsed and hashed only: no mapped event is a permission hook, so it changes nothing (5.5). */
function readFailClosed(
  raw: Record<string, unknown>,
  where: string,
  warnings: HookWarnings
): { failClosed?: boolean } {
  const value = raw.failClosed;
  if (value === undefined) return {};
  if (typeof value === "boolean") return { failClosed: value };
  warnings.push(`${where}: failClosed must be true or false; ignoring the field`);
  return {};
}
