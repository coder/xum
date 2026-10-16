import type {
  CreationDraft,
  CreationDraftImportLegacyInput,
  CreationDraftScope,
  CreationDraftUpdateInput,
  DraftAttachment,
  DraftBeginSendInput,
  DraftEvent,
  DraftScope,
  DraftUpdateInput,
  DraftWriteOutput,
} from "@/common/orpc/schemas/drafts";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { WORKSPACE_DRAFTS_BY_PROJECT_KEY } from "@/common/constants/storage";
import { removeSentText, takeSentText } from "@/common/utils/composerDraftText";
import {
  draftScopeKey,
  summarizeCreationDraft,
  summarizeDraft,
  toDraftAttachmentMetadata,
} from "@/common/utils/drafts";

interface StoredDraft {
  scope: DraftScope;
  text: string;
  attachments: DraftAttachment[];
  revision: number;
}

/**
 * One revision sequence for the whole page, as a real backend never answers below its earlier
 * revisions (DraftService seeds them from its start time; stories freeze Date.now, so that does
 * not work here). The DraftStore is one per page and outlives each story's mock client: with a
 * sequence per client, a story that reused a workspace ID got write replies older than the
 * previous story's last view, and the store applied that old (empty) view over the text being
 * typed (#6389).
 */
let revision = 1;

/**
 * In-memory drafts API for Storybook. Stories seed drafts through the legacy localStorage keys
 * (stories/helpers/drafts.ts, uiState.ts), which the DraftStore imports on hydration exactly like
 * an upgrading user's drafts.
 */
export function createMockDraftsApi() {
  const drafts = new Map<string, StoredDraft>();
  const listeners = new Set<(event: DraftEvent) => void>();
  const creationDrafts = new Map<string, CreationDraft>();
  const putCreation = (id: string, patch: Partial<CreationDraft>): CreationDraft => {
    const next: CreationDraft = {
      id,
      projectPath: "",
      subProjectPath: null,
      createdAt: 0,
      text: "",
      attachments: [],
      manualName: "",
      ai: {},
      intent: {},
      auto: {},
      execution: null,
      ...creationDrafts.get(id),
      ...patch,
    };
    creationDrafts.set(id, next);
    return next;
  };
  // Stories list creation drafts through the legacy list key (stories/helpers/drafts.ts).
  let seeded = false;
  const seedListedCreationDrafts = () => {
    if (seeded) return;
    seeded = true;
    const listed = readPersistedState<
      Record<string, Array<{ draftId: string; subProjectPath?: string | null; createdAt?: number }>>
    >(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {});
    for (const [projectPath, entries] of Object.entries(listed)) {
      for (const entry of entries) {
        putCreation(entry.draftId, {
          projectPath,
          subProjectPath: entry.subProjectPath ?? null,
          createdAt: entry.createdAt ?? 0,
        });
      }
    }
  };
  const emit = (event: DraftEvent) => {
    for (const listener of listeners) listener(event);
  };
  const summaries = () =>
    [...drafts.values()].map((draft) => summarizeDraft(draft.scope, draft, draft.revision));
  const write = (input: DraftUpdateInput): DraftWriteOutput => {
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
    // A write's reply carries the stored view (nothing is retained in stories).
    return { revision, text, attachments: attachments.map(toDraftAttachmentMetadata) };
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
    // Idempotent sends: story sends are accepted at once, so nothing is retained.
    beginSend: (input: DraftBeginSendInput) => {
      const current = drafts.get(draftScopeKey(input.scope));
      const visible = input.text ?? current?.text ?? "";
      const taken = new Set(input.pendingSend.attachmentIds);
      return Promise.resolve(
        write({
          scope: input.scope,
          text:
            input.localTake && (input.localTake.from ?? input.text) === visible
              ? takeSentText(visible, input.pendingSend.text, input.localTake.kind)
              : removeSentText(visible, input.pendingSend.text),
          attachments: (current?.attachments ?? []).filter(({ id }) => !taken.has(id)),
        })
      );
    },
    setSendReceiver: () => Promise.resolve({ revision, present: false }),
    resolveSends: () => Promise.resolve({ statuses: [] }),
    delete: (input: { scope: DraftScope }) =>
      Promise.resolve(write({ scope: input.scope, text: "", attachments: [] })),
    listCreation: () => {
      seedListedCreationDrafts();
      return Promise.resolve({
        drafts: [...creationDrafts.values()].map(summarizeCreationDraft),
      });
    },
    getCreation: (input: { scope: CreationDraftScope }) =>
      Promise.resolve(creationDrafts.get(input.scope.draftId) ?? null),
    updateCreation: ({ scope, ...patch }: CreationDraftUpdateInput) =>
      Promise.resolve(summarizeCreationDraft(putCreation(scope.draftId, patch))),
    deleteCreation: (input: { scope: CreationDraftScope }) => {
      creationDrafts.delete(input.scope.draftId);
      return Promise.resolve();
    },
    // Stories seed creation drafts through the legacy localStorage keys (stories/helpers).
    importLegacyCreation: (input: CreationDraftImportLegacyInput) => {
      putCreation(input.legacyDraftId, {
        projectPath: input.projectPath,
        text: input.text ?? "",
        attachments: (input.attachments ?? []).filter((a) => a.kind !== "staged"),
        manualName: input.manualName ?? "",
      });
      return Promise.resolve();
    },
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
