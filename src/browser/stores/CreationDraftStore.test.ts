import * as path from "path";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import type {
  CreationDraftDeleteInput,
  CreationDraftImportLegacyInput,
  CreationDraftScope,
  CreationDraftUpdateInput,
  DraftAttachment,
} from "@/common/orpc/schemas/drafts";
import {
  getDraftScopeId,
  getInputKey,
  getWorkspaceNameStateKey,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import { DRAFT_STORE_READY_TIMEOUT_MS, MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";
import { isDraftTooLargeError } from "@/common/utils/drafts";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import {
  CreationDraftRejectedError,
  CreationDraftService,
  creationDraftImportId,
} from "@/node/services/creationDraftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { CreationDraftStore } from "./CreationDraftStore";
import { retryDelayMs } from "./DraftStore";

const PROJECT_A = "/projects/a";
const PROJECT_B = "/projects/b";
const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
  filename: "shot.png",
};

let cleanupDom: (() => void) | undefined;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  jest.useRealTimers();
  cleanupDom?.();
});

/** Like the router (rethrowCreationDraftRefusal): a refused save reaches the store as BAD_REQUEST. */
function rethrowAsRouterRefusal(error: unknown): never {
  if (error instanceof CreationDraftRejectedError || isDraftTooLargeError(error)) {
    throw new ORPCError("BAD_REQUEST", { message: (error as Error).message });
  }
  throw error;
}

async function createHarness(
  tempDir: TestTempDir,
  options?: { seed?: (config: Config) => Promise<void>; failLegacyImport?: string }
) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  await config.editConfig((cfg) => {
    cfg.projects.set(PROJECT_A, { workspaces: [] });
    cfg.projects.set(PROJECT_B, { workspaces: [] });
    return cfg;
  });
  await options?.seed?.(config);
  const service = new CreationDraftService(config);
  const control = {
    updates: [] as CreationDraftUpdateInput[],
    updateGate: Promise.resolve(),
    failUpdates: 0,
    /** Saves the backend applies whose reply is then lost. */
    loseUpdateReplies: 0,
    readError: null as Error | null,
    failReads: 0,
    readGate: Promise.resolve(),
    listGate: Promise.resolve(),
    /** Holds a list reply that was read already (a snapshot older than what follows). */
    listReplyGate: Promise.resolve(),
    listCalls: 0,
    failDeletes: 0,
    deleteCalls: 0,
    deletesDone: 0,
    /** Delete requests that returned or threw. */
    deletesSettled: 0,
  };
  const drafts = {
    listCreation: async () => {
      control.listCalls++;
      await control.listGate;
      const list = await service.list();
      await control.listReplyGate;
      return list;
    },
    getCreation: async ({ scope }: { scope: CreationDraftScope }) => {
      await control.readGate;
      if (control.readError) throw control.readError;
      if (control.failReads > 0) {
        control.failReads--;
        throw new Error("connection lost");
      }
      return service.get(scope.draftId);
    },
    updateCreation: async (input: CreationDraftUpdateInput) => {
      control.updates.push(input);
      await control.updateGate;
      if (control.failUpdates > 0) {
        control.failUpdates--;
        throw new Error("connection lost");
      }
      const reply = await service.update(input).catch(rethrowAsRouterRefusal);
      if (control.loseUpdateReplies > 0) {
        control.loseUpdateReplies--;
        throw new Error("connection lost");
      }
      return reply;
    },
    deleteCreation: async ({ scope, ifStored }: CreationDraftDeleteInput) => {
      control.deleteCalls++;
      try {
        if (control.failDeletes > 0) {
          control.failDeletes--;
          throw new Error("connection lost");
        }
        await service.delete(scope.draftId, ifStored);
        control.deletesDone++;
      } finally {
        control.deletesSettled++;
      }
    },
    importLegacyCreation: async (input: CreationDraftImportLegacyInput) => {
      if (input.legacyDraftId === options?.failLegacyImport) throw new Error("connection lost");
      return service.importLegacy(input);
    },
  };
  const newClient = () => createTestApiClient({ drafts });
  const store = new CreationDraftStore();
  store.setClient(newClient());
  return { config, service, control, store, newClient };
}

