/**
 * Mode-independent root system prompt (#5292): every picker-selectable agent's
 * body goes into the cached system section, and each user row carries a
 * `[mode: <agent>]` tag, so an agent switch appends a tag instead of
 * rewriting the cached prefix.
 */

/**
 * Upper bound on the rendered `<agent-instructions>` section of the
 * mode-independent prompt (rule, every agent's block with its body, plan text,
 * scoped sections and tool guidance), in UTF-16 code units. Above it the
 * request falls back to the active-only prompt (one cache miss per switch, as
 * before #5292): agent bodies can each be up to 1 MB, their number is
 * unbounded, and compaction cannot reclaim system tokens. About 8k tokens.
 */
export const AGENT_MODE_INSTRUCTIONS_MAX_CHARS = 32_000;

/**
 * Provider-metadata marker on the Xum-written mode-tag text part of a user
 * row. Consecutive-user-message merging keeps the marked part last, so the
 * tag stays after every attachment and document of the merged message.
 * Providers read only their own namespace and ignore this one.
 */
export const AGENT_MODE_TAG_PROVIDER_METADATA = { xum: { agentModeTag: true } };
