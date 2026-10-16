/**
 * Workspaces whose last LLM request the debug view (/debug-llm-request) keeps in memory. Each
 * snapshot is a full copy of the request (system message and every message) plus the response,
 * so an unbounded map grew with every workspace the server ever sent from (F12, #6754).
 */
export const DEBUG_LLM_REQUEST_MAX_WORKSPACES = 16;
