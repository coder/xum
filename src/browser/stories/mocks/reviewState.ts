import type {
  ReviewStateDelta,
  ReviewStateEvent,
  ReviewStateImportLegacyOutput,
  ReviewStateSections,
  ReviewStateSnapshot,
  ReviewStateUpdateOutput,
} from "@/common/orpc/schemas/reviewState";
import { REVIEW_STATE_SECTIONS } from "@/common/orpc/schemas/reviewState";
import { applyReviewStateDelta, withReviewStateSection } from "@/common/utils/reviewState";

/**
 * Seeds consumed by the next mock client, so story setup can stage review state before
 * creating the client (mirrors writing `<sessionDir>/review-state.json` on a real backend).
 */
const pendingSeeds = new Map<string, ReviewStateSections>();

export function seedMockReviewState(workspaceId: string, sections: ReviewStateSections): void {
  pendingSeeds.set(workspaceId, { ...pendingSeeds.get(workspaceId), ...sections });
}

/** In-memory `workspace.reviewState` API sharing the backend's merge helper. */
export function createMockReviewStateApi() {
  const states = new Map(pendingSeeds);
  pendingSeeds.clear();
  const listeners = new Map<string, Set<() => void>>();
  // Like the backend's in-memory revision: bumped on every committed change.
  let revision = 0;

  const snapshotOf = (workspaceId: string): ReviewStateSnapshot => ({
    sections: states.get(workspaceId) ?? {},
  });
  const commit = (workspaceId: string, sections: ReviewStateSections): ReviewStateSnapshot => {
    states.set(workspaceId, sections);
    revision++;
    for (const listener of listeners.get(workspaceId) ?? []) listener();
    return { sections };
  };

  return {
    subscribe: async function* (
      input: { workspaceId: string },
      opts?: { signal?: AbortSignal }
    ): AsyncGenerator<ReviewStateEvent> {
      let changed = false;
      let wake: (() => void) | null = null;
      const listener = () => {
        changed = true;
        wake?.();
      };
      const set = listeners.get(input.workspaceId) ?? new Set();
      listeners.set(input.workspaceId, set);
      set.add(listener);
      try {
        yield { type: "snapshot", snapshot: snapshotOf(input.workspaceId), revision };
        while (!opts?.signal?.aborted) {
          if (!changed) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            wake = null;
          }
          if (opts?.signal?.aborted) break;
          changed = false;
          yield { type: "snapshot", snapshot: snapshotOf(input.workspaceId), revision };
        }
      } finally {
        set.delete(listener);
      }
    },
    update: (input: {
      workspaceId: string;
      delta: ReviewStateDelta;
    }): Promise<ReviewStateUpdateOutput> => {
      const snapshot = commit(
        input.workspaceId,
        applyReviewStateDelta(snapshotOf(input.workspaceId).sections, input.delta)
      );
      return Promise.resolve({ ...snapshot, revision });
    },
    importLegacy: (input: {
      workspaceId: string;
      sections: ReviewStateSections;
    }): Promise<ReviewStateImportLegacyOutput> => {
      const current = snapshotOf(input.workspaceId).sections;
      const results: ReviewStateImportLegacyOutput["results"] = {};
      let next = current;
      for (const section of REVIEW_STATE_SECTIONS) {
        const incoming = input.sections[section];
        if (incoming === undefined) continue;
        if (current[section] !== undefined) {
          results[section] = "present";
          continue;
        }
        next = withReviewStateSection(next, section, incoming);
        results[section] = "applied";
      }
      const snapshot = next === current ? { sections: current } : commit(input.workspaceId, next);
      return Promise.resolve({ snapshot, revision, results });
    },
  };
}
