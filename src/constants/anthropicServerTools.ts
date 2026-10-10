/**
 * Largest total `encryptedContent` (UTF-16 chars) that one assistant row keeps for native replay
 * of Anthropic web searches (#5887), summed over every search in the row. A search that would
 * exceed it is stored as the pre-#5887 client pair without ciphertext, and the thinking-replay
 * receipt keeps the thinking after it out. Why a bound: the partial holding the row is rewritten
 * on every throttled partial write for the rest of the turn, the row crosses IPC, and chat.jsonl
 * readers skip rows over 1 MiB. One turn can run many searches, so the bound is per row, not per
 * call.
 */
export const ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS = 256 * 1024;
