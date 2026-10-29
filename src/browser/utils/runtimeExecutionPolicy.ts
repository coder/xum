import type { RuntimeStatus, RuntimeStatusStore } from "@/browser/stores/RuntimeStatusStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isDevcontainerRuntime } from "@/common/types/runtime";

/**
 * Whether passive/background runtime-backed work can run without waking the runtime.
 * Explicit user actions can apply a different policy when they intentionally start work.
 */
export function canRunPassiveRuntimeCommand(
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"],
  runtimeStatus: RuntimeStatus | null
): boolean {
  if (!isDevcontainerRuntime(runtimeConfig)) {
    return true;
  }

  return runtimeStatus === "running";
}

const noopUnsubscribe = () => undefined;

export type PassiveRuntimeDeps = Pick<RuntimeStatusStore, "getStatus" | "subscribeKey">;

/**
 * Arms a one-shot listener that fires `onEligible()` when a devcontainer workspace's
 * runtime transitions from not-passively-runnable to `running`.
 *
 * For non-devcontainer workspaces this is a no-op (returns a no-op unsubscriber)
 * because they are always passively eligible.
 *
 * Returns an unsubscribe function. The listener auto-unsubscribes after firing once.
 */
export function onPassiveRuntimeEligible(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"],
  runtimeStatusStore: PassiveRuntimeDeps,
  onEligible: () => void
): () => void {
  // Non-devcontainer workspaces are always eligible; no watcher needed.
  if (!isDevcontainerRuntime(runtimeConfig)) {
    return noopUnsubscribe;
  }

  // If already eligible right now, fire immediately (shouldn't normally happen
  // since callers arm this after canRunPassiveRuntimeCommand returned false).
  if (runtimeStatusStore.getStatus(workspaceId) === "running") {
    onEligible();
    return noopUnsubscribe;
  }

  let fired = false;
  const unsubscribe = runtimeStatusStore.subscribeKey(workspaceId, () => {
    if (fired) {
      return;
    }

    const status = runtimeStatusStore.getStatus(workspaceId);
    if (status === "running") {
      fired = true;
      unsubscribe();
      onEligible();
    }
  });

  // Return a cleanup function that prevents the callback from firing
  // and removes the subscription.
  return () => {
    fired = true;
    unsubscribe();
  };
}
