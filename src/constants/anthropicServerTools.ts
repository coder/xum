/**
 * Largest total `encryptedContent` (UTF-16 chars, summed over one server-tool result) that
 * history keeps for native replay of an Anthropic web search (#5887). Above it the result is
 * stored as the pre-#5887 client pair without ciphertext, and the thinking-replay receipt keeps
 * the thinking after it out. Why a bound: the partial holding the result is rewritten on every
 * throttled partial write for the rest of the turn, the row crosses IPC, and chat.jsonl readers
 * skip rows over 1 MiB.
 */
export const ANTHROPIC_NATIVE_SERVER_TOOL_MAX_CIPHERTEXT_CHARS = 256 * 1024;
