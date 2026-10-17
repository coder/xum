/**
 * Workspaces whose last LLM request the debug view (/debug-llm-request) keeps in memory. Each
 * snapshot is a full copy of the request (system message and every message) plus the response,
 * so an unbounded map grew with every workspace the server ever sent from (F12, #6754).
 */
export const DEBUG_LLM_REQUEST_MAX_WORKSPACES = 16;

/**
 * Byte limit across those snapshots, estimated as each snapshot's JSON length. Sixteen
 * workspaces near a full context window would otherwise still hold tens of MB. A single
 * snapshot over this limit is not kept.
 */
export const DEBUG_LLM_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
