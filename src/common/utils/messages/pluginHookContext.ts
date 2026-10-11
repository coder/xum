import type { MuxMessage, PluginHookContextEntry } from "@/common/types/message";

/**
 * Prompt-hook context (MuxMetadata.pluginHookContext) as the provider sees it: labeled
 * `<plugin-hook-context plugin="...">` blocks inside its user row. Shared by the request renderer
 * (renderPluginHookContextForProvider) and every token estimate of a row, so compaction, the
 * token-budget admission and the token display count the text the provider actually receives.
 */

/**
 * Rendered context per message (the full blocks). promptHooks drops entries past it when it saves
 * them, and the read below applies it again (same cap as request.assemble).
 */
export const PLUGIN_HOOK_CONTEXT_MAX_CHARS = 64 * 1024;

/** The rendered block; promptHooks charges its full length against the per-message cap. */
export function renderPluginHookContextEntry(entry: PluginHookContextEntry): string {
  return `<plugin-hook-context plugin="${escapeMarkup(entry.pluginId)}">\n${escapeMarkup(entry.text)}\n</plugin-hook-context>`;
}

/** A user row's rendered hook-context blocks, or undefined when it has none. */
export function renderPluginHookContextBlocks(message: MuxMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const entries = readPersistedEntries(message.metadata?.pluginHookContext);
  return entries.length > 0 ? entries.map(renderPluginHookContextEntry).join("\n") : undefined;
}

/** A user row's provider-visible text: its text parts, then its hook-context blocks. */
export function providerVisibleUserText(message: MuxMessage): string {
  const texts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const blocks = renderPluginHookContextBlocks(message);
  return (blocks != null ? [...texts, blocks] : texts).join("\n");
}

/**
 * chat.jsonl is untrusted on read: the history reader checks only that metadata is an object.
 * A malformed value or entry is dropped, and entries past the cap are cut, so one bad row never
 * fails or overflows every later request.
 */
function readPersistedEntries(value: unknown): PluginHookContextEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  const kept: PluginHookContextEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("pluginId" in entry) ||
      typeof entry.pluginId !== "string" ||
      !("text" in entry) ||
      typeof entry.text !== "string"
    ) {
      continue;
    }
    const valid = { pluginId: entry.pluginId, text: entry.text };
    size += renderPluginHookContextEntry(valid).length;
    // Same rule as the write side: the first entry past the cap ends the list.
    if (size > PLUGIN_HOOK_CONTEXT_MAX_CHARS) break;
    kept.push(valid);
  }
  return kept;
}

/** Plugin-authored text must not be able to close the block or forge another tag. */
function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
