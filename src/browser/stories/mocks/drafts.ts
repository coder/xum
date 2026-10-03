import type {
  DraftAttachment,
  DraftBeginSendInput,
  DraftEvent,
  DraftListEntry,
  DraftScope,
  DraftUpdateInput,
  DraftWriteOutput,
} from "@/common/orpc/schemas/drafts";
import { removeSentText } from "@/common/utils/composerDraftText";
import { draftScopeKey, summarizeDraft, toDraftAttachmentMetadata } from "@/common/utils/drafts";

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
  let listEntries: DraftListEntry[] = [];
  const isSame = (a: DraftListEntry, b: DraftListEntry) =>
    a.projectPath === b.projectPath && a.draftId === b.draftId;
  const setList = (next: DraftListEntry[]): { revision: number } => {
    listEntries = next;
    revision++;
    emit({ type: "list", entries: listEntries, revision });
    return { revision };
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
      const taken = new Set(input.pendingSend.attachmentIds);
      return Promise.resolve(
        write({
          scope: input.scope,
          text: removeSentText(input.text ?? current?.text ?? "", input.pendingSend.text),
          attachments: (current?.attachments ?? []).filter(({ id }) => !taken.has(id)),
        })
      );
    },
    setSendReceiver: () => Promise.resolve({ revision, present: false }),
    resolveSends: () => Promise.resolve({ statuses: [] }),
    delete: (input: { scope: DraftScope }) => {
      const result = write({ scope: input.scope, text: "", attachments: [] });
      const { scope } = input;
      if (scope.kind === "creation") {
        setList(
          listEntries.filter(
            (entry) => !isSame(entry, { ...scope, subProjectPath: null, createdAt: 0 })
          )
        );
      }
      return Promise.resolve(result);
    },
    getList: () => Promise.resolve({ entries: listEntries, revision }),
    putListEntry: (entry: DraftListEntry) => {
      const existing = listEntries.find((listed) => isSame(listed, entry));
      return Promise.resolve(
        setList(
          existing
            ? listEntries.map((listed) =>
                listed === existing ? { ...listed, subProjectPath: entry.subProjectPath } : listed
              )
            : [...listEntries, entry]
        )
      );
    },
    importLegacyList: (input: { entries: DraftListEntry[] }) =>
      Promise.resolve(
        setList([
          ...listEntries,
          ...input.entries.filter((entry) => !listEntries.some((listed) => isSame(listed, entry))),
        ])
      ),
    importLegacy: (input: DraftUpdateInput) => {
      if (drafts.has(draftScopeKey(input.scope))) {
        return Promise.resolve({ result: "present" as const, revision });
      }
      return Promise.resolve({ result: "applied" as const, ...write(input) });
    },
    subscribe: async function* (_input?: void, opts?: { signal?: AbortSignal }) {
      const queue: DraftEvent[] = [
        { type: "snapshot", drafts: summaries(), list: { entries: listEntries, revision } },
      ];
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
