/**
 * `pluginSendHooksApplied` on a compaction follow-up (`muxMetadata.parsed.followUpContent`) tells
 * the redispatch that the message.send prompt hooks already ran, so it must not run them again.
 * Only Xum's own on-send compaction may set it (built in-process, never parsed from client
 * options). A client that sent it on a manual /compact would skip the hooks for its follow-up, so
 * the send-options schema drops it from every client request.
 *
 * Copy-on-write: the caller's object is never mutated.
 */
export function stripClientPluginSendHookFields<T>(muxMetadata: T): T {
  if (!isRecord(muxMetadata)) return muxMetadata;
  const parsed = muxMetadata.parsed;
  if (!isRecord(parsed)) return muxMetadata;
  const followUp = parsed.followUpContent;
  if (!isRecord(followUp) || !("pluginSendHooksApplied" in followUp)) return muxMetadata;
  const { pluginSendHooksApplied: _applied, ...rest } = followUp;
  const stripped = { ...muxMetadata, parsed: { ...parsed, followUpContent: rest } };
  // Same shape as the input minus one optional field, so it stays assignable to T.
  return stripped as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
