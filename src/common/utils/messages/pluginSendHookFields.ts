/**
 * `pluginSendHooksApplied` and `pluginHookContext` on a compaction follow-up tell the redispatch
 * that the message.send prompt hooks already ran (and what context they added), so it must not
 * run them again. Only Xum's own on-send compaction may set them (built in-process, never parsed
 * from client options). A client that sent them on a manual /compact would skip the hooks or
 * forge plugin context, so the send-options schema drops them from every client request.
 *
 * Both follow-up keys are sanitized: `followUpContent`, and the legacy `continueMessage` that
 * getCompactionFollowUpContent still falls back to.
 *
 * Copy-on-write: the caller's object is never mutated.
 */
const FOLLOW_UP_KEYS = ["followUpContent", "continueMessage"] as const;

export function stripClientPluginSendHookFields<T>(muxMetadata: T): T {
  if (!isRecord(muxMetadata)) return muxMetadata;
  // A compaction summary's pending follow-up (workspace.replaceChatHistory rows): recovery
  // dispatches it after a restart and trusts the same markers (Codex PRRT_kwDOPxxmWM6rZbml).
  const pending = stripFollowUp(muxMetadata.pendingFollowUp);
  const parsed = muxMetadata.parsed;
  let strippedParsed: Record<string, unknown> | undefined;
  if (isRecord(parsed)) {
    for (const key of FOLLOW_UP_KEYS) {
      const followUp = stripFollowUp(parsed[key]);
      if (followUp !== undefined)
        strippedParsed = { ...(strippedParsed ?? parsed), [key]: followUp };
    }
  }
  if (strippedParsed === undefined && pending === undefined) return muxMetadata;
  const stripped = {
    ...muxMetadata,
    ...(strippedParsed !== undefined ? { parsed: strippedParsed } : {}),
    ...(pending !== undefined ? { pendingFollowUp: pending } : {}),
  };
  // Same shape as the input minus optional fields, so it stays assignable to T.
  return stripped as T;
}

/** The follow-up without the hook markers, or undefined when it has none to strip. */
function stripFollowUp(followUp: unknown): Record<string, unknown> | undefined {
  if (!isRecord(followUp)) return undefined;
  if (!("pluginSendHooksApplied" in followUp) && !("pluginHookContext" in followUp))
    return undefined;
  const { pluginSendHooksApplied: _applied, pluginHookContext: _context, ...rest } = followUp;
  return rest;
}

/** Refusal for {@link isNestedCompactionFollowUp} sends. */
export const NESTED_COMPACTION_FOLLOW_UP_MESSAGE =
  "A /compact follow-up cannot itself be a compaction request. Send the second /compact after the first one finishes.";

/**
 * True for a compaction request whose follow-up is itself a compaction request. No Xum path
 * builds this (a follow-up's muxMetadata is agent-skill, MCP-prompt, heartbeat or workspace-turn
 * metadata, and on-send compaction never diverts a compaction request), so WorkspaceService
 * refuses it from clients: the nested request's own follow-up would redispatch as an automatic
 * send that no message.send hook may block, and the strip above covers only one level.
 */
export function isNestedCompactionFollowUp(muxMetadata: unknown): boolean {
  if (!isRecord(muxMetadata) || muxMetadata.type !== "compaction-request") return false;
  const parsed = muxMetadata.parsed;
  if (!isRecord(parsed)) return false;
  return FOLLOW_UP_KEYS.some((key) => {
    const followUp = parsed[key];
    return (
      isRecord(followUp) &&
      isRecord(followUp.muxMetadata) &&
      followUp.muxMetadata.type === "compaction-request"
    );
  });
}

/**
 * True for a compaction summary (workspace.replaceChatHistory rows) whose pending follow-up is
 * itself a compaction request: the shape {@link isNestedCompactionFollowUp} refuses on send.
 * Recovery dispatches the pending follow-up through AgentSession directly, so this boundary
 * refuses it too: the strip above covers only the outer follow-up, and the nested request's own
 * follow-up would keep forged hook markers (Codex PRRT_kwDOPxxmWM6rxIVB).
 */
export function isNestedCompactionPendingFollowUp(muxMetadata: unknown): boolean {
  if (!isRecord(muxMetadata)) return false;
  const pending = muxMetadata.pendingFollowUp;
  return (
    isRecord(pending) &&
    isRecord(pending.muxMetadata) &&
    pending.muxMetadata.type === "compaction-request"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