/** A store of a reloaded window: reads the draft back from the backend. */
async function reopen(
  harness: Awaited<ReturnType<typeof createHarness>>,
  id: string,
  projectPath: string
) {
  const store = new CreationDraftStore();
  store.setClient(harness.newClient());
  store.open(id, projectPath);
  await waitFor(() => store.getView(id).load.status !== "loading");
  return store;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}

describe("CreationDraftStore", () => {
  test("a project change keeps the draft's id, text, attachments and name", async () => {
    using tempDir = new TestTempDir("creation-store-move");
    const harness = await createHarness(tempDir);
    const { store } = harness;
    await waitFor(() => store.getListState().status === "ready");
    // The bare project route's blank draft.
    const id = store.draftIdForProject(PROJECT_A);
    store.open(id, PROJECT_A);
    await waitFor(() => store.getView(id).load.status === "ready");
    store.update(id, { text: "fix it", attachments: [image], manualName: "my-name" });
    await store.flush(id);

    store.update(id, { projectPath: PROJECT_B, subProjectPath: null });
    await store.flush(id);
    // Moved away, it is no longer A's blank draft: opening A starts another one.
    expect(store.draftIdForProject(PROJECT_A)).not.toBe(id);

    const reloaded = await reopen(harness, id, PROJECT_A);
    expect(reloaded.getView(id).draft).toMatchObject({
      id,
      projectPath: PROJECT_B,
      text: "fix it",
      attachments: [image],
      manualName: "my-name",
    });
    await waitFor(() => reloaded.getListState().status === "ready");
    expect(reloaded.getDraftsByProject()[PROJECT_A]).toBeUndefined();
    expect(reloaded.getDraftsByProject()[PROJECT_B]?.map((draft) => draft.draftId)).toEqual([id]);
  });

  test("a new draft is saved and listed only once it has content", async () => {
    using tempDir = new TestTempDir("creation-store-content");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    await waitFor(() => store.getListState().status === "ready");
    // Explicit New, then a model pick and blank text: nothing to save, so no record and no row.
    const id = store.create(PROJECT_A, null);
    store.update(id, { ai: { model: "openai:gpt-5" } });
    store.update(id, { text: "  " });
    await store.flush(id);
    expect(control.updates).toEqual([]);
    expect(store.getView(id).unsaved).toBe(false);
    // A reconnect relists from the backend plus local copies: still no row for it.
    const relisted = new Promise<void>((resolve) => {
      const unsubscribe = store.subscribeList(() => {
        unsubscribe();
        resolve();
      });
    });
    store.setClient(harness.newClient());
    await relisted;
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();

    store.update(id, { text: "fix it" });
    await store.flush(id);
    // The first save carries the earlier pick too.
    expect(await service.get(id)).toMatchObject({ text: "fix it", ai: { model: "openai:gpt-5" } });
    expect(store.getDraftsByProject()[PROJECT_A]?.map((draft) => draft.draftId)).toEqual([id]);
  });

  test("clearing a draft whose first save reply was lost still saves the clear", async () => {
    using tempDir = new TestTempDir("creation-store-lost-first");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    await waitFor(() => store.getListState().status === "ready");
    const id = store.create(PROJECT_A, null);
    store.update(id, { text: "fix it" });
    // The backend writes the record, but the reply is lost.
    control.loseUpdateReplies = 1;
    let firstError: unknown = null;
    await store.flush(id).catch((error: unknown) => (firstError = error));
    expect(firstError).not.toBeNull();
    expect(await service.get(id)).toMatchObject({ text: "fix it" });

    store.update(id, { text: "" });
    await store.flush(id);
    expect(await service.get(id)).toMatchObject({ text: "" });
  });

  test("removing the attachment of a refused first save leaves no record", async () => {
    using tempDir = new TestTempDir("creation-store-refused-first");
    const harness = await createHarness(tempDir);
    const { store, service } = harness;
    await waitFor(() => store.getListState().status === "ready");
    const id = store.create(PROJECT_A, null);
    const huge = { ...image, url: `data:image/png;base64,${"A".repeat(MAX_DRAFT_JSON_BYTES)}` };
    store.update(id, { attachments: [huge] });
    let refusal: unknown = null;
    await store.flush(id).catch((error: unknown) => (refusal = error));
    expect(isDraftTooLargeError(refusal)).toBe(true);

    store.update(id, { attachments: [] });
    await store.flush(id);
    expect(await service.get(id)).toBeNull();
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
  });

  test("clearing a first save refused for its project, then moving it, leaves no record", async () => {
    using tempDir = new TestTempDir("creation-store-refused-project");
    const harness = await createHarness(tempDir);
    const { store, service, config } = harness;
    await waitFor(() => store.getListState().status === "ready");
    const id = store.create(PROJECT_A, null);
    await config.editConfig((cfg) => {
      cfg.projects.delete(PROJECT_A);
      return cfg;
    });
    store.update(id, { text: "fix it" });
    let refusal: unknown = null;
    await store.flush(id).catch((error: unknown) => (refusal = error));
    expect(String(refusal)).toContain("not registered");

    store.update(id, { text: "", projectPath: PROJECT_B });
    await store.flush(id);
    expect(await service.get(id)).toBeNull();
    expect(store.getDraftsByProject()[PROJECT_B]).toBeUndefined();
  });

  test("an earlier save reply never replaces a later local edit", async () => {
    using tempDir = new TestTempDir("creation-store-order");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "first" });
    await store.flush(id);
    store.update(id, { attachments: [image] });
    await store.flush(id);
    control.updates = [];

    let release = () => undefined as void;
    control.updateGate = new Promise((resolve) => (release = resolve));
    store.update(id, { text: "a" });
    const firstFlush = store.flush(id);
    await waitFor(() => control.updates.length === 1);
    store.update(id, { text: "ab" });
    release();
    await firstFlush;
    await store.flush(id);

    expect(store.getView(id).draft?.text).toBe("ab");
    // Only changed fields go: the stored attachments are not resent with each keystroke.
    expect(control.updates.map(({ scope: _scope, ...patch }) => patch)).toEqual([
      { text: "a" },
      { text: "ab" },
    ]);
    expect((await reopen(harness, id, PROJECT_A)).getView(id).draft?.text).toBe("ab");
  });

  test("a failed save keeps the edit, reports it, and retries on reconnect", async () => {
    using tempDir = new TestTempDir("creation-store-save-failure");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "first" });
    await store.flush(id);

    control.failUpdates = 1;
    store.update(id, { text: "keep me" });
    expect(String(await store.flush(id).catch((error: unknown) => error))).toContain(
      "connection lost"
    );
    await waitFor(() => store.getView(id).saveError !== null);
    expect(store.getView(id)).toMatchObject({ unsaved: true, draft: { text: "keep me" } });

    store.setClient(harness.newClient());
    await waitFor(() => !store.getView(id).unsaved);
    expect(store.getView(id).saveError).toBeNull();
    expect((await reopen(harness, id, PROJECT_A)).getView(id).draft?.text).toBe("keep me");
  });

  test("a save or read lost with a replaced connection is retried on the new one", async () => {
    using tempDir = new TestTempDir("creation-store-save-across-reconnect");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    const id = store.create(PROJECT_A, null, { text: "first" });
    await store.flush(id);
    let releaseSave: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    control.failUpdates = 1;
    store.update(id, { text: "typed before the drop" });
    // Send awaits this flush: it resolves once the new connection saved the edit.
    const flushed = store.flush(id);
    store.setClient(harness.newClient());
    releaseSave();
    await flushed;
    expect(store.getView(id)).toMatchObject({ saveError: null, unsaved: false });
    expect((await service.get(id))?.text).toBe("typed before the drop");

    let releaseRead: () => void = () => undefined;
    control.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    control.failReads = 1;
    const reader = new CreationDraftStore();
    reader.setClient(harness.newClient());
    reader.open(id, PROJECT_A);
    reader.setClient(harness.newClient());
    releaseRead();
    await waitFor(() => reader.getView(id).load.status !== "loading");
    expect(reader.getView(id)).toMatchObject({
      load: { status: "ready" },
      draft: { text: "typed before the drop" },
    });
  });

  test("an edit still in its save debounce is saved when the page goes away", async () => {
    using tempDir = new TestTempDir("creation-store-unload");
    const harness = await createHarness(tempDir);
    const { store, service, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "first" });
    await store.flush(id);
    store.update(id, { text: "typed just before reload" });
    const saves = control.updates.length;
    window.dispatchEvent(new window.Event("beforeunload"));
    // Sent at once, not after the debounce.
    expect(control.updates.length).toBe(saves + 1);
    await waitFor(() => !store.getView(id).unsaved);
    expect((await service.get(id))?.text).toBe("typed just before reload");
  });

  test("a failed or timed-out read shows Retry and never an editable blank draft", async () => {
    using tempDir = new TestTempDir("creation-store-read-failure");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null);
    store.update(id, { text: "saved" });
    await store.flush(id);

    control.readError = new Error("offline");
    const failed = await reopen(harness, id, PROJECT_A);
    expect(failed.getView(id)).toMatchObject({ load: { status: "loadFailed" }, draft: null });
    const saves = control.updates.length;
    failed.update(id, { text: "" });
    await failed.flush(id);
    expect(control.updates.length).toBe(saves);

    control.readError = null;
    failed.retryLoad(id);
    await waitFor(() => failed.getView(id).load.status === "ready");
    expect(failed.getView(id).draft?.text).toBe("saved");

    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    jest.useFakeTimers();
    control.readGate = new Promise(() => undefined);
    const hanging = new CreationDraftStore();
    hanging.setClient(harness.newClient());
    hanging.open(id, PROJECT_A);
    fakeTimers.advanceTimersByTime(DRAFT_STORE_READY_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(hanging.getView(id).load.status).toBe("loadFailed");
  });

  test("a list that lands after its timeout keeps a blank draft being typed into", async () => {
    using tempDir = new TestTempDir("creation-store-late-list");
    const harness = await createHarness(tempDir);
    const { service, control } = harness;
    await service.update({
      scope: { kind: "creation", draftId: "older" },
      projectPath: PROJECT_A,
      text: "older",
    });
    let releaseList: () => void = () => undefined;
    control.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    jest.useFakeTimers();
    const store = new CreationDraftStore();
    store.setClient(harness.newClient());
    fakeTimers.advanceTimersByTime(DRAFT_STORE_READY_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getListState().status).toBe("ready");
    jest.useRealTimers();

    const blank = store.draftIdForProject(PROJECT_A);
    store.open(blank, PROJECT_A);
    await waitFor(() => store.getView(blank).load.status === "ready");
    control.updateGate = new Promise(() => undefined);
    store.update(blank, { text: "typing" });
    releaseList();
    await waitFor(() =>
      (store.getDraftsByProject()[PROJECT_A] ?? []).some((draft) => draft.draftId === "older")
    );
    expect(store.draftIdForProject(PROJECT_A)).toBe(blank);
  });

  test("a reconnect keeps the list ready while it refreshes", async () => {
    using tempDir = new TestTempDir("creation-store-reconnect-list");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    await waitFor(() => store.getListState().status === "ready");
    control.listGate = new Promise(() => undefined);
    store.setClient(harness.newClient());
    await Promise.resolve();
    expect(store.getListState().status).toBe("ready");
  });

  test("an absent draft opens blank and its first edit lists it", async () => {
    using tempDir = new TestTempDir("creation-store-absent");
    const harness = await createHarness(tempDir);
    const { store } = harness;
    await waitFor(() => store.getListState().status === "ready");
    store.open("fresh", PROJECT_B);
    await waitFor(() => store.getView("fresh").load.status === "ready");
    expect(store.getView("fresh").draft).toMatchObject({ projectPath: PROJECT_B, text: "" });
    expect(store.getDraftsByProject()[PROJECT_B]).toBeUndefined();

    store.update("fresh", { text: "first edit" });
    await store.flush("fresh");
    expect(store.getDraftsByProject()[PROJECT_B]?.map((draft) => draft.draftId)).toEqual(["fresh"]);
  });

  test("deleting a draft removes its record even when its save reply was lost", async () => {
    using tempDir = new TestTempDir("creation-store-delete-lost-reply");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    control.loseUpdateReplies = 1;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await waitFor(() => store.getView(id).saveError !== null);
    expect(await service.get(id)).not.toBeNull();

    await store.delete(id);
    expect(await service.get(id)).toBeNull();
    expect(store.getView(id).draft).toBeNull();
  });

  test("a failed delete of a sent draft is retried on reconnect (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-retry");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    // The resend deletes only the record it knew: an attachment must not make it look changed.
    store.update(id, { attachments: [image] });
    await store.flush(id);
    control.failDeletes = 1;

    // The connection drops right after the workspace was created.
    await store.delete(id).catch(() => undefined);
    store.setClient(null);
    expect(await service.get(id)).not.toBeNull();

    store.setClient(harness.newClient());
    await waitFor(() => control.listCalls === 2 && store.getListState().status === "ready");
    await waitFor(() => store.getDraftsByProject()[PROJECT_A] === undefined);
    // The new connection deleted the record, so a reloaded window does not list it either.
    expect(await service.get(id)).toBeNull();
  });

  test("a listed draft whose delete keeps failing stays hidden (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-hidden");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = Number.MAX_SAFE_INTEGER;

    await store.delete(id).catch(() => undefined);
    let relisted = false;
    const unsubscribe = store.subscribeList(() => {
      if (control.listCalls === 2) relisted = true;
    });
    store.setClient(harness.newClient());
    // The reconnect's list landed: it still holds the record.
    await waitFor(() => relisted);
    unsubscribe();
    expect(await service.get(id)).not.toBeNull();
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
    expect(store.draftIdForProject(PROJECT_A)).not.toBe(id);
    store.setClient(null);
  });

  test("a new client replaces the backoff retry of a failed delete (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-timer");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = Number.MAX_SAFE_INTEGER;
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    jest.useFakeTimers();

    await store.delete(id);
    store.setClient(harness.newClient());
    await settle();
    expect(control.deleteCalls).toBe(2);
    // Only the new client's retry runs: the old client's timer was cleared.
    fakeTimers.advanceTimersByTime(retryDelayMs(0));
    await settle();
    expect(control.deleteCalls).toBe(3);

    // Disconnecting stops the retries.
    store.setClient(null);
    fakeTimers.advanceTimersByTime(retryDelayMs(10));
    await settle();
    expect(control.deleteCalls).toBe(3);
  });

  test("a delete retry does not remove text another window saved after the failed delete", async () => {
    using tempDir = new TestTempDir("creation-store-delete-retry-other-window");
    const harness = await createHarness(tempDir);
    const { store: windowA, control, service } = harness;
    const id = windowA.create(PROJECT_A, null, { text: "sent" });
    await windowA.flush(id);
    const windowB = await reopen(harness, id, PROJECT_A);
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    jest.useFakeTimers();

    // Window A's Send succeeded, but its delete of the sent draft fails once.
    control.failDeletes = 1;
    await windowA.delete(id);
    expect(control.deleteCalls).toBe(1);
    // The record is still there, so window B's edit saves and is confirmed.
    windowB.update(id, { text: "typed in B" });
    await windowB.flush(id);
    expect((await service.get(id))?.text).toBe("typed in B");

    // Window A's backoff retry fires after B's confirmed save.
    fakeTimers.advanceTimersByTime(retryDelayMs(0));
    await settle();
    jest.useRealTimers();
    await waitFor(() => control.deletesSettled === control.deleteCalls);
    expect((await service.get(id))?.text).toBe("typed in B");
  });

  test("a first delete removes the record whatever it holds (no condition)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-first-try");
    const harness = await createHarness(tempDir);
    const { store: windowA, service } = harness;
    const id = windowA.create(PROJECT_A, null, { text: "sent" });
    await windowA.flush(id);
    // Another window saved after A last saw the record: A's delete still removes it.
    const windowB = await reopen(harness, id, PROJECT_A);
    windowB.update(id, { text: "typed in B" });
    await windowB.flush(id);
    await windowA.delete(id);
    expect(await service.get(id)).toBeNull();

    // A window that never opened a draft (a sidebar Delete) removes it too.
    const other = windowA.create(PROJECT_A, null, { text: "listed" });
    await windowA.flush(other);
    const sidebarWindow = new CreationDraftStore();
    sidebarWindow.setClient(harness.newClient());
    await sidebarWindow.delete(other);
    expect(await service.get(other)).toBeNull();
  });

  test("a delete made while disconnected is still a first delete on reconnect", async () => {
    using tempDir = new TestTempDir("creation-store-delete-offline");
    const harness = await createHarness(tempDir);
    const { store: windowA, service } = harness;
    const id = windowA.create(PROJECT_A, null, { text: "listed" });
    await windowA.flush(id);
    // A window that never opened the draft deletes it while disconnected.
    const sidebarWindow = new CreationDraftStore();
    await sidebarWindow.delete(id);
    expect(await service.get(id)).not.toBeNull();

    sidebarWindow.setClient(harness.newClient());
    await waitFor(() => harness.control.deletesDone === 1);
    expect(await service.get(id)).toBeNull();
  });

  test("a delete retry removes what a save racing the delete wrote (its reply lost)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-racing-save");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    let releaseSave: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    store.update(id, { text: "edited" });
    const saving = store.flush(id).catch(() => undefined);
    await waitFor(() => control.updates.length === 2);
    // The delete waits for the save, which lands but loses its reply. Then the delete fails.
    control.loseUpdateReplies = 1;
    control.failDeletes = 1;
    const deleting = store.delete(id);
    releaseSave();
    await Promise.all([saving, deleting]);
    expect((await service.get(id))?.text).toBe("edited");

    store.setClient(harness.newClient());
    await waitFor(() => control.deleteCalls === 2 && control.deletesSettled === 2);
    expect(await service.get(id)).toBeNull();
  });

  test("a delete resent on reconnect does not remove settings another window saved meanwhile", async () => {
    using tempDir = new TestTempDir("creation-store-delete-resend-other-window");
    const harness = await createHarness(tempDir);
    const { store: windowA, control, service } = harness;
    const id = windowA.create(PROJECT_A, null, { text: "sent" });
    await windowA.flush(id);
    const windowB = await reopen(harness, id, PROJECT_A);

    // Window A's delete fails, and its connection drops before the backoff retry.
    control.failDeletes = 1;
    await windowA.delete(id);
    windowA.setClient(null);
    // Window B changes a field other than the text, and its save is confirmed.
    windowB.update(id, { manualName: "named-in-b" });
    await windowB.flush(id);

    windowA.setClient(harness.newClient());
    await waitFor(() => control.deleteCalls === 2 && control.deletesSettled === 2);
    expect((await service.get(id))?.manualName).toBe("named-in-b");
  });

  test("a list that lands while a deleted draft's save runs does not show it (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-during-save");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = Number.MAX_SAFE_INTEGER;
    let releaseSave: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    store.update(id, { text: "sent!" });
    const saving = store.flush(id).catch(() => undefined);
    await waitFor(() => control.updates.length === 2);

    const deleting = store.delete(id);
    store.setClient(harness.newClient());
    await waitFor(() => control.listCalls === 2 && store.getListState().status === "ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
    releaseSave();
    await Promise.all([saving, deleting]);
    store.setClient(null);
  });

  test("a reconnect does not delete before the save the delete waits for (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-reconnect-save");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    let releaseSave: () => void = () => undefined;
    control.updateGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const id = store.create(PROJECT_A, null, { text: "sent" });
    const saving = store.flush(id);
    await waitFor(() => control.updates.length === 1);

    const deleting = store.delete(id);
    store.setClient(harness.newClient());
    await waitFor(() => control.listCalls === 2 && store.getListState().status === "ready");
    releaseSave();
    await Promise.all([saving, deleting]);

    expect(await service.get(id)).toBeNull();
  });

  test("a list read before a delete succeeds does not show the draft (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-stale-list");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = 1;
    await store.delete(id);

    let releaseList: () => void = () => undefined;
    control.listReplyGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    store.setClient(harness.newClient());
    // The new list read the record, then the resent delete removed it.
    await waitFor(() => control.listCalls === 2 && control.deletesDone === 1);
    releaseList();
    await waitFor(() => store.getListState().status === "ready");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
  });

  test("reopening a draft whose delete failed gives a blank draft (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-reopen");
    const harness = await createHarness(tempDir);
    const { store, control, service } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = 1;
    await store.delete(id);

    store.open(id, PROJECT_A);
    expect(store.getView(id).load.status).toBe("ready");
    expect(store.getView(id).draft?.text).toBe("");
    store.setClient(harness.newClient());
    await waitFor(() => control.deletesDone === 1 && store.getListState().status === "ready");
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
    expect(await service.get(id)).toBeNull();
  });

  test("an edit to a reopened deleted draft saves whole and stays out of the list (#7551)", async () => {
    using tempDir = new TestTempDir("creation-store-delete-reopen-edit");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { text: "sent" });
    await store.flush(id);
    control.failDeletes = 1;
    await store.delete(id);
    store.open(id, PROJECT_A);
    await waitFor(() => store.getView(id).load.status === "ready");
    store.update(id, { text: "typed after" });
    store.setClient(harness.newClient());
    await waitFor(() => control.deletesDone === 1);

    // The retry removed the record before this save: a patch of changed fields would be refused.
    await store.flush(id);
    expect(store.getView(id).saveError).toBeNull();
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
    store.setClient(harness.newClient());
    await waitFor(() => control.listCalls === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getDraftsByProject()[PROJECT_A]).toBeUndefined();
  });
  test("after a bare project page's draft is sent, the page opens a new blank draft", async () => {
    using tempDir = new TestTempDir("creation-store-sent-blank");
    const harness = await createHarness(tempDir);
    const { store } = harness;
    await waitFor(() => store.getListState().status === "ready");
    const id = store.draftIdForProject(PROJECT_A);
    store.open(id, PROJECT_A);
    await waitFor(() => store.getView(id).load.status === "ready");
    store.update(id, { text: "sent" });
    await store.flush(id);

    await store.delete(id);
    expect(store.draftIdForProject(PROJECT_A)).not.toBe(id);
  });

  test("imports old browser drafts before listing, and keeps the keys of a failed import", async () => {
    using tempDir = new TestTempDir("creation-store-legacy-import");
    const named = getDraftScopeId(PROJECT_A, "named");
    const filled = getDraftScopeId(PROJECT_A, "filled");
    const failing = getDraftScopeId(PROJECT_B, "failing");
    window.localStorage.setItem(
      getWorkspaceNameStateKey(named),
      JSON.stringify({ autoGenerate: false, manualName: "typed-name" })
    );
    window.localStorage.setItem(getInputKey(filled), JSON.stringify("older text"));
    window.localStorage.setItem(getInputKey(failing), JSON.stringify("not imported yet"));
    // The oldest builds' localStorage list row: where the draft targets, and when it was made.
    window.localStorage.setItem(
      WORKSPACE_DRAFTS_BY_PROJECT_KEY,
      JSON.stringify({
        [PROJECT_A]: [{ draftId: "named", subProjectPath: `${PROJECT_A}/sub`, createdAt: 5 }],
      })
    );
    const harness = await createHarness(tempDir, {
      failLegacyImport: "failing",
      seed: async (config) => {
        // The backend already imported this scope's old body: its record keeps that text.
        await new CreationDraftService(config).update({
          scope: { kind: "creation", draftId: creationDraftImportId(PROJECT_A, "filled") },
          projectPath: PROJECT_A,
          text: "newer text",
        });
      },
    });
    const { store, service } = harness;
    await waitFor(() => store.getListState().status === "ready");

    const namedId = creationDraftImportId(PROJECT_A, "named");
    expect(await service.get(namedId)).toMatchObject({
      manualName: "typed-name",
      subProjectPath: `${PROJECT_A}/sub`,
      createdAt: 5,
    });
    expect(store.getDraftsByProject()[PROJECT_A]?.map((draft) => draft.draftId)).toContain(namedId);
    expect(window.localStorage.getItem(getWorkspaceNameStateKey(named))).toBeNull();
    expect((await service.get(creationDraftImportId(PROJECT_A, "filled")))?.text).toBe(
      "newer text"
    );
    expect(window.localStorage.getItem(getInputKey(filled))).toBeNull();
    // A failed import keeps its keys, and the list rows, for the next start.
    expect(window.localStorage.getItem(getInputKey(failing))).not.toBeNull();
    expect(window.localStorage.getItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY)).not.toBeNull();
  });
});
