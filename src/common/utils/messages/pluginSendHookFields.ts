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
  const parsed = muxMetadata.parsed;
  if (!isRecord(parsed)) return muxMetadata;
  let strippedParsed: Record<string, unknown> | undefined;
  for (const key of FOLLOW_UP_KEYS) {
    const followUp = parsed[key];
    if (!isRecord(followUp)) continue;
    if (!("pluginSendHooksApplied" in followUp) && !("pluginHookContext" in followUp)) continue;
    const { pluginSendHooksApplied: _applied, pluginHookContext: _context, ...rest } = followUp;
    strippedParsed = { ...(strippedParsed ?? parsed), [key]: rest };
  }
  if (strippedParsed === undefined) return muxMetadata;
  // Same shape as the input minus optional fields, so it stays assignable to T.
  return { ...muxMetadata, parsed: strippedParsed } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
