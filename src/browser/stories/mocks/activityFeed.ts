import { wrapAsyncIterator } from "@orpc/shared";
import type { WorkspaceActivitySnapshot } from "@/common/orpc/types";
import type { createMockORPCClient } from "./orpc";

type ActivitySubscribe = ReturnType<
  typeof createMockORPCClient
>["workspace"]["activity"]["subscribe"];
interface ActivityEvent {
  type: "activity";
  workspaceId: string;
  activity: WorkspaceActivitySnapshot | null;
}

// Background activity snapshots (the always-on per-workspace subscription) queue through
// `emit` and stay deliverable until the store aborts; client swaps between stories must
// release the previous subscription, so the iterator also ends on abort.
export function createActivityFeed(): {
  subscribe: ActivitySubscribe;
  emit: (workspaceId: string, activity: WorkspaceActivitySnapshot) => void;
} {
  const queued: ActivityEvent[] = [];
  let wake: (() => void) | null = null;
  const subscribe: ActivitySubscribe = (_input, options) => {
    async function* iterate() {
      while (!options?.signal?.aborted) {
        const next = queued.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    }
    return Promise.resolve(wrapAsyncIterator(iterate(), {}));
  };
  return {
    subscribe,
    emit: (workspaceId, activity) => {
      queued.push({ type: "activity", workspaceId, activity });
      wake?.();
    },
  };
}
