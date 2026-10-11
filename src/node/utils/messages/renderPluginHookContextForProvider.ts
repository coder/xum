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
 * Request-only: persisted history and the user's bubble keep the typed text.
 */
export function renderPluginHookContextForProvider(messages: MuxMessage[]): MuxMessage[] {
  let changed = false;
  const rendered = messages.map((message) => {
    const entries = message.role === "user" ? message.metadata?.pluginHookContext : undefined;
    if (entries == null || entries.length === 0) return message;
    changed = true;
    return {
      ...message,
      parts: [
        ...message.parts,
        ...entries.map((entry) => ({ type: "text" as const, text: renderEntry(entry) })),
      ],
    };
  });
  return changed ? rendered : messages;
}

function renderEntry(entry: PluginHookContextEntry): string {
  return `<plugin-hook-context plugin="${escapeMarkup(entry.pluginId)}">\n${escapeMarkup(entry.text)}\n</plugin-hook-context>`;
}

/** Plugin-authored text must not be able to close the block or forge another tag. */
function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
