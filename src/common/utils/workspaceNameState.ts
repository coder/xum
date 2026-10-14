import {
  WorkspaceNamePersistedStateSchema,
  type WorkspaceNamePersistedState,
} from "@/common/orpc/schemas/drafts";
import {
  WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS,
  WORKSPACE_NAME_STATE_MESSAGE_MAX_CHARS,
} from "@/common/constants/storage";
import { truncateStringToChars } from "@/common/utils/truncateStringToChars";

/** FNV-1a (32-bit). Only detects changes past the stored prefix; not a security hash. */
function hashMessage(message: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < message.length; index++) {
    hash ^= message.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * lastGeneratedFor only detects whether the message changed, so a long message is stored as a
 * bounded fingerprint: the full creation message can be many KB, and every draft body (and the
 * snapshot every window loads) carries the name state. The fingerprint ends with the full
 * message's length and hash, so an edit past the prefix still counts as a change and regenerates
 * the name.
 */
export function toStoredMessage(message: string): string {
  if (JSON.stringify(message).length <= WORKSPACE_NAME_STATE_MESSAGE_MAX_CHARS) return message;
  // The suffix needs no JSON escapes, so the result serializes within the cap (and maps to itself).
  const suffix = `\u2026#${message.length}:${hashMessage(message)}`;
  return (
    truncateStringToChars(message, WORKSPACE_NAME_STATE_MESSAGE_MAX_CHARS - suffix.length) + suffix
  );
}

/**
 * Bound the user-input-sized fields of name state; also shrinks state that older builds stored
 * unbounded. Returns null when `state` is not name state (untrusted input: a draft file, an API
 * write, a legacy localStorage value).
 */
export function boundWorkspaceNamePersistedState(
  state: unknown
): WorkspaceNamePersistedState | null {
  const parsed = WorkspaceNamePersistedStateSchema.safeParse(state);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    manualName: truncateStringToChars(
      parsed.data.manualName,
      WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS
    ),
    lastGeneratedFor: toStoredMessage(parsed.data.lastGeneratedFor),
  };
}
