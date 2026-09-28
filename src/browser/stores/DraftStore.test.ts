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
  getModelKey,
  getPendingScopeId,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import type { DraftAttachment, DraftEvent, DraftScope } from "@/common/orpc/schemas/drafts";
import { DRAFT_STORE_READY_TIMEOUT_MS, MAX_DRAFT_JSON_CHARS } from "@/constants/drafts";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { DraftService } from "@/node/services/draftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { getComposerDraftScope } from "@/browser/features/ChatInput/useComposerDraft";
import { QuotaLimitedStorage } from "../../../tests/ui/quotaLimitedStorage";
import { DraftStore, draftStoreScopeKey } from "./DraftStore";

const WS = "draft-store-ws";
const WS_SCOPE: DraftScope = { kind: "workspace", workspaceId: WS };

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
    updateGate: null as Promise<void> | null,
    getGate: null as Promise<void> | null,
    subscribeGate: null as Promise<void> | null,
    updates: 0,
  };
  const drafts = {
    list: () => service.list(),
    get: async ({ scope }: { scope: DraftScope }) => {
      await control.getGate;
      return service.get(scope);
    },
    update: async (input: Parameters<DraftService["update"]>[0]) => {
      control.updates++;
      await control.updateGate;
      if (control.failUpdates > 0) {
        control.failUpdates--;
        throw new Error("update failed");
      }
      return service.update(input);
    },
    delete: async ({ scope }: { scope: DraftScope }) => {
      if (control.failDeletes > 0) {
        control.failDeletes--;
        throw new Error("delete failed");
      }
      return service.delete(scope);
    },
    importLegacy: async (input: Parameters<DraftService["importLegacy"]>[0]) => {
      if (control.failImports > 0) {
        control.failImports--;
        throw new Error("import failed");
      }
      return service.importLegacy(input);
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
    updatePersistedState(getInputKey(WS), "stale local copy");
    updatePersistedState(getInputKey(creationScopeId), "legacy creation text");
    updatePersistedState(getInputAttachmentsKey(creationScopeId), [image]);
    updatePersistedState(getInputKey(getPendingScopeId(projectPath)), "pending text");
    // Scope-bound settings of the pending composer follow its draft, like createWorkspaceDraft.
    updatePersistedState(getModelKey(getPendingScopeId(projectPath)), "pending-model");

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
    // The pending draft became a listed creation draft of its project, still visible.
    const listed = readPersistedState<Record<string, Array<{ draftId: string }>>>(
      WORKSPACE_DRAFTS_BY_PROJECT_KEY,
      {}
    )[projectPath];
    expect(listed).toHaveLength(1);
    const converted: DraftScope = { kind: "creation", projectPath, draftId: listed[0].draftId };
    expect((await service.get(converted)).text).toBe("pending text");
    expect(listPersistedKeys("input")).toEqual([]);
    expect(
      readPersistedState<string | null>(
        getModelKey(getDraftScopeId(projectPath, listed[0].draftId)),
        null
      )
    ).toBe("pending-model");
    expect(
      readPersistedState<string | null>(getModelKey(getPendingScopeId(projectPath)), null)
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
      url: `data:image/png;base64,${"A".repeat(MAX_DRAFT_JSON_CHARS)}`,
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

  test("keeps the legacy pending draft reachable when the draft list cannot be written", async () => {
    using tempDir = new TestTempDir("draft-store-legacy-quota");
    const { projectPath, service, client } = await createHarness(tempDir);
    const inputKey = getInputKey(getPendingScopeId(projectPath));
    const attachmentsKey = getInputAttachmentsKey(getPendingScopeId(projectPath));
    const inputValue = JSON.stringify("pending text");
    // A full origin: the legacy keys fit, the draft list entry never does.
    const full = new QuotaLimitedStorage(inputKey.length + inputValue.length + 16);
    full.seed(inputKey, inputValue);
    full.seed(attachmentsKey, JSON.stringify([image]));
    Object.defineProperty(window, "localStorage", { configurable: true, value: full });

    const first = createStore(client);
    await first.whenReady();
    first.setClient(null);
    // The backend holds the draft, but only the legacy key can lead a composer to it.
    expect(full.getItem(inputKey)).toBe(inputValue);

    const roomy = new QuotaLimitedStorage(1_000_000);
    for (let index = 0; index < full.length; index++) {
      const key = full.key(index)!;
      roomy.seed(key, full.getItem(key)!);
    }
    Object.defineProperty(window, "localStorage", { configurable: true, value: roomy });
    const second = createStore(client);
    await second.whenReady();

    const listed = readPersistedState<Record<string, Array<{ draftId: string }>>>(
      WORKSPACE_DRAFTS_BY_PROJECT_KEY,
      {}
    )[projectPath];
    expect(listed).toHaveLength(1);
    // The retry re-imports into the same draft instead of adding a second one.
    const creationDrafts = (await service.list()).filter(({ scope }) => scope.kind === "creation");
    expect(creationDrafts.map(({ scope }) => scope)).toEqual([
      { kind: "creation", projectPath, draftId: listed[0].draftId },
    ]);
    expect((await service.get(creationDrafts[0].scope)).attachments).toEqual([image]);
    expect(roomy.getItem(inputKey)).toBeNull();
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
    updatePersistedState(getInputKey(workspaceId), "underscored");

    const store = createStore(client);
    await store.whenReady();
    expect((await service.get({ kind: "workspace", workspaceId })).text).toBe("underscored");
  });

  test("moves a draft only after the destination is saved", async () => {
    using tempDir = new TestTempDir("draft-store-move");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.update({ scope: source, text: "moving" });
    const store = createStore(client);
    await store.whenReady();

    control.failUpdates = 100;
    await store.moveDraft(source, WS_SCOPE);
    // A delete issued before the destination was saved would have landed by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await service.get(source)).text).toBe("moving");

    control.failUpdates = 0;
    await store.moveDraft(source, WS_SCOPE);
    expect((await service.get(WS_SCOPE)).text).toBe("moving");
    expect((await service.get(source)).text).toBe("");
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
    updatePersistedState(getInputKey(WS), "pre-upgrade");

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

  test("keeps the source of a move that was edited while its payloads loaded", async () => {
    using tempDir = new TestTempDir("draft-store-move-edit");
    const { projectPath, service, client, control } = await createHarness(tempDir);
    const source: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.update({ scope: source, text: "moving", attachments: [image] });
    const store = createStore(client);
    await store.whenReady();

    let release: () => void = () => undefined;
    control.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moved = store.moveDraft(source, WS_SCOPE);
    store.setText(source, "moving, edited");
    release();
    await moved;

    expect(store.getText(source)).toBe("moving, edited");
    await store.flush(source);
    expect((await service.get(source)).text).toBe("moving, edited");
  });

  // The project page opened without a draft id: its text survived a reload in localStorage before
  // drafts moved to the backend. When the first listed draft is created it takes over the text
  // and the attachments, even ones whose payloads have not loaded yet.
  test("saves the default creation composer's draft and moves it, attachments included", async () => {
    using tempDir = new TestTempDir("draft-store-default-creation");
    const { projectPath, service, client } = await createHarness(tempDir);
    const scope = getComposerDraftScope({
      variant: "creation",
      workspaceId: null,
      creationProjectPath: projectPath,
    });
    const first = createStore(client);
    await first.whenReady();
    first.setText(scope, "typed before reload");
    first.setAttachments(scope, [image]);
    await first.flush(scope);
    first.setClient(null);

    // Reload: a new store hydrates from the backend.
    const store = createStore(client);
    await store.whenReady();
    expect(store.getView(scope)).toMatchObject({
      text: "typed before reload",
      attachmentCount: 1,
      payloadsLoaded: false,
    });

    const listed: DraftScope = { kind: "creation", projectPath, draftId: "first-listed" };
    await store.moveDraft(scope, listed);
    expect(await service.get(listed)).toMatchObject({
      text: "typed before reload",
      attachments: [image],
    });
    expect(
      (await service.list()).some(
        (draft) => draftStoreScopeKey(draft.scope) === draftStoreScopeKey(scope)
      )
    ).toBe(false);
  });
});
