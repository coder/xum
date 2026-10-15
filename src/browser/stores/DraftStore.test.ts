import * as fs from "fs/promises";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import {
  listPersistedKeys,
  readPersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getAutoExpandPrefsKey,
  getPendingScopeId,
  getWorkspaceNameStateKey,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import type {
  DraftAttachment,
  DraftEvent,
  DraftScope,
  WorkspaceNamePersistedState,
} from "@/common/orpc/schemas/drafts";
import {
  DEFAULT_CREATION_DRAFT_ID,
  DRAFT_STORE_READY_TIMEOUT_MS,
  MAX_DRAFT_JSON_BYTES,
} from "@/constants/drafts";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { DraftService } from "@/node/services/draftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { restartLocalStorage } from "../../../tests/ui/quotaLimitedStorage";
import { DraftStore } from "./DraftStore";

// Older builds wrote these legacy keys; the key registry refuses them now, so seed them the way
// an older build left them on disk.
function seedLegacyKey(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

const WS = "draft-store-ws";
const WS_SCOPE: DraftScope = { kind: "workspace", workspaceId: WS };

const NAME_STATE: WorkspaceNamePersistedState = {
  generatedIdentity: { name: "fix-a1b2", title: "Fix the sidebar" },
  manualName: "",
  autoGenerate: true,
  lastGeneratedFor: "fix the sidebar",
};

const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

/**
 * The store talks to a real DraftService (real files) through a pass-through client. The only
 * test hooks are failure injection and a gate on update replies; storage behavior is the service's.
 */
function createClient(service: DraftService) {
  const control = {
    failUpdates: 0,
    failImports: 0,
    failDeletes: 0,
    failGets: 0,
    failListPuts: 0,
    failListImports: 0,
    /** Consumed one per putListEntry call, in call order. */
    listPutGates: [] as Array<Promise<void>>,
    updateGate: null as Promise<void> | null,
    /** Held after the backend wrote (and pushed) the update, before the reply arrives. */
    updateReplyGate: null as Promise<void> | null,
    getGate: null as Promise<void> | null,
    subscribeGate: null as Promise<void> | null,
    /** Holds change events (not the snapshot) before the store sees them. */
    eventGate: null as Promise<void> | null,
    updates: 0,
    listPuts: 0,
    failMoves: 0,
    /** Moves whose reply is lost after the backend ran them. */
    loseMoveReplies: 0,
    /** Held before the backend runs a move. */
    moveGate: null as Promise<void> | null,
    importedScopes: [] as DraftScope[],
  };
  const drafts = {
    list: () => service.list(),
    get: async ({ scope }: { scope: DraftScope }) => {
      await control.getGate;
      if (control.failGets > 0) {
        control.failGets--;
        throw new Error("get failed");
      }
      return service.get(scope);
    },
    update: async (input: Parameters<DraftService["update"]>[0]) => {
      control.updates++;
      await control.updateGate;
      if (control.failUpdates > 0) {
        control.failUpdates--;
        throw new Error("update failed");
      }
      const reply = await service.update(input);
      await control.updateReplyGate;
      return reply;
    },
    delete: async ({ scope }: { scope: DraftScope }) => {
      if (control.failDeletes > 0) {
        control.failDeletes--;
        throw new Error("delete failed");
      }
      return service.delete(scope);
    },
    importLegacy: async (input: Parameters<DraftService["importLegacy"]>[0]) => {
      control.importedScopes.push(input.scope);
      if (control.failImports > 0) {
        control.failImports--;
        throw new Error("import failed");
      }
      return service.importLegacy(input);
    },
    moveCreation: async (input: Parameters<DraftService["moveCreation"]>[0]) => {
      await control.moveGate;
      if (control.failMoves > 0) {
        control.failMoves--;
        throw new Error("move failed");
      }
      const reply = await service.moveCreation(input);
      if (control.loseMoveReplies > 0) {
        control.loseMoveReplies--;
        throw new Error("move reply lost");
      }
      return reply;
    },
    putListEntry: async (entry: Parameters<DraftService["putListEntry"]>[0]) => {
      control.listPuts++;
      await control.listPutGates.shift();
      if (control.failListPuts > 0) {
        control.failListPuts--;
        throw new Error("list put failed");
      }
      return service.putListEntry(entry);
    },
    importLegacyList: async ({
      entries,
    }: {
      entries: Parameters<DraftService["importLegacyList"]>[0];
    }) => {
      if (control.failListImports > 0) {
        control.failListImports--;
        throw new Error("list import failed");
      }
      return service.importLegacyList(entries);
    },
    subscribe: async (_input: void, opts?: { signal?: AbortSignal }) => {
      await control.subscribeGate;
      const queue: DraftEvent[] = [];
      let wake: (() => void) | null = null;
      const listener = (event: DraftEvent) => {
        queue.push(event);
        wake?.();
      };
      service.on(DraftService.CHANGE_EVENT, listener);
      queue.unshift(await service.getSnapshotEvent());
      return (async function* () {
        try {
          while (!opts?.signal?.aborted) {
            const next = queue.shift();
            if (next) {
              if (next.type !== "snapshot") await control.eventGate;
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          service.off(DraftService.CHANGE_EVENT, listener);
        }
      })();
    },
  };
  return { client: createTestApiClient({ drafts }), control };
}

async function createHarness(tempDir: TestTempDir) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });
  await config.addWorkspace(projectPath, {
    id: WS,
    name: "branch",
    projectPath,
    projectName: "project",
    runtimeConfig: { type: "local" },
  });
  const service = new DraftService(config);
  return { config, projectPath, service, ...createClient(service) };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The message `flush` rejects with, or "" when it resolves. */
function flushError(store: DraftStore): Promise<string> {
  return store.flush(WS_SCOPE).then(
    () => "",
    (error: unknown) => String(error)
  );
}

let cleanupDom: (() => void) | undefined;
const stores: DraftStore[] = [];

function createStore(client: ReturnType<typeof createClient>["client"]): DraftStore {
  const store = new DraftStore();
  stores.push(store);
  store.setClient(client);
  return store;
}

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.setClient(null);
  cleanupDom?.();
});

