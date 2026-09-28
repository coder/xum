import * as fs from "fs/promises";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  getPendingScopeId,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import type { DraftAttachment, DraftEvent, DraftScope } from "@/common/orpc/schemas/drafts";
import { MAX_DRAFT_JSON_CHARS } from "@/constants/drafts";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { DraftService } from "@/node/services/draftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { DraftStore } from "./DraftStore";

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
    updateGate: null as Promise<void> | null,
    updates: 0,
  };
  const drafts = {
    list: () => service.list(),
    get: ({ scope }: { scope: DraftScope }) => service.get(scope),
    update: async (input: Parameters<DraftService["update"]>[0]) => {
      control.updates++;
      await control.updateGate;
      if (control.failUpdates > 0) {
        control.failUpdates--;
        throw new Error("update failed");
      }
      return service.update(input);
    },
    delete: ({ scope }: { scope: DraftScope }) => service.delete(scope),
    importLegacy: async (input: Parameters<DraftService["importLegacy"]>[0]) => {
      if (control.failImports > 0) {
        control.failImports--;
        throw new Error("import failed");
      }
      return service.importLegacy(input);
    },
    subscribe: async (_input: void, opts?: { signal?: AbortSignal }) => {
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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
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
    store.subscribeSaveErrors((_scopeKey, message) => errors.push(message));

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
});
