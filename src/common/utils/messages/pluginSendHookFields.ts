/**
 * `pluginSendHooksApplied` and `pluginHookContext` on a compaction follow-up
 * (`muxMetadata.parsed.followUpContent`) tell the redispatch that the message.send prompt hooks
 * already ran (and what context they added), so it must not run them again. Only Xum's own
 * on-send compaction may set them (built in-process, never parsed from client options). A client
 * that sent them on a manual /compact would skip the hooks or forge plugin context, so the
 * send-options schema drops them from every client request.
 *
 * Copy-on-write: the caller's object is never mutated.
 */
export function stripClientPluginSendHookFields<T>(muxMetadata: T): T {
  if (!isRecord(muxMetadata)) return muxMetadata;
  const parsed = muxMetadata.parsed;
  if (!isRecord(parsed)) return muxMetadata;
  const followUp = parsed.followUpContent;
  if (!isRecord(followUp)) return muxMetadata;
  if (!("pluginSendHooksApplied" in followUp) && !("pluginHookContext" in followUp)) {
    return muxMetadata;
  }
  const { pluginSendHooksApplied: _applied, pluginHookContext: _context, ...rest } = followUp;
  const stripped = { ...muxMetadata, parsed: { ...parsed, followUpContent: rest } };
  // Same shape as the input minus two optional fields, so it stays assignable to T.
  return stripped as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
