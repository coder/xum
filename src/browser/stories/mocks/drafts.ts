import type {
  DraftAttachment,
  DraftEvent,
  DraftScope,
  DraftUpdateInput,
} from "@/common/orpc/schemas/drafts";
import { draftScopeKey, summarizeDraft } from "@/common/utils/drafts";

interface StoredDraft {
  scope: DraftScope;
  text: string;
  attachments: DraftAttachment[];
  revision: number;
}

/**
 * In-memory drafts API for Storybook. Stories seed drafts through the legacy localStorage keys
 * (stories/helpers/drafts.ts, uiState.ts), which the DraftStore imports on hydration exactly like
 * an upgrading user's drafts.
 */
export function createMockDraftsApi() {
  const drafts = new Map<string, StoredDraft>();
  const listeners = new Set<(event: DraftEvent) => void>();
  let revision = 1;
  const emit = (event: DraftEvent) => {
    for (const listener of listeners) listener(event);
  };
  const summaries = () =>
    [...drafts.values()].map((draft) => summarizeDraft(draft.scope, draft, draft.revision));
  const write = (input: DraftUpdateInput): { revision: number } => {
    const key = draftScopeKey(input.scope);
    const current = drafts.get(key);
    const text = input.text ?? current?.text ?? "";
    const attachments = input.attachments ?? current?.attachments ?? [];
    revision++;
    if (text.length === 0 && attachments.length === 0) {
      drafts.delete(key);
      emit({ type: "deleted", scope: input.scope, revision });
    } else {
      const next = { scope: input.scope, text, attachments, revision };
      drafts.set(key, next);
      emit({ type: "changed", ...summarizeDraft(input.scope, next, revision) });
    }
    return { revision };
  };

  return {
    list: () => Promise.resolve(summaries()),
    get: (input: { scope: DraftScope }) => {
      const draft = drafts.get(draftScopeKey(input.scope));
      return Promise.resolve({
        text: draft?.text ?? "",
        attachments: draft?.attachments ?? [],
        revision: draft?.revision ?? revision,
      });
    },
    update: (input: DraftUpdateInput) => Promise.resolve(write(input)),
    delete: (input: { scope: DraftScope }) =>
      Promise.resolve(write({ scope: input.scope, text: "", attachments: [] })),
    importLegacy: (input: DraftUpdateInput) => {
      if (drafts.has(draftScopeKey(input.scope))) {
        return Promise.resolve({ result: "present" as const, revision });
      }
      return Promise.resolve({ result: "applied" as const, ...write(input) });
    },
    subscribe: async function* (_input?: void, opts?: { signal?: AbortSignal }) {
      const queue: DraftEvent[] = [{ type: "snapshot", drafts: summaries() }];
      let wake: (() => void) | null = null;
      const listener = (event: DraftEvent) => {
        queue.push(event);
        wake?.();
      };
      listeners.add(listener);
      try {
        while (!opts?.signal?.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } finally {
        listeners.delete(listener);
      }
    },
  };
}
