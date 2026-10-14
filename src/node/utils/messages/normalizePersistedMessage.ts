import { boundToolPayloadDepth } from "@/common/utils/tools/toolPayloadDepth";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";

/**
 * Every persisted row (chat.jsonl, archive, partial.json) read into memory
 * passes through here: legacy metadata migration plus the tool-payload depth
 * bound. Returns the same reference when nothing changed so rewrite paths can
 * keep untouched rows byte-for-byte.
 */
export function normalizePersistedMessage<Row extends { metadata?: object; parts?: unknown }>(
  row: Row
): Row {
  return boundToolPayloadDepth(normalizeLegacyMuxMetadata(row));
}
