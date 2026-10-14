import { useEffect, useRef } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * /side chats are ephemeral (Codex form factor): leaving one discards it, however the user
 * leaves (Esc, the Return button, the sidebar, a deep link). Watching the routed workspace keeps
 * that rule in one place instead of every navigation path. Removal is forced and touches only the
 * side chat's own row and session: its row shares the main chat's checkout (taskIsolation
 * "none"), which removal never deletes.
 */
export function useDiscardSideChatOnLeave(
  api: RouterClient<AppRouter> | null,
  currentWorkspaceId: string | null | undefined,
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata>
): void {
  // The side chat being viewed, if any. Updated whenever metadata arrives, so a side chat whose
  // metadata lands after the switch still counts.
  const viewedSideChatIdRef = useRef<string | null>(null);
  // Side chats left while disconnected: kept until a client exists to discard them.
  const pendingDiscardIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const previousSideChatId = viewedSideChatIdRef.current;
    const currentId = currentWorkspaceId ?? null;
    const currentIsSideChat =
      currentId != null && workspaceMetadata.get(currentId)?.sideChatParentWorkspaceId != null;
    viewedSideChatIdRef.current = currentIsSideChat ? currentId : null;

    const pending = pendingDiscardIdsRef.current;
    if (previousSideChatId != null && previousSideChatId !== currentId) {
      pending.add(previousSideChatId);
    }
    if (api == null) return;
    for (const sideChatId of pending) {
      // Returned to it before the discard could run: it is being viewed again.
      if (sideChatId === currentId) continue;
      pending.delete(sideChatId);
      api.workspace
        .remove({ workspaceId: sideChatId, options: { force: true } })
        .then((result) => {
          if (!result.success) {
            console.warn("Failed to discard side chat:", result.error);
          }
        })
        .catch((error: unknown) => {
          // The backend sweeps leftover side chats at startup.
          console.warn("Failed to discard side chat:", error);
        });
    }
  }, [api, currentWorkspaceId, workspaceMetadata]);
}
