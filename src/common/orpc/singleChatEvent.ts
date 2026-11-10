import assert from "@/common/utils/assert";
import type { OnChatEvent, WorkspaceChatMessage } from "@/common/orpc/types";

/**
 * onChat's output type includes `message-batch` (#5102), but the server sends batches only to
 * subscribers that pass `batchReplay: true` (the renderer's WorkspaceStore). Clients that do not
 * ask for batches narrow each event with this. A batch here means the server broke that contract.
 */
export function singleChatEvent(event: OnChatEvent): WorkspaceChatMessage {
  assert(
    event.type !== "message-batch",
    "onChat sent a message-batch to a subscriber that did not pass batchReplay"
  );
  return event;
}
