import type { MuxMessage } from "@/common/types/message";
import { renderPluginHookContextBlocks } from "@/common/utils/messages/pluginHookContext";

// Existing importers keep this path; the rendering itself is shared with the token estimates.
export {
  PLUGIN_HOOK_CONTEXT_MAX_CHARS,
  renderPluginHookContextEntry,
} from "@/common/utils/messages/pluginHookContext";

/**
 * Append each user row's prompt-hook context (MuxMetadata.pluginHookContext) to that row's
 * content as labeled `<plugin-hook-context plugin="...">` blocks.
 *
 * Why here and not in the system prompt: the context belongs to one message, as in Codex, where
 * UserPromptSubmit `additionalContext` enters the conversation at that point and stays for later
 * turns. Rendering it from chat.jsonl keeps the system prompt (the cached prefix) byte-stable and
 * lets replay rebuild the request with no extra envelope field.
 *
 * The blocks go inside the row's first text part: mergeConsecutiveUserMessages keeps only the
 * first text part of each message, so a separate or later part (an inlined SVG attachment) would
 * be dropped when this row merges with a neighbour.
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
    const blocks = renderPluginHookContextBlocks(message);
    const { pluginHookContext: _rendered, ...metadata } = message.metadata;
    if (blocks == null) return { ...message, metadata };
    const firstText = message.parts.findIndex((part) => part.type === "text");
    return {
      ...message,
      metadata,
      parts:
        firstText === -1
          ? [...message.parts, { type: "text" as const, text: blocks }]
          : message.parts.map((part, index) =>
              index === firstText && part.type === "text"
                ? { ...part, text: `${part.text}\n${blocks}` }
                : part
            ),
    };
  });
  return changed ? rendered : messages;
}
