/**
 * DraftStore's idempotent-send coordinator (formal/composer-drafts/ComposerSends.tla, FixRenderer):
 * resolution, automatic retries, Stop, and two windows. The drafts are a real DraftService (real
 * files) and resolution is the real drafts.resolveSends; only the receiver (getSendStatus and
 * sendMessage) is scripted.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftAttachment, DraftEvent, PendingSend } from "@/common/orpc/schemas/drafts";
import type { FilePart } from "@/common/orpc/types";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { Config } from "@/node/config";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { DraftService } from "@/node/services/draftService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { resolveDraftSends } from "@/node/services/draftSendResolution";
import type { WorkspaceService } from "@/node/services/workspaceService";
// eslint-disable-next-line local/no-cross-boundary-imports -- test-only: the store runs against the real backend service
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { installDom } from "../../../tests/ui/dom";
import { DraftStore } from "./DraftStore";

const WS = "send-ids-ws";
const SCOPE = { kind: "workspace" as const, workspaceId: WS };
const RECEIVER = "receiver-now";

const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

type Status = "accepted" | "pending" | "not-accepted" | "unknown";

/**
 * A receiver with getSendStatus's contract: a row (`accepted`) or `pending` wins; otherwise this
 * receiver answers "not accepted" for its own ids and "unknown" for another receiver's.
 */
