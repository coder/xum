/**
 * The parts of plugin hook loading that every hooks.json dialect shares (Codex, Claude and Cursor):
 * the trust hash and the per-plugin bounds. A leaf module, so discovery can parse Cursor hooks
 * without importing the Codex loader (which imports discovery).
 */
import * as crypto from "node:crypto";
import { isPlainObject } from "./manifest";

/** Largest hooks file Xum reads. */
export const MAX_HOOKS_FILE_BYTES = 256 * 1024;
/**
 * Bounds for one plugin. Install Preview loads the hooks of an untrusted repository, and a
 * 256 KiB manifest can repeat one path tens of thousands of times: without them one Preview
 * could reread the same file each time and exhaust the backend's memory. The pointer entry cap
 * (MAX_HOOK_POINTER_ENTRIES) is shared with discovery's readOpenAIExtension.
 */
export const MAX_PLUGIN_HOOKS = 256;
/** Warnings kept per plugin: each file can hold ~100k invalid groups, each one a warning. */
export const MAX_HOOK_WARNINGS = 50;

/**
 * Keeps the first MAX_HOOK_WARNINGS warnings and counts the rest, so a file with ~100k invalid
 * groups never holds ~100k strings (Codex PRRT_kwDOPxxmWM6rRIkV).
 */
export class HookWarnings {
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

/** Sorted-key JSON of a parsed definition; throws past MAX_HOOK_DEFINITION_DEPTH or on Infinity. */
export function canonicalJson(value: unknown, depth = 0): string {
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
