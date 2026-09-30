/**
 * Durable context listing (#5248).
 *
 * Provider prompt caches read `tools`, then `system`, then `messages` as one
 * prefix. Listings that change during a workspace's life (the memory index,
 * available skills, runnable sub-agents, advertised MCP prompts) used to live
 * in tool descriptions, so every memory write or skill edit rewrote the tools
 * block and missed the cache for the whole transcript.
 *
 * The listings now travel in synthetic user rows appended to chat.jsonl at
 * turn start, one row per section, only when that section differs from its
 * latest row in the active window. Like the <system-file-update> row, the
 * request stays a pure function of the log: earlier rows never change, so a
 * memory write only costs a new memory-index row.
 */
import assert from "@/common/utils/assert";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  CONTEXT_LISTING_MESSAGE_ID_PREFIX,
  createContextListingMessageId,
} from "@/node/services/utils/messageIds";

export const CONTEXT_LISTING_TAG = "system-context-listing";

export type ContextListingSectionKey = "memory" | "skills" | "subagents" | "mcp-prompts";

export interface ContextListingSection {
  key: ContextListingSectionKey;
  title: string;
  /** Rendered section body; "" when the section has nothing to list. */
  body: string;
}

/**
 * Section bodies carry untrusted text (skill and agent descriptions from repo
 * files): keep them from closing the wrapper tag early.
 */
function neutralizeListingTag(body: string): string {
  return body.replaceAll(`</${CONTEXT_LISTING_TAG}`, `<\\/${CONTEXT_LISTING_TAG}`);
}

function renderSection(section: ContextListingSection): string {
  return (
    `<${CONTEXT_LISTING_TAG} section="${section.key}">\n` +
    `${section.title} (current; replaces any earlier "${section.key}" listing):\n` +
    `${section.body.length > 0 ? neutralizeListingTag(section.body) : "(none)"}\n` +
    `</${CONTEXT_LISTING_TAG}>`
  );
}

function sectionIdPrefix(key: ContextListingSectionKey): string {
  return `${CONTEXT_LISTING_MESSAGE_ID_PREFIX}${key}-`;
}

export function isContextListingMessage(message: MuxMessage): boolean {
  return message.role === "user" && message.id.startsWith(CONTEXT_LISTING_MESSAGE_ID_PREFIX);
}

function messageText(message: MuxMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Rows to append for this turn: one per section whose rendering differs from
 * its latest row in the active window. An empty section is skipped until it
 * has been listed once; afterwards "(none)" replaces the stale listing.
 */
export function buildContextListingMessages(
  activeMessages: MuxMessage[],
  sections: ContextListingSection[]
): MuxMessage[] {
  const rows: MuxMessage[] = [];
  for (const section of sections) {
    const prefix = sectionIdPrefix(section.key);
    const latest = activeMessages.findLast(
      (message) => isContextListingMessage(message) && message.id.startsWith(prefix)
    );
    const text = renderSection(section);
    if (latest === undefined ? section.body.length === 0 : messageText(latest) === text) {
      continue;
    }
    rows.push(
      createMuxMessage(createContextListingMessageId(section.key), "user", text, {
        timestamp: Date.now(),
        synthetic: true,
      })
    );
  }
  assert(
    rows.every((row) => isContextListingMessage(row)),
    "context listing rows must carry the listing ID prefix"
  );
  return rows;
}

/** Static tool-description sentence pointing at the listing rows. */
export function contextListingPointer(subject: string): string {
  return `${subject} are listed in the latest <${CONTEXT_LISTING_TAG}> message for this section.`;
}
