import type { WorkspaceChatMessage } from "@/common/orpc/types";

/**
 * The latest auto-retry banner event of a workspace. Shared by WorkspaceStore and the VS Code
 * webview, which tracks it from its own chat subscription (it does not feed WorkspaceStore).
 */
export type AutoRetryStatus = Extract<
  WorkspaceChatMessage,
  | { type: "auto-retry-scheduled" }
  | { type: "auto-retry-starting" }
  | { type: "auto-retry-abandoned" }
>;

export function isAutoRetryStatusEvent(msg: WorkspaceChatMessage): msg is AutoRetryStatus {
  const type = (msg as { type?: string }).type;
  return (
    type === "auto-retry-scheduled" ||
    type === "auto-retry-starting" ||
    type === "auto-retry-abandoned"
  );
}
