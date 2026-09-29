import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DraftStore } from "@/browser/stores/DraftStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftEvent, DraftScope } from "@/common/orpc/schemas/drafts";
import { installDom } from "../../../../tests/ui/dom";
import { isRestoredDraftDurable } from "./restoredDraftDurability";

let cleanupDom: (() => void) | undefined;

const WORKSPACE_ID = "ws-durable";
const scope: DraftScope = { kind: "workspace", workspaceId: WORKSPACE_ID };

/** A drafts backend whose update replies the test releases (or fails) explicitly. */
function createGatedBackend() {
  const replies: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let revision = 1;
  const drafts = {
    subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
      Promise.resolve(
        (async function* (): AsyncGenerator<DraftEvent> {
          yield { type: "snapshot", drafts: [], list: { entries: [], revision: 0 } };
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        })()
      ),
    update: () =>
      new Promise<{ revision: number }>((resolve, reject) => {
        replies.push({ resolve: () => resolve({ revision: ++revision }), reject });
      }),
  };
  return { client: createTestApiClient({ drafts }), replies };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("isRestoredDraftDurable", () => {
  let store: DraftStore;
  let backend: ReturnType<typeof createGatedBackend>;

  beforeEach(async () => {
    cleanupDom = installDom();
    backend = createGatedBackend();
    store = new DraftStore();
    store.setClient(backend.client);
    await store.whenReady();
    // The restore the composer just applied.
    store.setText(scope, "restored\n\ndraft");
    store.setAttachments(scope, [
      {
        kind: "provider",
        id: "restored-1",
        url: "data:image/png;base64,AAA",
        mediaType: "image/png",
      },
    ]);
  });
  afterEach(() => {
    store.setClient(null);
    cleanupDom?.();
  });

  const check = (overrides: Partial<Parameters<typeof isRestoredDraftDurable>[0]> = {}) =>
    isRestoredDraftDurable({
      draftStore: store,
      draftScope: scope,
      restoredAttachmentIds: ["restored-1"],
      restoredReviewIds: ["review-1"],
      ...overrides,
    });

  test("resolves durable only after the backend confirmed the draft write", async () => {
    let settled: boolean | undefined;
    const pending = check().then((durable) => (settled = durable));
    await settleMicrotasks();
    expect(backend.replies).toHaveLength(1);
    expect(settled).toBeUndefined();

    backend.replies[0].resolve();
    await pending;
    expect(settled).toBe(true);
  });

  test("a failed draft write keeps the input held", async () => {
    const pending = check();
    await settleMicrotasks();
    backend.replies[0].reject(new Error("write failed"));
    expect(await pending).toBe(false);
  });

  test("restored notes went to the memory-only override", async () => {
    expect(await check({ restoredReviewIds: null })).toBe(false);
  });
});
