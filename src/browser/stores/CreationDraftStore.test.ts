import * as path from "path";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import type {
  CreationDraftImportLegacyInput,
  CreationDraftScope,
  CreationDraftUpdateInput,
  DraftAttachment,
} from "@/common/orpc/schemas/drafts";
import { getDraftScopeId, getInputKey, getWorkspaceNameStateKey } from "@/common/constants/storage";
import { DRAFT_STORE_READY_TIMEOUT_MS } from "@/constants/drafts";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { CreationDraftService, creationDraftImportId } from "@/node/services/creationDraftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { CreationDraftStore } from "./CreationDraftStore";

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
    readGate: Promise.resolve(),
  };
  const drafts = {
    listCreation: () => service.list(),
    getCreation: async ({ scope }: { scope: CreationDraftScope }) => {
      await control.readGate;
      if (control.readError) throw control.readError;
      return service.get(scope.draftId);
    },
    updateCreation: async (input: CreationDraftUpdateInput) => {
      control.updates.push(input);
      await control.updateGate;
      if (control.failUpdates > 0) {
        control.failUpdates--;
        throw new Error("connection lost");
      }
      const reply = await service.update(input);
      if (control.loseUpdateReplies > 0) {
        control.loseUpdateReplies--;
        throw new Error("connection lost");
      }
      return reply;
    },
    deleteCreation: ({ scope }: { scope: CreationDraftScope }) => service.delete(scope.draftId),
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

  test("an earlier save reply never replaces a later local edit", async () => {
    using tempDir = new TestTempDir("creation-store-order");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { persist: true });
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
    const id = store.create(PROJECT_A, null, { persist: true });
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

  test("a failed or timed-out read shows Retry and never an editable blank draft", async () => {
    using tempDir = new TestTempDir("creation-store-read-failure");
    const harness = await createHarness(tempDir);
    const { store, control } = harness;
    const id = store.create(PROJECT_A, null, { persist: true });
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
    expect((await service.get(namedId))?.manualName).toBe("typed-name");
    expect(store.getDraftsByProject()[PROJECT_A]?.map((draft) => draft.draftId)).toContain(namedId);
    expect(window.localStorage.getItem(getWorkspaceNameStateKey(named))).toBeNull();
    expect((await service.get(creationDraftImportId(PROJECT_A, "filled")))?.text).toBe(
      "newer text"
    );
    expect(window.localStorage.getItem(getInputKey(filled))).toBeNull();
    // A failed import keeps its keys for the next start.
    expect(window.localStorage.getItem(getInputKey(failing))).not.toBeNull();
  });
});
