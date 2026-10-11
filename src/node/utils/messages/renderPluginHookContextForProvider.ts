import type { MuxMessage, PluginHookContextEntry } from "@/common/types/message";

/**
 * Append each user row's prompt-hook context (MuxMetadata.pluginHookContext) to that row's
 * content as labeled `<plugin-hook-context plugin="...">` blocks.
 *
 * Why here and not in the system prompt: the context belongs to one message, as in Codex, where
 * UserPromptSubmit `additionalContext` enters the conversation at that point and stays for later
 * turns. Rendering it from chat.jsonl keeps the system prompt (the cached prefix) byte-stable and
 * lets replay rebuild the request with no extra envelope field.
 *
 * The blocks go inside the row's last text part: mergeConsecutiveUserMessages keeps one text part
 * per message, so a separate part would be dropped when this row merges with a neighbour.
 * A rendered row drops the metadata field, so a second pass renders nothing: the token-budget
 * history-ID tag must stay last, so the request assembler renders before it tags.
 *
 * Request-only: persisted history and the user's bubble keep the typed text.
 */
export function renderPluginHookContextForProvider(messages: MuxMessage[]): MuxMessage[] {
  let changed = false;
  const rendered = messages.map((message) => {
    if (message.role !== "user" || message.metadata?.pluginHookContext === undefined) {
      return message;
    }
    changed = true;
    const { pluginHookContext, ...metadata } = message.metadata;
    const entries = readPersistedEntries(pluginHookContext);
    if (entries.length === 0) return { ...message, metadata };
    const blocks = entries.map(renderPluginHookContextEntry).join("\n");
    const lastText = message.parts.findLastIndex((part) => part.type === "text");
    return {
      ...message,
      metadata,
      parts:
        lastText === -1
          ? [...message.parts, { type: "text" as const, text: blocks }]
          : message.parts.map((part, index) =>
              index === lastText && part.type === "text"
                ? { ...part, text: `${part.text}\n${blocks}` }
                : part
            ),
    };
  });
  return changed ? rendered : messages;
}

/** The rendered block; promptHooks charges its full length against the per-message cap. */
export function renderPluginHookContextEntry(entry: PluginHookContextEntry): string {
  return `<plugin-hook-context plugin="${escapeMarkup(entry.pluginId)}">\n${escapeMarkup(entry.text)}\n</plugin-hook-context>`;
}

/**
 * chat.jsonl is untrusted on read: the history reader checks only that metadata is an object.
 * A malformed value or entry is dropped, so one bad row never fails every later request.
 */
function readPersistedEntries(value: unknown): PluginHookContextEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry: unknown): entry is PluginHookContextEntry =>
      typeof entry === "object" &&
      entry !== null &&
      "pluginId" in entry &&
      typeof entry.pluginId === "string" &&
      "text" in entry &&
      typeof entry.text === "string"
  );
}

/** Plugin-authored text must not be able to close the block or forge another tag. */
function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