describe("DraftStore", () => {
  test("imports legacy drafts without clobbering and removes keys only after the backend answered", async () => {
    using tempDir = new TestTempDir("draft-store-legacy");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    // Another origin already stored this workspace's draft on the backend.
    await service.update({ scope: WS_SCOPE, text: "backend copy" });
    const creationScopeId = getDraftScopeId(projectPath, "draft-a");
    seedLegacyKey(getInputKey(WS), "stale local copy");
    seedLegacyKey(getInputKey(creationScopeId), "legacy creation text");
    seedLegacyKey(getInputAttachmentsKey(creationScopeId), [image]);
    seedLegacyKey(getInputKey(getPendingScopeId(projectPath)), "pending text");
    // Scope-bound settings of the pending composer follow its draft, like createWorkspaceDraft.
    updatePersistedState(getAutoExpandPrefsKey(getPendingScopeId(projectPath)), "pending-model");

    // First start: every import fails, so every key must survive for the next start.
    control.failImports = 100;
    const failing = createStore(client);
    await failing.whenReady();
    expect(listPersistedKeys("input")).toHaveLength(4);
    failing.setClient(null);

    control.failImports = 0;
    const store = createStore(client);
    await store.whenReady();

    expect(store.getText(WS_SCOPE)).toBe("backend copy");
    expect((await service.get(WS_SCOPE)).text).toBe("backend copy");
    const creation: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    expect(await service.get(creation)).toMatchObject({
      text: "legacy creation text",
      attachments: [image],
    });
    expect(store.getAttachments(creation)).toEqual([image]);
    // The pending draft became a listed creation draft of its project, still visible. draft-a
    // had no list entry (none was seeded), so the first list write relisted its body too.
    const projectDrafts = store.getCreationDraftsByProject()[projectPath];
    expect(projectDrafts).toHaveLength(2);
    const listed = projectDrafts.filter(({ draftId }) => draftId !== "draft-a");
    const converted: DraftScope = { kind: "creation", projectPath, draftId: listed[0].draftId };
    expect((await service.get(converted)).text).toBe("pending text");
    expect(listPersistedKeys("input")).toEqual([]);
    expect(
      readPersistedState<string | null>(
        getAutoExpandPrefsKey(getDraftScopeId(projectPath, listed[0].draftId)),
        null
      )
    ).toBe("pending-model");
    expect(
      readPersistedState<string | null>(getAutoExpandPrefsKey(getPendingScopeId(projectPath)), null)
    ).toBeNull();
  });

  test("renders typing at once, keeps it through a failed write, and confirms it in flush", async () => {
    using tempDir = new TestTempDir("draft-store-flush");
    const { service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();

    control.failUpdates = 1;
    store.setText(WS_SCOPE, "typed");
    expect(store.getText(WS_SCOPE)).toBe("typed");

    let firstFlushError: unknown;
    try {
      await store.flush(WS_SCOPE);
    } catch (error) {
      firstFlushError = error;
    }
    expect(firstFlushError).toBeDefined();
    expect(store.getText(WS_SCOPE)).toBe("typed");

    await store.flush(WS_SCOPE);
    expect((await service.get(WS_SCOPE)).text).toBe("typed");
  });

  test("applies other clients' changes but never lets a push overwrite an unconfirmed edit", async () => {
    using tempDir = new TestTempDir("draft-store-multi-client");
    const { service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();

    await service.update({ scope: WS_SCOPE, text: "from another tab" });
    await waitFor(() => store.getText(WS_SCOPE) === "from another tab");

    // A local edit whose write is still in flight, while another client writes meanwhile.
    let release: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.setText(WS_SCOPE, "local edit");
    const flushed = store.flush(WS_SCOPE);
    await waitFor(() => control.updates > 0);
    await service.update({ scope: WS_SCOPE, text: "concurrent remote" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getText(WS_SCOPE)).toBe("local edit");

    release();
    await flushed;
    expect(store.getText(WS_SCOPE)).toBe("local edit");
    expect((await service.get(WS_SCOPE)).text).toBe("local edit");
  });

  test("reports an oversized draft once and does not resend it until it changes", async () => {
    using tempDir = new TestTempDir("draft-store-too-large");
    const { service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    const errors: string[] = [];
    store.subscribeSaveErrors(WS_SCOPE, (message) => errors.push(message));

    const huge: DraftAttachment = {
      ...image,
      id: "huge",
      url: `data:image/png;base64,${"A".repeat(MAX_DRAFT_JSON_BYTES)}`,
    };
    store.setAttachments(WS_SCOPE, [huge]);
    let flushError: unknown;
    try {
      await store.flush(WS_SCOPE);
    } catch (error) {
      flushError = error;
    }
    expect(flushError).toBeDefined();
    // Past the first retry delays: a permanent failure must not push the payload again.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(control.updates).toBe(0);
    expect(errors).toHaveLength(1);
    expect(store.getAttachments(WS_SCOPE)).toEqual([huge]);

    // Removing the attachment makes the draft savable again.
    store.setAttachments(WS_SCOPE, [image]);
    await store.flush(WS_SCOPE);
    expect((await service.get(WS_SCOPE)).attachments).toEqual([image]);
  });

  test("queues an attachment add until the hydrated payloads load, so none are dropped", async () => {
    using tempDir = new TestTempDir("draft-store-payloads");
    const { service, client } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, text: "t", attachments: [image] });
    const store = createStore(client);
    await store.whenReady();
    // Hydration carries only metadata.
    expect(store.getView(WS_SCOPE)).toMatchObject({ attachmentCount: 1, payloadsLoaded: false });

    const added: DraftAttachment = { ...image, id: "img-2" };
    store.setAttachments(WS_SCOPE, (previous) => [...previous, added]);
    await store.ensurePayloads(WS_SCOPE);
    expect(store.getAttachments(WS_SCOPE).map(({ id }) => id)).toEqual(["img-1", "img-2"]);

    await store.flush(WS_SCOPE);
    expect((await service.get(WS_SCOPE)).attachments.map(({ id }) => id)).toEqual([
      "img-1",
      "img-2",
    ]);
  });

  test("lists an attachment-only legacy pending draft on a later start after a failed listing", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-attachments");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const attachmentsKey = getInputAttachmentsKey(getPendingScopeId(projectPath));
    seedLegacyKey(attachmentsKey, [image]);

    // The draft is imported, but listing it fails: its only legacy key must survive (#5226).
    control.failListPuts = 1;
    const first = createStore(client);
    await first.whenReady();
    first.setClient(null);
    expect(listPersistedKeys("inputAttachments")).toEqual([attachmentsKey]);

    const second = createStore(client);
    await second.whenReady();
    const creationDrafts = (await service.list()).filter(({ scope }) => scope.kind === "creation");
    expect(creationDrafts).toHaveLength(1);
    const scope = creationDrafts[0].scope as Extract<DraftScope, { kind: "creation" }>;
    expect((await service.get(scope)).attachments).toEqual([image]);
    await waitFor(
      () => second.getCreationDraftsByProject()[projectPath]?.[0]?.draftId === scope.draftId
    );
    expect((await service.getList()).entries.map(({ draftId }) => draftId)).toEqual([
      scope.draftId,
    ]);
    expect(listPersistedKeys("inputAttachments")).toEqual([]);
  });

  test("imports the legacy draft list once, shows it while the import fails, and relists lost drafts", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-list");
    const { config, projectPath, service, client, control } = await createHarness(tempDir);
    // An older list that outgrew its 32 KiB budget (#5225), and a body whose row it lost.
    const subProjectPath = path.join(projectPath, "x".repeat(300));
    const legacy = Array.from({ length: 100 }, (_, i) => ({
      draftId: `old-${i}`,
      subProjectPath,
      createdAt: i,
    }));
    seedLegacyKey(WORKSPACE_DRAFTS_BY_PROJECT_KEY, { [projectPath]: legacy });
    await service.update({ scope: { kind: "creation", projectPath, draftId: "lost" }, text: "t" });
    const listedIds = (store: DraftStore) =>
      (store.getCreationDraftsByProject()[projectPath] ?? []).map(({ draftId }) => draftId);

    // The subscription relists the lost body itself, so it shows even while the import fails.
    const expected = ["lost", ...legacy.map(({ draftId }) => draftId)];
    control.failListImports = 1;
    const failing = createStore(client);
    await failing.whenReady();
    expect(listedIds(failing)).toEqual(expected);
    expect(listPersistedKeys(WORKSPACE_DRAFTS_BY_PROJECT_KEY)).toHaveLength(1);
    failing.setClient(null);

    const store = createStore(client);
    await store.whenReady();
    await waitFor(() => listedIds(store).join() === expected.join());
    expect(store.getCreationDraftsByProject()[projectPath][1].subProjectPath).toBe(subProjectPath);
    expect(listPersistedKeys(WORKSPACE_DRAFTS_BY_PROJECT_KEY)).toEqual([]);

    // Restart: a new backend and store list every draft from the backend alone.
    const restarted = createStore(createClient(new DraftService(config)).client);
    await restarted.whenReady();
    expect(listedIds(restarted)).toEqual(expected);
  });

  test("sends list puts of one draft in order, so an older sub-project never lands last", async () => {
    using tempDir = new TestTempDir("draft-store-list-order");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    let releaseFirst: () => void = () => undefined;
    control.listPutGates.push(
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
    );
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: "/a", createdAt: 1 });
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: "/b", createdAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await waitFor(async () => (await service.getList()).entries[0]?.subProjectPath === "/b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await service.getList()).entries.map((entry) => entry.subProjectPath)).toEqual(["/b"]);
    await waitFor(
      () => store.getCreationDraftsByProject()[projectPath]?.[0]?.subProjectPath === "/b"
    );
  });

  test("retries a list put that failed on a replaced client through the current one", async () => {
    using tempDir = new TestTempDir("draft-store-list-reconnect");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.listPutGates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    control.failListPuts = 1;
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: null, createdAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Reconnect while the put is in flight; then the old request fails.
    store.setClient(createClient(service).client);
    // Let the new subscription's snapshot (and its resend attempt) run first.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await waitFor(async () => (await service.getList()).entries.length === 1, 5_000);
  });

  test("lists a saved draft whose list put kept failing until the app exited", async () => {
    using tempDir = new TestTempDir("draft-store-list-put-lost");
    const { config, projectPath, service, client, control } = await createHarness(tempDir);
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "d1" };
    const store = createStore(client);
    await store.whenReady();
    control.failListPuts = 1_000;
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: null, createdAt: 1 });
    store.setText(scope, "typed");
    await store.flush(scope);
    expect((await service.get(scope)).text).toBe("typed");
    // Exit before a retry lands.
    store.setClient(null);

    const restarted = createStore(createClient(new DraftService(config)).client);
    await restarted.whenReady();
    expect(
      restarted.getCreationDraftsByProject()[projectPath]?.map(({ draftId }) => draftId)
    ).toEqual(["d1"]);
    expect(restarted.getText(scope)).toBe("typed");
  });

  test("a delete waits for the draft's list put, so it is not relisted", async () => {
    using tempDir = new TestTempDir("draft-store-list-delete-order");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.listPutGates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: null, createdAt: 1 });
    const deleted = store.deleteDraft({ kind: "creation", projectPath, draftId: "d1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await deleted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await service.getList()).entries).toEqual([]);
    expect(store.getCreationDraftsByProject()[projectPath]).toBeUndefined();
  });

  test("a delete that waits for a write is not undone by that write's push", async () => {
    using tempDir = new TestTempDir("draft-store-delete-during-write");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "d1" };
    let sendUpdate: () => void = () => undefined;
    let sendReply: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      sendUpdate = resolve;
    });
    control.updateReplyGate = new Promise<void>((resolve) => {
      sendReply = resolve;
    });
    store.setText(scope, "submitted as a workspace");
    const flushed = store.flush(scope);
    await waitFor(() => control.updates === 1);
    const deleted = store.deleteDraft(scope);
    // The write lands after the delete started, and its push arrives before its reply.
    sendUpdate();
    await waitFor(async () => (await service.get(scope)).text.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    sendReply();
    await Promise.all([flushed, deleted]);
    expect((await service.get(scope)).text).toBe("");
    expect(store.getView(scope).text).toBe("");
  });

  test("a delete that waits for a write is not undone by a reconnect snapshot", async () => {
    using tempDir = new TestTempDir("draft-store-delete-during-reconnect");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "d1" };
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: null, createdAt: 1 });
    await waitFor(async () => (await service.getList()).entries.length === 1);
    let sendUpdate: () => void = () => undefined;
    let sendReply: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      sendUpdate = resolve;
    });
    control.updateReplyGate = new Promise<void>((resolve) => {
      sendReply = resolve;
    });
    store.setText(scope, "submitted as a workspace");
    const flushed = store.flush(scope);
    await waitFor(() => control.updates === 1);
    const deleted = store.deleteDraft(scope);
    sendUpdate();
    await waitFor(async () => (await service.get(scope)).text.length > 0);
    // The subscription reconnects while the delete waits: its snapshot holds the draft and row.
    store.setClient(null);
    await service.update({ scope: WS_SCOPE, text: "marks the snapshot" });
    store.setClient(client);
    await waitFor(() => store.getText(WS_SCOPE) === "marks the snapshot");
    expect(store.getCreationDraftsByProject()[projectPath]).toBeUndefined();
    sendReply();
    await Promise.all([flushed, deleted]);
    expect((await service.get(scope)).text).toBe("");
    expect((await service.getList()).entries).toEqual([]);
    expect(store.getView(scope).text).toBe("");
  });

  test("replaces a malformed legacy draft list, so its import still completes", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-list-malformed");
    const { projectPath, service, client } = await createHarness(tempDir);
    window.localStorage.setItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY, "{not json");
    await service.update({ scope: { kind: "creation", projectPath, draftId: "lost" }, text: "t" });
    const store = createStore(client);
    await store.whenReady();
    await waitFor(() => store.getCreationDraftsByProject()[projectPath]?.[0]?.draftId === "lost");
    expect(listPersistedKeys(WORKSPACE_DRAFTS_BY_PROJECT_KEY)).toEqual([]);
  });

  test("keeps a deleted draft hidden when its list put lands while the delete waits", async () => {
    using tempDir = new TestTempDir("draft-store-list-delete-hidden");
    const { projectPath, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.listPutGates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    store.putCreationDraft(projectPath, { draftId: "d1", subProjectPath: null, createdAt: 1 });
    // The backend delete keeps failing: only the pending delete hides the row.
    control.failDeletes = 100;
    const deleted = store.deleteDraft({ kind: "creation", projectPath, draftId: "d1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await deleted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getCreationDraftsByProject()[projectPath]).toBeUndefined();
  });

  test("lists a legacy creation draft whose row the legacy list had already lost", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-unlisted-body");
    const { projectPath, service, client } = await createHarness(tempDir);
    // The body exists only in localStorage, and the (over-budget) legacy list lost its row.
    seedLegacyKey(getInputKey(getDraftScopeId(projectPath, "draft-x")), "typed in an old build");
    seedLegacyKey(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {
      [projectPath]: [{ draftId: "other", subProjectPath: null, createdAt: 1 }],
    });
    const store = createStore(client);
    await store.whenReady();
    await waitFor(() =>
      (store.getCreationDraftsByProject()[projectPath] ?? []).some(
        ({ draftId }) => draftId === "draft-x"
      )
    );
    expect((await service.getList()).entries.map(({ draftId }) => draftId)).toEqual([
      "other",
      "draft-x",
    ]);
    expect(listPersistedKeys("input")).toEqual([]);
  });

  test("imports legacy drafts of workspace ids that start with underscores", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-underscore");
    const { config, projectPath, service, client } = await createHarness(tempDir);
    // Legacy ids were `<project basename>-<branch>`, so a project dir named "__proj" gives this.
    const workspaceId = "__proj-main";
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "main",
      projectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
    });
    seedLegacyKey(getInputKey(workspaceId), "underscored");

    const store = createStore(client);
    await store.whenReady();
    expect((await service.get({ kind: "workspace", workspaceId })).text).toBe("underscored");
  });

  test("applies a queued attachment update when the server empties the list meanwhile", async () => {
    using tempDir = new TestTempDir("draft-store-queued-empty");
    const { service, client, control } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, text: "t", attachments: [image] });
    const store = createStore(client);
    await store.whenReady();

    let release: () => void = () => undefined;
    control.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const added: DraftAttachment = { ...image, id: "img-2" };
    store.setAttachments(WS_SCOPE, (previous) => [...previous, added]);
    // Another client removes every attachment while the payloads are still loading.
    await service.update({ scope: WS_SCOPE, attachments: [] });
    await waitFor(() => store.getView(WS_SCOPE).payloadsLoaded);
    release();

    expect(store.getAttachments(WS_SCOPE)).toEqual([added]);
    await store.flush(WS_SCOPE);
    expect((await service.get(WS_SCOPE)).attachments).toEqual([added]);
  });

  test("reloads an attachment whose metadata changed under the same id", async () => {
    using tempDir = new TestTempDir("draft-store-metadata");
    const { service, client } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    const pendingFile: DraftAttachment = {
      kind: "pending-file",
      id: "file-1",
      mediaType: "text/plain",
      filename: "notes.txt",
      sizeBytes: 4,
      dataBase64: "dGVzdA==",
    };
    store.setAttachments(WS_SCOPE, [pendingFile]);
    await store.flush(WS_SCOPE);

    let notified = 0;
    store.subscribe(WS_SCOPE, () => notified++);
    // Another client staged the file: same id, different kind.
    const staged: DraftAttachment = {
      kind: "staged",
      id: "file-1",
      mediaType: "text/plain",
      filename: "notes.txt",
      sizeBytes: 4,
      stagedPath: "/worktree/.xum/staged/notes.txt",
    };
    await service.update({ scope: WS_SCOPE, attachments: [staged] });
    await waitFor(() => notified > 0);
    await store.ensurePayloads(WS_SCOPE);
    expect(store.getAttachments(WS_SCOPE)).toEqual([staged]);
  });

  test("retries a failed delete so no unreachable draft file is left", async () => {
    using tempDir = new TestTempDir("draft-store-delete-retry");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.update({ scope, text: "discarded" });
    const store = createStore(client);
    await store.whenReady();

    control.failDeletes = 1;
    await store.deleteDraft(scope);
    await waitFor(async () => (await service.get(scope)).text === "");
  });

  test("becomes ready without a snapshot, and a late snapshot keeps typed text", async () => {
    using tempDir = new TestTempDir("draft-store-ready-timeout");
    const { service, client, control } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, text: "server text" });
    let releaseSubscribe: () => void = () => undefined;
    control.subscribeGate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    fakeTimers.useFakeTimers();
    let store: DraftStore;
    try {
      store = createStore(client);
      fakeTimers.advanceTimersByTime(DRAFT_STORE_READY_TIMEOUT_MS);
    } finally {
      fakeTimers.useRealTimers();
    }
    expect(store.isReady()).toBe(true);

    store.setText(WS_SCOPE, "typed while loading");
    releaseSubscribe();
    await waitFor(async () => (await service.get(WS_SCOPE)).text === "typed while loading");
    expect(store.getText(WS_SCOPE)).toBe("typed while loading");
  });

  // The creation header's project selector waits for this: before it, a draft moves as empty.
  test("tells its ready subscribers when a snapshot after the ready timeout loads the drafts", async () => {
    using tempDir = new TestTempDir("draft-store-late-hydration");
    const { client, control } = await createHarness(tempDir);
    let releaseSubscribe: () => void = () => undefined;
    control.subscribeGate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    fakeTimers.useFakeTimers();
    let store: DraftStore;
    try {
      store = createStore(client);
      fakeTimers.advanceTimersByTime(DRAFT_STORE_READY_TIMEOUT_MS);
    } finally {
      fakeTimers.useRealTimers();
    }
    expect(store.isReady()).toBe(true);
    expect(store.isHydrated()).toBe(false);

    const seen: boolean[] = [];
    store.subscribeReady(() => seen.push(store.isHydrated()));
    releaseSubscribe();
    await waitFor(() => seen.includes(true));
  });

  test("does not retry the backend's size refusal of a draft whose payloads are not loaded", async () => {
    using tempDir = new TestTempDir("draft-store-backend-too-large");
    const { service, client, control } = await createHarness(tempDir);
    // Near the limit on the backend; the store knows only its metadata.
    const big: DraftAttachment = {
      ...image,
      id: "big",
      url: `data:image/png;base64,${"A".repeat(MAX_DRAFT_JSON_BYTES - 200)}`,
    };
    await service.update({ scope: WS_SCOPE, attachments: [big] });
    const store = createStore(client);
    await store.whenReady();
    const errors: string[] = [];
    store.subscribeSaveErrors(WS_SCOPE, (message) => errors.push(message));

    store.setText(WS_SCOPE, "x".repeat(400));
    await store.flush(WS_SCOPE).catch(() => undefined);
    const updates = control.updates;
    // Past the first retry delays: a permanent refusal must not be sent again.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(control.updates).toBe(updates);
    expect(errors).toHaveLength(1);
    expect(store.getText(WS_SCOPE)).toBe("x".repeat(400));

    // Another client removes the big attachment: the refused edit fits now and must be saved.
    await service.update({ scope: WS_SCOPE, attachments: [] });
    await waitFor(async () => (await service.get(WS_SCOPE)).text === "x".repeat(400));
  });

  test("retries a failed payload load while an attachment update waits for it", async () => {
    using tempDir = new TestTempDir("draft-store-payload-retry-queued");
    const { service, client, control } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, attachments: [image] });
    const store = createStore(client);
    await store.whenReady();

    control.failGets = 1;
    const second: DraftAttachment = { ...image, id: "img-2" };
    store.setAttachments(WS_SCOPE, (previous) => [...previous, second]);
    // No later backend event or remount: only a retry can apply and save the update.
    await waitFor(async () => (await service.get(WS_SCOPE)).attachments.length === 2, 5_000);
    expect(store.getAttachments(WS_SCOPE).map(({ id }) => id)).toEqual(["img-1", "img-2"]);
  });

  test("retries a failed payload load of a shown draft, so its attachments become sendable", async () => {
    using tempDir = new TestTempDir("draft-store-payload-retry-shown");
    const { service, client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.subscribe(WS_SCOPE, () => undefined);

    control.failGets = 1;
    await service.update({ scope: WS_SCOPE, attachments: [image] });
    await waitFor(() => store.getView(WS_SCOPE).payloadsLoaded, 5_000);
    expect(store.getAttachments(WS_SCOPE)).toEqual([image]);
  });

  test("an attachment added before the first snapshot keeps the server's attachments", async () => {
    using tempDir = new TestTempDir("draft-store-attach-before-snapshot");
    const { service, client, control } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, attachments: [image] });
    let releaseSubscribe: () => void = () => undefined;
    control.subscribeGate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    fakeTimers.useFakeTimers();
    let store: DraftStore;
    try {
      store = createStore(client);
      fakeTimers.advanceTimersByTime(DRAFT_STORE_READY_TIMEOUT_MS);
    } finally {
      fakeTimers.useRealTimers();
    }
    expect(store.isReady()).toBe(true);

    const second: DraftAttachment = { ...image, id: "img-2" };
    store.setAttachments(WS_SCOPE, (previous) => [...previous, second]);
    releaseSubscribe();
    await waitFor(async () => (await service.get(WS_SCOPE)).attachments.length === 2);
    expect((await service.get(WS_SCOPE)).attachments.map(({ id }) => id)).toEqual([
      "img-1",
      "img-2",
    ]);
  });

  test("flush confirms an attachment update that waited for the payloads", async () => {
    using tempDir = new TestTempDir("draft-store-flush-queued");
    const { service, client, control } = await createHarness(tempDir);
    await service.update({ scope: WS_SCOPE, attachments: [image] });
    const store = createStore(client);
    await store.whenReady();

    let releaseGet: () => void = () => undefined;
    control.getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const second: DraftAttachment = { ...image, id: "img-2" };
    store.setAttachments(WS_SCOPE, (previous) => [...previous, second]);
    const flushed = store.flush(WS_SCOPE);
    releaseGet();
    await flushed;
    // Resolved means saved, as the #4448 restore ack relies on.
    expect((await service.get(WS_SCOPE)).attachments.map(({ id }) => id)).toEqual([
      "img-1",
      "img-2",
    ]);
  });

  test("reports a save failure to the next composer when none was listening", async () => {
    using tempDir = new TestTempDir("draft-store-unheard-error");
    const { client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();

    control.failUpdates = 2;
    store.setText(WS_SCOPE, "typed");
    await store.flush(WS_SCOPE).catch(() => undefined);
    const errors: string[] = [];
    store.subscribeSaveErrors(WS_SCOPE, (message) => errors.push(message));
    await store.flush(WS_SCOPE).catch(() => undefined);
    expect(errors).toEqual(["update failed"]);
  });

  test("shows and saves a legacy draft whose import failed when the backend has none", async () => {
    using tempDir = new TestTempDir("draft-store-import-failed");
    const { service, client, control } = await createHarness(tempDir);
    seedLegacyKey(getInputKey(WS), "pre-upgrade");

    control.failImports = 100;
    const first = createStore(client);
    await first.whenReady();
    // Were it empty, the user would type over it and the next import would answer "present".
    expect(first.getText(WS_SCOPE)).toBe("pre-upgrade");
    await first.flush(WS_SCOPE);
    expect(listPersistedKeys("input")).toHaveLength(1);
    first.setClient(null);

    control.failImports = 0;
    const second = createStore(client);
    await second.whenReady();
    expect((await service.get(WS_SCOPE)).text).toBe("pre-upgrade");
    expect(listPersistedKeys("input")).toEqual([]);
  });

  // #6438: a new backend (another process, its clock behind) numbers its revisions lower. The
  // store kept the old backend's saved view, and a write reply below that view's revision put
  // the old text back over what the user had just typed.
  test("a write reply from a new backend with lower revisions keeps the typed text", async () => {
    using tempDir = new TestTempDir("draft-store-new-backend");
    const { config, client } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.setText(WS_SCOPE, "text on the old backend");
    await store.flush(WS_SCOPE);

    // The same drafts on disk, served by a new process whose revisions start lower.
    const realNow = Date.now;
    Date.now = () => realNow() - 3_600_000;
    let service: DraftService;
    try {
      service = new DraftService(config);
    } finally {
      Date.now = realNow;
    }
    const next = createClient(service);
    store.setClient(next.client);
    await waitFor(() => next.control.updates === 0 && store.isHydrated());

    store.setText(WS_SCOPE, "typed after the switch");
    await store.flush(WS_SCOPE);
    expect(next.control.updates).toBeGreaterThan(0);
    expect(store.getText(WS_SCOPE)).toBe("typed after the switch");
    expect((await service.get(WS_SCOPE)).text).toBe("typed after the switch");
  });

  // #6438, review round 3: an edit saved to a new backend before its snapshot arrived. That
  // reply was compared with the old backend's view, lost to it, and the old text came back. Each
  // subscription start forgets the old views, so the reply is taken as it comes.
  test("an edit saved to a new backend before its snapshot keeps the typed text", async () => {
    using tempDir = new TestTempDir("draft-store-new-backend-early-write");
    const { config, client } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.setText(WS_SCOPE, "text on the old backend");
    await store.flush(WS_SCOPE);

    const realNow = Date.now;
    Date.now = () => realNow() - 3_600_000;
    let service: DraftService;
    try {
      service = new DraftService(config);
    } finally {
      Date.now = realNow;
    }
    const next = createClient(service);
    let releaseSnapshot: () => void = () => undefined;
    next.control.subscribeGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    store.setClient(next.client);

    store.setText(WS_SCOPE, "typed after the switch");
    await store.flush(WS_SCOPE);
    expect(next.control.updates).toBeGreaterThan(0);
    expect(store.getText(WS_SCOPE)).toBe("typed after the switch");

    releaseSnapshot();
    await waitFor(() => store.isHydrated());
    await store.flush(WS_SCOPE);
    expect(store.getText(WS_SCOPE)).toBe("typed after the switch");
    expect((await service.get(WS_SCOPE)).text).toBe("typed after the switch");
    store.setText(WS_SCOPE, "typed later");
    await store.flush(WS_SCOPE);
    expect(store.getText(WS_SCOPE)).toBe("typed later");
    expect((await service.get(WS_SCOPE)).text).toBe("typed later");
  });

  // #6438: forgetting the views on a reconnect must not touch what the composer shows.
  test("a reconnect to the same backend keeps showing the draft until its snapshot", async () => {
    using tempDir = new TestTempDir("draft-store-reconnect-view");
    const { client, control } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.setText(WS_SCOPE, "saved text");
    store.setAttachments(WS_SCOPE, [image]);
    await store.flush(WS_SCOPE);

    store.setClient(null);
    let releaseSnapshot: () => void = () => undefined;
    control.subscribeGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    store.setClient(client);
    const view = store.getView(WS_SCOPE);
    expect([view.text, view.attachments.map(({ id }) => id)]).toEqual(["saved text", ["img-1"]]);
    releaseSnapshot();
    await waitFor(() => store.isHydrated());
    expect(store.getText(WS_SCOPE)).toBe("saved text");
  });

  // #6438: the reset at a reconnect forgets the backend's views, never an unsaved edit.
  test("unsaved typing survives a reconnect and is saved after the snapshot", async () => {
    using tempDir = new TestTempDir("draft-store-reconnect-unsaved");
    const { client, control, service } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.setText(WS_SCOPE, "saved text");
    await store.flush(WS_SCOPE);

    control.failUpdates = 100;
    store.setText(WS_SCOPE, "unsaved typing");
    expect(await flushError(store)).toContain("update failed");
    store.setClient(null);
    store.setClient(client);
    // The snapshot still holds the saved text.
    await waitFor(() => store.isHydrated());
    expect(store.getText(WS_SCOPE)).toBe("unsaved typing");
    control.failUpdates = 0;
    await store.flush(WS_SCOPE);
    expect((await service.get(WS_SCOPE)).text).toBe("unsaved typing");
  });

  // #6438, the same switch with a write in flight: the old backend's late reply confirmed the
  // edit, so it was never written to the new backend (lost on reload), and its view (the old
  // backend's higher revision) again outranked every later reply of the new one.
  test("an edit whose write was in flight when the backend changed reaches the new backend", async () => {
    using oldDir = new TestTempDir("draft-store-old-backend");
    using newDir = new TestTempDir("draft-store-switched-backend");
    const old = await createHarness(oldDir);
    const store = createStore(old.client);
    await store.whenReady();
    let release: () => void = () => undefined;
    old.control.updateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.setText(WS_SCOPE, "typed during the switch");
    const inFlight = store.flush(WS_SCOPE).catch(() => undefined);
    await waitFor(() => old.control.updates === 1);

    const next = await createHarness(newDir);
    let releaseSnapshot: () => void = () => undefined;
    next.control.subscribeGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    store.setClient(next.client);
    // The old backend answers before the new one's snapshot.
    release();
    await inFlight;
    releaseSnapshot();
    await waitFor(() => store.isHydrated());
    await store.flush(WS_SCOPE);
    expect((await next.service.get(WS_SCOPE)).text).toBe("typed during the switch");

    store.setText(WS_SCOPE, "typed later");
    await store.flush(WS_SCOPE);
    expect(store.getText(WS_SCOPE)).toBe("typed later");
  });

  test("keeps an unsaved name edit over a push, saves it, and shows other windows' names", async () => {
    using tempDir = new TestTempDir("draft-store-name-state");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "named" };
    const mine = { ...NAME_STATE, manualName: "this-window", autoGenerate: false };
    const store = createStore(client);
    const other = createStore(client);
    await store.whenReady();
    await other.whenReady();

    control.updateGate = new Promise(() => undefined);
    store.setNameState(scope, mine);
    // Another window saves a name while this window's edit is unsaved: the edit stays shown.
    await service.update({ scope, nameState: NAME_STATE });
    await waitFor(() => other.getView(scope).nameState !== null);
    expect(store.getView(scope).nameState).toEqual(mine);

    control.updateGate = null;
    await store.flush(scope);
    expect((await service.get(scope)).nameState).toEqual(mine);
    await waitFor(() => other.getView(scope).nameState?.manualName === "this-window");
    // Clearing it removes the name from the body, not the body's text.
    await service.update({ scope, text: "kept" });
    store.setNameState(scope, null);
    await store.flush(scope);
    expect(await service.get(scope)).toMatchObject({ text: "kept" });
    expect((await service.get(scope)).nameState).toBeUndefined();
  });

  test("imports legacy name keys into their drafts and removes a key only once the backend answered", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-names");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const listed: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    const defaultScope: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    await service.putListEntry({ ...listed, subProjectPath: null, createdAt: 1 });
    const listedKey = getWorkspaceNameStateKey(getDraftScopeId(projectPath, "draft-a"));
    const pendingKey = getWorkspaceNameStateKey(getPendingScopeId(projectPath));
    seedLegacyKey(listedKey, NAME_STATE);
    seedLegacyKey(pendingKey, { ...NAME_STATE, manualName: "default-name", autoGenerate: false });

    control.failImports = 100;
    const failing = createStore(client);
    await failing.whenReady();
    expect(listPersistedKeys("workspaceNameState:").sort()).toEqual([listedKey, pendingKey].sort());
    // Shown meanwhile, so the name is never lost while its import is retried.
    expect(failing.getView(listed).nameState).toEqual(NAME_STATE);
    failing.setClient(null);

    control.failImports = 0;
    const store = createStore(client);
    await store.whenReady();
    expect(listPersistedKeys("workspaceNameState:")).toEqual([]);
    expect((await service.get(listed)).nameState).toEqual(NAME_STATE);
    expect((await service.get(defaultScope)).nameState?.manualName).toBe("default-name");
    expect(store.getView(defaultScope).nameState?.manualName).toBe("default-name");
  });

  // localStorage is per origin: a browser tab keeps the name key of a draft that the desktop app
  // sent or deleted. Importing it would write a body that holds only the name, and the backend
  // relists a body without a row, so the gone draft would come back as a sidebar row.
  test("leaves a legacy name key of a draft the backend does not know", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-name-unknown");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const ghost: DraftScope = { kind: "creation", projectPath, draftId: "ghost-of-sent-draft" };
    const listed: DraftScope = { kind: "creation", projectPath, draftId: "listed-no-body" };
    await service.putListEntry({ ...listed, subProjectPath: null, createdAt: 1 });
    const ghostKey = getWorkspaceNameStateKey(getDraftScopeId(projectPath, ghost.draftId));
    const listedKey = getWorkspaceNameStateKey(getDraftScopeId(projectPath, listed.draftId));
    seedLegacyKey(ghostKey, NAME_STATE);
    seedLegacyKey(listedKey, NAME_STATE);

    const store = createStore(client);
    await store.whenReady();
    expect(control.importedScopes).toEqual([listed]);
    expect(listPersistedKeys("workspaceNameState:")).toEqual([ghostKey]);
    expect((await service.get(listed)).nameState).toEqual(NAME_STATE);
    expect(store.getView(ghost).nameState).toBeNull();
    expect((await service.get(ghost)).nameState).toBeUndefined();
    store.setClient(null);

    // The next start (the backend relists bodies without a row then) shows no row for it.
    const restarted = createStore(client);
    await restarted.whenReady();
    expect(
      restarted.getCreationDraftsByProject()[projectPath]?.map(({ draftId }) => draftId)
    ).toEqual([listed.draftId]);
  });

  // Older builds read these keys with a partial schema, and wrote keys holding only some fields.
  test("imports a legacy name key that holds only some fields", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-partial-name");
    const { projectPath, service, client } = await createHarness(tempDir);
    const scope: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.putListEntry({ ...scope, subProjectPath: null, createdAt: 1 });
    const key = getWorkspaceNameStateKey(getDraftScopeId(projectPath, "draft-a"));
    seedLegacyKey(key, { autoGenerate: false, manualName: "typed-name" });

    const store = createStore(client);
    await store.whenReady();
    expect((await service.get(scope)).nameState).toEqual({
      generatedIdentity: null,
      manualName: "typed-name",
      autoGenerate: false,
      lastGeneratedFor: "",
    });
    expect(store.getView(scope).nameState?.manualName).toBe("typed-name");
    expect(listPersistedKeys("workspaceNameState:")).toEqual([]);
  });

  // The copy of a legacy pending draft's settings to its imported draft can fail (quota): its
  // name must still end up in that draft, next to its text, never in the default draft.
  test("imports a legacy pending draft's name into the draft its text went to", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-pending-name");
    const { projectPath, service, client } = await createHarness(tempDir);
    const pendingName = { ...NAME_STATE, manualName: "pending-name", autoGenerate: false };
    seedLegacyKey(getInputKey(getPendingScopeId(projectPath)), "pending prompt");
    seedLegacyKey(getWorkspaceNameStateKey(getPendingScopeId(projectPath)), pendingName);
    const storage = restartLocalStorage();
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key.startsWith("workspaceNameState:")) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      setItem(key, value);
    };

    const store = createStore(client);
    await store.whenReady();
    const imported: DraftScope = { kind: "creation", projectPath, draftId: "legacy-pending" };
    const defaultScope: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    expect(await service.get(imported)).toMatchObject({
      text: "pending prompt",
      nameState: pendingName,
    });
    expect((await service.get(defaultScope)).nameState).toBeUndefined();
    expect(store.getView(defaultScope).nameState).toBeNull();
    expect(store.getView(imported).nameState).toEqual(pendingName);
  });

  // Another origin imported the pending draft's text already; this origin's import adds only the
  // name. Its reply comes before the change event, which is then stale for this window.
  test("shows the draft a partial legacy import stored, not the legacy input", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-partial-import");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const imported: DraftScope = { kind: "creation", projectPath, draftId: "legacy-pending" };
    await service.update({ scope: imported, text: "imported by another origin" });
    await service.putListEntry({ ...imported, subProjectPath: null, createdAt: 1 });
    seedLegacyKey(getInputKey(getPendingScopeId(projectPath)), "stale pending prompt");
    seedLegacyKey(getWorkspaceNameStateKey(getPendingScopeId(projectPath)), NAME_STATE);

    let releaseEvents: () => void = () => undefined;
    control.eventGate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    const store = createStore(client);
    await store.whenReady();
    expect(store.getView(imported)).toMatchObject({
      text: "imported by another origin",
      nameState: NAME_STATE,
    });
    releaseEvents();
    expect(await service.get(imported)).toMatchObject({
      text: "imported by another origin",
      nameState: NAME_STATE,
    });
  });

  test("moves the default draft in one step and shows the destination once it moved", async () => {
    using tempDir = new TestTempDir("draft-store-move-creation");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    await service.update({ scope: source, text: "typed before reload", attachments: [image] });
    await service.update({ scope: source, nameState: NAME_STATE });
    // A reload: the source's attachment payloads have not loaded.
    const store = createStore(client);
    await store.whenReady();
    const row = { projectPath, draftId: "first-listed", subProjectPath: null, createdAt: 5 };
    const dest: DraftScope = { kind: "creation", projectPath, draftId: "first-listed" };
    const updatesBefore = control.updates;
    let release: () => void = () => undefined;
    control.moveGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const moved = store.moveCreationDraft(source, row);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing moves before the backend did.
    expect(store.getView(dest).text).toBe("");
    expect(store.getView(source).text).toBe("typed before reload");
    release();
    expect(await moved).toBe(true);

    expect(store.getView(dest)).toMatchObject({
      text: "typed before reload",
      attachmentCount: 1,
      nameState: NAME_STATE,
    });
    expect(store.getCreationDraftsByProject()[projectPath]).toEqual([
      { draftId: "first-listed", subProjectPath: null, createdAt: 5 },
    ]);
    await store.ensurePayloads(dest);
    expect(store.getAttachments(dest)).toEqual([image]);
    expect(await service.get(dest)).toMatchObject({
      text: "typed before reload",
      attachments: [image],
      nameState: NAME_STATE,
    });
    expect((await service.get(source)).text).toBe("");
    expect((await service.getList()).entries).toEqual([row]);
    // No separate body write or list put: the move did both.
    expect(control.updates).toBe(updatesBefore);
    expect(control.listPuts).toBe(0);
  });

  test("moves another window's edit made during the move", async () => {
    using tempDir = new TestTempDir("draft-store-move-changed");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    await service.update({ scope: source, text: "mine" });
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.moveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dest: DraftScope = { kind: "creation", projectPath, draftId: "dst" };

    const moved = store.moveCreationDraft(source, {
      projectPath,
      draftId: "dst",
      subProjectPath: null,
      createdAt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Another window types into the source after this one flushed it.
    await service.update({ scope: source, text: "mine and theirs" });
    control.moveGate = null;
    release();

    expect(await moved).toBe(true);
    expect((await service.get(dest)).text).toBe("mine and theirs");
    expect(store.getView(dest).text).toBe("mine and theirs");
    expect((await service.get(source)).text).toBe("");
  });

  test("a move whose reply was lost after the backend moved the draft still shows it moved", async () => {
    using tempDir = new TestTempDir("draft-store-move-lost-reply");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "src" };
    await service.putListEntry({ projectPath, draftId: "src", subProjectPath: null, createdAt: 1 });
    await service.update({ scope: source, text: "draft", nameState: NAME_STATE });
    const store = createStore(client);
    await store.whenReady();
    control.loseMoveReplies = 1;
    const dest: DraftScope = { kind: "creation", projectPath, draftId: "dst" };

    expect(
      await store.moveCreationDraft(source, {
        projectPath,
        draftId: "dst",
        subProjectPath: null,
        createdAt: 1,
      })
    ).toBe(true);

    expect(store.getView(dest)).toMatchObject({ text: "draft", nameState: NAME_STATE });
    expect(store.getView(source).text).toBe("");
    expect(store.getCreationDraftsByProject()[projectPath]?.map(({ draftId }) => draftId)).toEqual([
      "dst",
    ]);
    // The next edit adds to the moved text instead of replacing it.
    store.setText(dest, "draft, edited");
    await store.flush(dest);
    expect((await service.get(dest)).text).toBe("draft, edited");
  });

  test("a source edit made after the move's flush is saved, not dropped", async () => {
    using tempDir = new TestTempDir("draft-store-move-late-edit");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "src" };
    await service.putListEntry({ projectPath, draftId: "src", subProjectPath: null, createdAt: 1 });
    await service.update({ scope: source, text: "draft" });
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.moveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dest: DraftScope = { kind: "creation", projectPath, draftId: "dst" };

    const moved = store.moveCreationDraft(source, {
      projectPath,
      draftId: "dst",
      subProjectPath: null,
      createdAt: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // E.g. a file read the source composer began before the move ends now.
    store.setAttachments(source, [image]);
    release();
    expect(await moved).toBe(true);
    await store.flush(source);

    expect((await service.get(dest)).text).toBe("draft");
    expect((await service.get(source)).attachments).toEqual([image]);
    expect(store.getAttachments(source)).toEqual([image]);
    await waitFor(async () => (await service.getList()).entries.length === 2);
  });

  test("a move whose source another move took ends without an empty draft", async () => {
    using tempDir = new TestTempDir("draft-store-move-taken");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    await service.update({ scope: source, text: "promoted twice" });
    const store = createStore(client);
    const other = createStore(client);
    await store.whenReady();
    await other.whenReady();
    let release: () => void = () => undefined;
    control.moveGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Two windows promote the same default draft at once.
    const first = store.moveCreationDraft(source, {
      projectPath,
      draftId: "first",
      subProjectPath: null,
      createdAt: 1,
    });
    const second = other.moveCreationDraft(source, {
      projectPath,
      draftId: "second",
      subProjectPath: null,
      createdAt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.moveGate = null;
    release();

    expect([await first, await second].sort()).toEqual([false, true]);
    const entries = (await service.getList()).entries;
    expect(entries).toHaveLength(1);
    expect(
      (await service.get({ kind: "creation", projectPath, draftId: entries[0].draftId })).text
    ).toBe("promoted twice");
  });

  test("a failed move leaves the source as it was and creates nothing", async () => {
    using tempDir = new TestTempDir("draft-store-move-fail");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "src" };
    await service.putListEntry({ projectPath, draftId: "src", subProjectPath: null, createdAt: 1 });
    await service.update({ scope: source, text: "draft" });
    const store = createStore(client);
    await store.whenReady();
    control.failMoves = 100;
    const dest: DraftScope = { kind: "creation", projectPath, draftId: "dst" };

    expect(
      await store.moveCreationDraft(source, {
        projectPath,
        draftId: "dst",
        subProjectPath: null,
        createdAt: 2,
      })
    ).toBe(false);

    expect(store.getView(dest).text).toBe("");
    expect(store.getView(source).text).toBe("draft");
    expect(store.getCreationDraftsByProject()[projectPath]?.map(({ draftId }) => draftId)).toEqual([
      "src",
    ]);
    expect((await service.get(source)).text).toBe("draft");
    expect((await service.getList()).entries.map(({ draftId }) => draftId)).toEqual(["src"]);
  });

  test("a moving draft shows itself as its move began, and after a failure as the backend has it", async () => {
    using tempDir = new TestTempDir("draft-store-move-shown");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "src" };
    await service.putListEntry({ projectPath, draftId: "src", subProjectPath: null, createdAt: 1 });
    await service.update({ scope: source, text: "draft" });
    const store = createStore(client);
    await store.whenReady();
    let release: () => void = () => undefined;
    control.moveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    control.failMoves = 100;

    const moved = store.moveCreationDraft(source, {
      projectPath,
      draftId: "dst",
      subProjectPath: null,
      createdAt: 2,
    });
    const pushed = new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(source, () => {
        unsubscribe();
        resolve();
      });
    });
    // Another window edits the source while the move waits.
    await service.update({ scope: source, text: "draft, theirs" });
    await pushed;
    expect(store.getView(source).text).toBe("draft");
    control.moveGate = null;
    release();

    expect(await moved).toBe(false);
    expect(store.getView(source).text).toBe("draft, theirs");
  });
});
