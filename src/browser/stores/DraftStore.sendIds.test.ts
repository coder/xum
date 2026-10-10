/**
 * DraftStore's idempotent-send coordinator: resolution, automatic retries, Stop, and two windows.
 * The drafts are a real DraftService (real files) and resolution is the real drafts.resolveSends;
 * only the receiver (getSendStatus and sendMessage) is scripted.
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
    /** Ids this receiver answered "not accepted": a later arrival is refused (the fence). */
    refused: new Set<string>(),
  };
  const getSendStatus = (_workspaceId: string, sendIds: readonly string[], asked?: string) => {
    control.lookups++;
    if (control.failLookups) return Promise.resolve({ success: false as const, error: "down" });
    const statusOf = (sendId: string): Status => {
      const known = control.statuses.get(sendId);
      if (known) return known;
      if (asked != null && asked !== RECEIVER) return "unknown";
      control.refused.add(sendId);
      return "not-accepted";
    };
    return Promise.resolve({
      success: true as const,
      data: {
        receiverId: RECEIVER,
        statuses: sendIds.map((sendId) => ({ sendId, status: statusOf(sendId) })),
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
  // The backend's passive acceptance check (a durable row): no refusal side effect.
  const acceptance = {
    acceptedSendIds: (_workspaceId: string, ids: readonly string[]) =>
      Promise.resolve(
        new Set(ids.filter((id) => receiver.control.statuses.get(id) === "accepted"))
      ),
  };
  /** Test hooks around the transport: hold an update, or lose a beginSend reply. */
  const hooks = {
    beforeUpdate: null as null | (() => Promise<void>),
    loseBeginSendReply: false,
  };
  const drafts = {
    list: () => service.list(),
    get: ({ scope }: { scope: typeof SCOPE }) => service.get(scope),
    update: async (input: Parameters<DraftService["update"]>[0]) => {
      const hold = hooks.beforeUpdate;
      hooks.beforeUpdate = null;
      await hold?.();
      return service.update(input, acceptance);
    },
    beginSend: async (input: Parameters<DraftService["beginSend"]>[0]) => {
      const reply = await service.beginSend(input, acceptance);
      if (hooks.loseBeginSendReply) {
        hooks.loseBeginSendReply = false;
        throw new Error("beginSend reply lost");
      }
      return reply;
    },
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
  /** Hold a sendMessage before the receiver processes it (an in-flight request). */
  const receiverHooks = { beforeArrival: null as null | (() => Promise<void>) };
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
    sendMessage: async ({
      message,
      options,
    }: {
      message: string;
      options: { sendId?: string; fileParts?: FilePart[] };
    }) => {
      const arrive = receiverHooks.beforeArrival;
      receiverHooks.beforeArrival = null;
      await arrive?.();
      // A fenced id is refused on arrival: no work starts for it.
      if (options.sendId && receiver.control.refused.has(options.sendId)) {
        return { success: false as const, error: { type: "unknown" as const, raw: "refused" } };
      }
      receiver.control.sends.push({
        message,
        sendId: options.sendId,
        fileParts: options.fileParts,
      });
      // The re-send reached this receiver: it appends the row.
      if (options.sendId) receiver.control.statuses.set(options.sendId, "accepted");
      return { success: true as const, data: {} };
    },
  };
  const client = createTestApiClient({ drafts, workspace } as never);
  return { service, client, receiver: receiver.control, hooks, receiverHooks };
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
    await store.abortSendRetries(WS);
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

  /** A window types `unsaved` (not saved) while another window resolves the send "hello" as not accepted. */
  async function returnBesideUnsavedText(unsaved: string) {
    using tempDir = new TestTempDir("draft-sends-dirty-contains");
    const { service, client } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER),
      attachments: [],
    });
    const typing = createStore(client);
    const other = createStore(client);
    await Promise.all([typing.whenReady(), other.whenReady()]);
    typing.setText(SCOPE, unsaved);
    other.triggerSendResolution(WS);
    await waitFor(() => typing.getPendingSendIds(SCOPE).size === 0);
    expect(typing.getText(SCOPE)).toBe(unsaved);
    await typing.flush(SCOPE);
    return (await service.get(SCOPE)).text;
  }

  test("unsaved text that still holds a not-accepted send's text does not get it twice", async () => {
    // The sent text typed again as its own block, then more.
    expect(await returnBesideUnsavedText("hello\n\nworld")).toBe("hello\n\nworld");
  });

  // #5567: only a whole block counts as the send's text. A line that merely starts with it is
  // the user's own text, so the returned send comes back beside it instead of being dropped.
  test("a not-accepted send comes back beside unsaved text that only starts with its text", async () => {
    expect(await returnBesideUnsavedText("hello world")).toBe("hello\n\nhello world");
  });

  test("a not-accepted send's attachment survives a window whose unsaved list lacks it", async () => {
    using tempDir = new TestTempDir("draft-sends-dirty-attachments");
    const { service, client } = await createHarness(tempDir);
    const typing = createStore(client);
    await typing.whenReady();
    // Attached here, not saved yet, before another window sent `image` (so this list lacks it).
    const other: DraftAttachment = { ...image, id: "img-2", url: "data:image/png;base64,AAAA" };
    typing.setAttachments(SCOPE, [other]);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "", RECEIVER, ["img-1"]),
      attachments: [image],
    });
    const resolver = createStore(client);
    await resolver.whenReady();
    resolver.triggerSendResolution(WS);
    await waitFor(() => typing.getPendingSendIds(SCOPE).size === 0);
    await typing.flush(SCOPE);
    expect((await service.get(SCOPE)).attachments.map(({ id }) => id)).toEqual(["img-1", "img-2"]);
    // The backend's merged list reaches this window (its payloads load on demand).
    await typing.ensurePayloads(SCOPE);
    expect(typing.getAttachments(SCOPE).map(({ id }) => id)).toEqual(["img-1", "img-2"]);
  });

  test("an accepted send's attachment does not come back in a window with unsaved attachments", async () => {
    using tempDir = new TestTempDir("draft-sends-accepted-dirty-attachments");
    const { service, client, receiver } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER, ["img-1"]),
      attachments: [image],
    });
    receiver.statuses.set("s1", "accepted");
    const typing = createStore(client);
    await typing.whenReady();
    await typing.ensurePayloads(SCOPE);
    // Attached here, not saved yet; the other window resolves the send as accepted.
    const other: DraftAttachment = { ...image, id: "img-2", url: "data:image/png;base64,AAAA" };
    typing.setAttachments(SCOPE, [other]);
    const resolver = createStore(client);
    await resolver.whenReady();
    resolver.triggerSendResolution(WS);
    await waitFor(() => typing.getPendingSendIds(SCOPE).size === 0);
    expect(typing.getAttachments(SCOPE).map(({ id }) => id)).toEqual(["img-2"]);
    await typing.flush(SCOPE);
    expect((await service.get(SCOPE)).attachments.map(({ id }) => id)).toEqual(["img-2"]);
  });

  test("a send another window resolved first settles with the backend's answer", async () => {
    using tempDir = new TestTempDir("draft-sends-settle-elsewhere");
    const { service, client, receiver } = await createHarness(tempDir);
    const sender = createStore(client);
    const other = createStore(client);
    await Promise.all([sender.whenReady(), other.whenReady()]);
    const request = pendingSend("s1", "hello", RECEIVER).request;
    await sender.beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request });
    // The send is accepted, its reply is lost, and the other window resolves it first.
    receiver.statuses.set("s1", "accepted");
    other.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    await waitFor(() => sender.getPendingSendIds(SCOPE).size === 0);
    expect(await sender.settleSend(SCOPE, "s1")).toBe("accepted");
  });

  // Regression tests for the backend-only merge of send results (#5547 round 3).
  const image2: DraftAttachment = { ...image, id: "img-2", url: "data:image/png;base64,AAAA" };

  async function reconnectAfterOtherWindowResolves(status: "accepted" | "not-accepted") {
    using tempDir = new TestTempDir(`draft-sends-reconnect-${status}`);
    const { service, client, receiver } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER, ["img-1"]),
      attachments: [image],
    });
    // Still queued at the receiver while both windows load (their lookups keep it pending).
    receiver.statuses.set("s1", "pending");
    const offline = createStore(client);
    const other = createStore(client);
    await Promise.all([offline.whenReady(), other.whenReady()]);
    await offline.ensurePayloads(SCOPE);
    // Unsaved text and attachments, then the connection drops: this window misses the result.
    offline.setText(SCOPE, "typed A");
    offline.setAttachments(SCOPE, [image2]);
    offline.setClient(null);
    // Then it is accepted, or Stop returns it (not accepted).
    if (status === "accepted") receiver.statuses.set("s1", "accepted");
    else receiver.statuses.delete("s1");
    other.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    offline.setClient(client);
    await waitFor(() => offline.getPendingSendIds(SCOPE).size === 0);
    await offline.flush(SCOPE);
    // This window's unsaved text has reached the backend.
    await waitFor(async () => (await service.get(SCOPE)).text.endsWith("typed A"));
    await offline.flush(SCOPE);
    return { stored: await service.get(SCOPE), offline };
  }

  test("a window that reconnects with unsaved edits keeps a returned send's text and attachments", async () => {
    const { stored, offline } = await reconnectAfterOtherWindowResolves("not-accepted");
    expect([stored.text, stored.attachments.map(({ id }) => id)]).toEqual([
      "hello\n\ntyped A",
      ["img-1", "img-2"],
    ]);
    await waitFor(() => offline.getText(SCOPE) === "hello\n\ntyped A");
  });

  test("a window that reconnects with unsaved edits does not bring an accepted send back", async () => {
    const { stored, offline } = await reconnectAfterOtherWindowResolves("accepted");
    expect([stored.text, stored.attachments.map(({ id }) => id)]).toEqual(["typed A", ["img-2"]]);
    expect(offline.getAttachments(SCOPE).map(({ id }) => id)).toEqual(["img-2"]);
  });

  test("a beginSend whose reply is lost after it committed leaves the text once", async () => {
    using tempDir = new TestTempDir("draft-sends-begin-lost");
    const { service, client, hooks } = await createHarness(tempDir);
    const sender = createStore(client);
    await sender.whenReady();
    sender.setText(SCOPE, "hello");
    hooks.loseBeginSendReply = true;
    const request = pendingSend("s1", "hello", RECEIVER).request;
    let failed = false;
    await sender
      .beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request })
      .catch(() => (failed = true));
    expect(failed).toBe(true);
    // The composer did not send it. This window saves, then a reloaded window looks the id up:
    // never sent, so not accepted.
    await sender.flush(SCOPE);
    const reloaded = createStore(client);
    await reloaded.whenReady();
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    await sender.flush(SCOPE);
    expect((await service.get(SCOPE)).text).toBe("hello");
    await waitFor(() => sender.getText(SCOPE) === "hello");
  });

  test("a lost beginSend reply: while the backend holds the send, a save does not show it twice", async () => {
    using tempDir = new TestTempDir("draft-sends-begin-lost-held");
    const { service, client, hooks, receiver } = await createHarness(tempDir);
    const sender = createStore(client);
    await sender.whenReady();
    sender.setText(SCOPE, "hello");
    // The receiver keeps answering "pending" for now: the landed entry stays while this window
    // saves.
    receiver.statuses.set("s1", "pending");
    hooks.loseBeginSendReply = true;
    const request = pendingSend("s1", "hello", RECEIVER).request;
    await sender
      .beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request })
      .catch(() => undefined);
    expect(sender.getText(SCOPE)).toBe("hello");
    await sender.flush(SCOPE);
    const held = await service.get(SCOPE);
    expect([held.text, held.pendingSends?.map(({ sendId }) => sendId)]).toEqual(["", ["s1"]]);
    // Then the receiver answers: never sent, so it comes back, once.
    receiver.statuses.delete("s1");
    sender.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    expect((await service.get(SCOPE)).text).toBe("hello");
  });

  test("a lost beginSend reply: once the save hid the send, its return survives the next edit", async () => {
    using tempDir = new TestTempDir("draft-sends-begin-lost-then-edit");
    const { service, client, hooks, receiver } = await createHarness(tempDir);
    const sender = createStore(client);
    await sender.whenReady();
    sender.setText(SCOPE, "hello");
    receiver.statuses.set("s1", "pending");
    hooks.loseBeginSendReply = true;
    const request = pendingSend("s1", "hello", RECEIVER).request;
    await sender
      .beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request })
      .catch(() => undefined);
    // The save lands while the backend holds the send: the merge hides it from this window.
    await sender.flush(SCOPE);
    expect(sender.getText(SCOPE)).toBe("");
    // The user types; that save is held until the receiver has returned the send.
    sender.setText(SCOPE, "typed B");
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    hooks.beforeUpdate = () => released;
    const flushing = sender.flush(SCOPE);
    receiver.statuses.delete("s1");
    sender.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    release();
    await flushing;
    await sender.flush(SCOPE);
    expect((await service.get(SCOPE)).text).toBe("hello\n\ntyped B");
  });

  /**
   * Window `writer` has unsaved text while window `sender`'s send of "hello" is accepted; its
   * save reaches the backend only after the send settled. With `offlineText`, the writer edited
   * "hello" into that text offline (before it saw the send); without, it typed "hello" again
   * after it saw the send.
   */
  async function saveAcrossAcceptance(options: { offlineText?: string }) {
    using tempDir = new TestTempDir(
      `draft-sends-across-accept-${options.offlineText ?? "retyped"}`
    );
    const { service, client, hooks, receiver } = await createHarness(tempDir);
    const writer = createStore(client);
    const sender = createStore(client);
    await Promise.all([writer.whenReady(), sender.whenReady()]);
    let entered: () => void = () => undefined;
    const entering = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holdNextSave = () => {
      hooks.beforeUpdate = async () => {
        entered();
        await released;
      };
    };
    const send = async () => {
      receiver.statuses.set("s1", "pending");
      const request = pendingSend("s1", "hello", RECEIVER).request;
      await sender.beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request });
      // As after the send's RPC: the receiver still holds it.
      expect(await sender.settleSend(SCOPE, "s1")).toBe("pending");
    };
    sender.setText(SCOPE, "hello");
    await sender.flush(SCOPE);
    await waitFor(() => writer.getText(SCOPE) === "hello");
    let flushing: Promise<void>;
    if (options.offlineText !== undefined) {
      // The writer edits "hello" offline (unsaved): a stale copy once the send is made. It sees
      // the send when it reconnects; its save then waits until the send was accepted.
      writer.setClient(null);
      writer.setText(SCOPE, options.offlineText);
      await send();
      holdNextSave();
      writer.setClient(client);
      await entering;
      expect(writer.getPendingSendIds(SCOPE).has("s1")).toBe(true);
      flushing = writer.flush(SCOPE);
    } else {
      // The writer sees the send, then the user types the sent text again (e.g. to edit it).
      await send();
      await waitFor(() => writer.getText(SCOPE) === "");
      holdNextSave();
      writer.setText(SCOPE, "hello");
      flushing = writer.flush(SCOPE);
      await entering;
    }
    receiver.statuses.set("s1", "accepted");
    sender.triggerSendResolution(WS);
    await waitFor(async () => (await service.get(SCOPE)).pendingSends === undefined);
    release();
    await flushing;
    await writer.flush(SCOPE);
    return (await service.get(SCOPE)).text;
  }

  test("text typed after the window saw a pending send is saved even when it matches it", async () => {
    using tempDir = new TestTempDir("draft-sends-retype-pending");
    const { service, client, receiver } = await createHarness(tempDir);
    const store = createStore(client);
    await store.whenReady();
    store.setText(SCOPE, "hello");
    receiver.statuses.set("s1", "pending");
    const request = pendingSend("s1", "hello", RECEIVER).request;
    await store.beginSend(SCOPE, { sendId: "s1", text: "hello", attachments: [], request });
    expect(await store.settleSend(SCOPE, "s1")).toBe("pending");
    // The user types the sent text again (e.g. to edit the message) while it is still pending.
    store.setText(SCOPE, "hello");
    await store.flush(SCOPE);
    const saved = await service.get(SCOPE);
    expect([saved.text, saved.pendingSends?.map(({ sendId }) => sendId)]).toEqual([
      "hello",
      ["s1"],
    ]);
    expect(store.getText(SCOPE)).toBe("hello");
  });

  test("an accepted send's stale copy in another window's unsaved text does not come back", async () => {
    expect(await saveAcrossAcceptance({ offlineText: "hello\n\nmore" })).toBe("more");
  });

  // #5567: only a whole block is a stale copy; a sentence that ends with the sent text is the
  // user's own text.
  test("a sentence ending with an accepted send's text in another window's unsaved text stays", async () => {
    expect(await saveAcrossAcceptance({ offlineText: "I said hello" })).toBe("I said hello");
  });

  test("text typed after the window saw the send stays even when it matches the accepted send", async () => {
    expect(await saveAcrossAcceptance({})).toBe("hello");
  });

  test("Stop during an in-flight automatic re-send starts no work after the Stop", async () => {
    using tempDir = new TestTempDir("draft-sends-stop-inflight");
    const { service, client, receiver, receiverHooks } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", "receiver-old"),
      attachments: [],
    });
    let arrived: () => void = () => undefined;
    const arriving = new Promise<void>((resolve) => (arrived = resolve));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    receiverHooks.beforeArrival = async () => {
      arrived();
      await released;
    };
    const store = createStore(client);
    await store.whenReady();
    await arriving;
    // Stop (its interrupt goes out once this settles), then the re-send reaches the receiver.
    await store.abortSendRetries(WS);
    release();
    await sleep(20 * RETRY_DELAY_MS);
    expect(receiver.sends).toEqual([]);
    // The send is not lost: a later trigger shows its text again.
    store.triggerSendResolution(WS, { afterStop: true });
    await waitFor(() => store.getText(SCOPE) === "hello");
  });

  test("a stale update after another window settled a send does not undo that window's edit", async () => {
    using tempDir = new TestTempDir("draft-sends-stale-update");
    const { service, client, hooks, receiver } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER),
      attachments: [],
    });
    receiver.statuses.set("s1", "pending");
    const stale = createStore(client);
    const other = createStore(client);
    await Promise.all([stale.whenReady(), other.whenReady()]);
    stale.setText(SCOPE, "typed A");
    let entered: () => void = () => undefined;
    const entering = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    hooks.beforeUpdate = async () => {
      entered();
      await released;
    };
    const flushing = stale.flush(SCOPE);
    await entering;
    // Meanwhile Stop returns the send (not accepted); the other window shows it, then deletes it.
    receiver.statuses.delete("s1");
    other.triggerSendResolution(WS);
    await waitFor(() => other.getText(SCOPE) === "hello");
    other.setText(SCOPE, "");
    await other.flush(SCOPE);
    release();
    await flushing;
    await stale.flush(SCOPE);
    expect((await service.get(SCOPE)).text).toBe("typed A");
  });

  test("a restored input keeps only what the draft's pending sends do not retain", async () => {
    using tempDir = new TestTempDir("draft-sends-without-retained");
    const { service, client } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello", RECEIVER, ["img-1"]),
      attachments: [image],
    });
    const store = createStore(client);
    await store.whenReady();
    await store.ensurePayloads(SCOPE);
    const foreignPart: FilePart = { url: "data:image/png;base64,AAAA", mediaType: "image/png" };
    const rest = store.withoutRetainedSends(SCOPE, ["s1"], {
      text: "hello\nfrom elsewhere",
      fileParts: [{ url: image.url, mediaType: image.mediaType }, foreignPart],
    });
    expect([rest.text, rest.fileParts]).toEqual(["from elsewhere", [foreignPart]]);
  });
});
