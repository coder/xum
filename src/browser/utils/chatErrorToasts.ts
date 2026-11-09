import { useEffect, useRef } from "react";

/**
 * Error toasts addressed to a workspace's chat input (a child exhausting the parent's goal budget,
 * a Stop the backend could not record). Retained until that input has shown and dismissed them: the
 * error can land after the user switched workspaces (a Stop settles asynchronously), when no input
 * for that workspace is mounted, and the input renders a single toast at a time. Info notices
 * (publishChatInfo) share this queue.
 */
interface PendingChatToast {
  type: "error" | "info";
  message: string;
}
const pendingByWorkspace = new Map<string, PendingChatToast[]>();
const listenersByWorkspace = new Map<string, Set<() => void>>();

export function publishChatError(workspaceId: string, message: string): void {
  publish(workspaceId, (pending) => [...pending, { type: "error", message }]);
}

/**
 * A routine notice (a plugin's Stop continuation), shown as a non-error toast. It replaces any info
 * notice still waiting, so a loop of 50 continuations leaves one notice to show, not 50.
 */
export function publishChatInfo(workspaceId: string, message: string): void {
  publish(workspaceId, (pending) => [
    ...pending.filter((toast) => toast.type !== "info"),
    { type: "info", message },
  ]);
}

function publish(
  workspaceId: string,
  update: (pending: PendingChatToast[]) => PendingChatToast[]
): void {
  pendingByWorkspace.set(workspaceId, update(pendingByWorkspace.get(workspaceId) ?? []));
  for (const listener of listenersByWorkspace.get(workspaceId) ?? []) {
    listener();
  }
}

function peekChatToast(workspaceId: string): PendingChatToast | undefined {
  return pendingByWorkspace.get(workspaceId)?.[0];
}

export function peekChatError(workspaceId: string): string | undefined {
  return peekChatToast(workspaceId)?.message;
}

export function dismissChatError(workspaceId: string, message: string): void {
  const pending = pendingByWorkspace.get(workspaceId);
  const index = pending?.findIndex((toast) => toast.message === message) ?? -1;
  if (pending == null || index < 0) return;
  pending.splice(index, 1);
  if (pending.length === 0) pendingByWorkspace.delete(workspaceId);
}

/**
 * Shows the workspace's retained and later chat errors through `pushToast`, one per toast:
 * `visibleToastMessage` is the input's current toast and the next error is pushed once it is gone.
 * An error leaves the queue only after its toast was rendered and dismissed, so a push that never
 * rendered (React batched another toast over it, or StrictMode replayed the effect) or that another
 * toast replaced is pushed again.
 */
export function useChatErrorToasts(
  workspaceId: string | null,
  visibleToastMessage: string | null,
  pushToast: (toast: PendingChatToast) => void
): void {
  const pushedRef = useRef<{ message: string; displayed: boolean } | null>(null);
  useEffect(() => {
    if (workspaceId == null) return;
    const pushed = pushedRef.current;
    if (visibleToastMessage != null) {
      // Dismissal is inferred from the slot clearing, so only a toast still showing this error
      // counts; one that replaced it (a later success toast) means the error must show again.
      if (pushed != null) pushed.displayed = pushed.message === visibleToastMessage;
      return;
    }
    if (pushed?.displayed) dismissChatError(workspaceId, pushed.message);
    pushedRef.current = null;
    const showNext = () => {
      if (pushedRef.current != null) return;
      const next = peekChatToast(workspaceId);
      if (next == null) return;
      pushedRef.current = { message: next.message, displayed: false };
      pushToast(next);
    };
    const listeners = listenersByWorkspace.get(workspaceId) ?? new Set<() => void>();
    listenersByWorkspace.set(workspaceId, listeners);
    listeners.add(showNext);
    showNext();
    return () => {
      listeners.delete(showNext);
      if (listeners.size === 0) {
        listenersByWorkspace.delete(workspaceId);
      }
    };
  }, [workspaceId, visibleToastMessage, pushToast]);
}