function createReceiver() {
  const control = {
    statuses: new Map<string, Status>(),
    failLookups: false,
    lookups: 0,
    sends: [] as Array<{ message: string; sendId?: string; fileParts?: FilePart[] }>,
  };
  const getSendStatus = (_workspaceId: string, sendIds: readonly string[], asked?: string) => {
    control.lookups++;
    if (control.failLookups) return Promise.resolve({ success: false as const, error: "down" });
    return Promise.resolve({
      success: true as const,
      data: {
        receiverId: RECEIVER,
        statuses: sendIds.map((sendId) => ({
          sendId,
          status:
            control.statuses.get(sendId) ??
            (asked == null || asked === RECEIVER ? "not-accepted" : "unknown"),
        })),
      },
    });
  };
  const workspaceService = { getSendStatus } as unknown as WorkspaceService;
  return { control, workspaceService, getSendStatus };
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
  const receiver = createReceiver();
  const drafts = {
    list: () => service.list(),
    get: ({ scope }: { scope: typeof SCOPE }) => service.get(scope),
    update: (input: Parameters<DraftService["update"]>[0]) => service.update(input),
    beginSend: (input: Parameters<DraftService["beginSend"]>[0]) => service.beginSend(input),
    setSendReceiver: (input: Parameters<DraftService["setSendReceiver"]>[0]) =>
      service.setSendReceiver(input),
    resolveSends: (input: Parameters<typeof resolveDraftSends>[1]) =>
      resolveDraftSends(
        { draftService: service, workspaceService: receiver.workspaceService },
        input
      ),
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
  const workspace = {
    getSendStatus: ({
      workspaceId,
      sendIds,
      receiverId,
    }: {
      workspaceId: string;
      sendIds: string[];
      receiverId?: string;
    }) => receiver.getSendStatus(workspaceId, sendIds, receiverId),
    sendMessage: ({
      message,
      options,
    }: {
      message: string;
      options: { sendId?: string; fileParts?: FilePart[] };
    }) => {
      receiver.control.sends.push({
        message,
        sendId: options.sendId,
        fileParts: options.fileParts,
      });
      // The re-send reached this receiver: it appends the row.
      if (options.sendId) receiver.control.statuses.set(options.sendId, "accepted");
      return Promise.resolve({ success: true as const, data: {} });
    },
  };
  const client = createTestApiClient({ drafts, workspace } as never);
  return { service, client, receiver: receiver.control };
}

function pendingSend(sendId: string, text: string, receiverId: string, ids: string[] = []) {
  const send: PendingSend = {
    sendId,
    receiverId,
    text,
    attachmentIds: ids,
    request: {
      message: `${text} (as sent)`,
      options: { model: "openai:gpt-5.2", agentId: "exec", muxMetadata: { type: "normal" } },
    },
  };
  return send;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const RETRY_DELAY_MS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanupDom: (() => void) | undefined;
const stores: DraftStore[] = [];

function createStore(client: Awaited<ReturnType<typeof createHarness>>["client"]): DraftStore {
  // Short retry delays with real timers: the backoff schedule itself is not under test here.
  const store = new DraftStore({ sendRetryDelayMs: () => RETRY_DELAY_MS });
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

describe("DraftStore idempotent sends", () => {
  test("re-sends an unknown send to the current receiver with its id and exact request", async () => {
    using tempDir = new TestTempDir("draft-sends-retry");
    const { service, client, receiver } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, attachments: [image] });
    // Written before a restart: its receiver is gone, so the answer is "unknown".
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", "receiver-old", ["img-1"]),
      attachments: [image],
    });

    const store = createStore(client);
    await store.whenReady();
    await waitFor(() => store.getView(SCOPE).unresolvedSendCount === 1);
    // The composer hides what the send retains meanwhile.
    expect([store.getText(SCOPE), store.getView(SCOPE).attachmentCount]).toEqual(["", 0]);

    await waitFor(() => receiver.sends.length === 1);
    expect(receiver.sends[0]).toEqual({
      message: "hello (as sent)",
      sendId: "s1",
      fileParts: [{ url: image.url, mediaType: image.mediaType }],
    });
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    expect((await service.get(SCOPE)).attachments).toEqual([]);
    await waitFor(() => store.getView(SCOPE).unresolvedSendCount === 0);
  });

  test("Stop aborts automatic retries; the entry keeps its text and the sending state", async () => {
    using tempDir = new TestTempDir("draft-sends-stop");
    const { service, client, receiver } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", "receiver-old"),
      attachments: [],
    });
    const store = createStore(client);
    await store.whenReady();
    await waitFor(() => store.getView(SCOPE).unresolvedSendCount === 1);
    store.abortSendRetries(WS);
    // A chat event after the Stop looks the send up but does not re-arm re-sends.
    store.onSendEvent(WS);
    // Many retry delays later: nothing was re-sent.
    await sleep(40 * RETRY_DELAY_MS);
    expect(receiver.sends).toEqual([]);
    expect(store.getView(SCOPE).unresolvedSendCount).toBe(1);
    expect((await service.get(SCOPE)).pendingSends?.map(({ sendId }) => sendId)).toEqual(["s1"]);

    // A reconnect re-arms them.
    store.setClient(null);
    store.setClient(client);
    await waitFor(() => receiver.sends.length === 1);
  });

  test("bounded retries end with the entry preserved until the next trigger", async () => {
    using tempDir = new TestTempDir("draft-sends-bounded");
    const { service, client, receiver } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER),
      attachments: [],
    });
    receiver.failLookups = true;
    const store = createStore(client);
    await store.whenReady();
    // The first lookup plus five automatic retries, then none.
    await waitFor(() => receiver.lookups === 6);
    await sleep(40 * RETRY_DELAY_MS);
    expect(receiver.lookups).toBe(6);
    // The entry keeps its text and id, and the composer stays sending.
    expect(store.getView(SCOPE).unresolvedSendCount).toBe(1);
    expect((await service.get(SCOPE)).pendingSends?.map(({ sendId }) => sendId)).toEqual(["s1"]);

    // A trigger (here a chat event) starts a new batch; the receiver is back.
    receiver.failLookups = false;
    store.onSendEvent(WS);
    await waitFor(() => store.getText(SCOPE) === "hello");
    expect(receiver.lookups).toBe(7);
    expect(store.getView(SCOPE).unresolvedSendCount).toBe(0);
  });

  test("two windows resolving at once show a not-accepted send once", async () => {
    using tempDir = new TestTempDir("draft-sends-two-windows");
    const { service, client } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "visible" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER),
      attachments: [],
    });
    const first = createStore(client);
    const second = createStore(client);
    await Promise.all([first.whenReady(), second.whenReady()]);
    first.triggerSendResolution(WS);
    second.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    await waitFor(() => first.getText(SCOPE) !== "visible" && second.getText(SCOPE) !== "visible");
    expect([first.getText(SCOPE), second.getText(SCOPE)]).toEqual([
      "hello\n\nvisible",
      "hello\n\nvisible",
    ]);
    expect((await service.get(SCOPE)).text).toBe("hello\n\nvisible");
  });

  test("a window with unsaved text puts a not-accepted send back into it once", async () => {
    using tempDir = new TestTempDir("draft-sends-dirty");
    const { service, client } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER),
      attachments: [],
    });
    const typing = createStore(client);
    const other = createStore(client);
    await Promise.all([typing.whenReady(), other.whenReady()]);
    // Typed in one window, not saved yet; the other window resolves the send.
    typing.setText(SCOPE, "typed meanwhile");
    other.triggerSendResolution(WS);
    await waitFor(() => typing.getText(SCOPE) === "hello\n\ntyped meanwhile");
    await typing.flush(SCOPE);
    expect((await service.get(SCOPE)).text).toBe("hello\n\ntyped meanwhile");
    await waitFor(() => other.getText(SCOPE) === "hello\n\ntyped meanwhile");
  });
});
