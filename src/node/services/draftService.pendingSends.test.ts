/**
 * Idempotent sends in the draft file (formal/composer-drafts/ComposerSends.tla, FixRenderer):
 * pending sends keep their text and attachments in the legacy fields until the backend answers
 * for their ids. The service is real (real files); only the receiver's answers are scripted.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it } from "bun:test";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import type {
  DraftAttachment,
  DraftEvent,
  DraftScope,
  PendingSend,
} from "@/common/orpc/schemas/drafts";
import { DraftService } from "./draftService";
import { resolveDraftSends } from "./draftSendResolution";
import type { WorkspaceService } from "./workspaceService";

const WORKSPACE_ID = "pending-ws";
const SCOPE = { kind: "workspace" as const, workspaceId: WORKSPACE_ID } satisfies DraftScope;

async function createHarness(tempDir: TestTempDir) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });
  await config.addWorkspace(projectPath, {
    id: WORKSPACE_ID,
    name: "pending-branch",
    projectPath,
    projectName: "project",
    runtimeConfig: { type: "local" },
  });
  const file = path.join(config.sessionsDir, WORKSPACE_ID, "draft.json");
  const service = new DraftService(config);
  const events: DraftEvent[] = [];
  service.on(DraftService.CHANGE_EVENT, (event: DraftEvent) => events.push(event));
  return { config, file, service, events };
}

const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

function pendingSend(
  sendId: string,
  text: string,
  options?: { receiverId?: string; attachmentIds?: string[] }
): PendingSend {
  return {
    sendId,
    receiverId: options?.receiverId ?? "receiver-1",
    text,
    attachmentIds: options?.attachmentIds ?? [],
    request: { message: text, options: { model: "openai:gpt-5.2", agentId: "exec" } },
  };
}

async function readFile(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
}

/** A receiver that answers from a table (getSendStatus's contract, without a session). */
function scriptedReceiver(answers: Record<string, string>, receiverId = "receiver-1") {
  const calls: Array<{ sendIds: readonly string[]; receiverId?: string }> = [];
  const workspaceService = {
    getSendStatus: (_workspaceId: string, sendIds: readonly string[], asked?: string) => {
      calls.push({ sendIds, receiverId: asked });
      return Promise.resolve({
        success: true as const,
        data: {
          receiverId,
          statuses: sendIds.map((sendId) => ({
            sendId,
            status: (answers[sendId] ?? "unknown") as "accepted",
          })),
        },
      });
    },
  } as unknown as WorkspaceService;
  return { workspaceService, calls };
}

describe("DraftService pending sends", () => {
  it("retains the sent text in the legacy text and shows only the visible part", async () => {
    using tempDir = new TestTempDir("drafts-pending-begin");
    const { file, service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "first message" });

    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "first message"),
      attachments: [],
    });
    // Typed after the send: only the visible part changes.
    await service.update({ scope: SCOPE, text: "typed later" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s2", "typed later"),
      attachments: [],
    });
    await service.update({ scope: SCOPE, text: "third" });

    const view = await service.get(SCOPE);
    expect(view.text).toBe("third");
    expect(view.pendingSends?.map(({ sendId }) => sendId)).toEqual(["s1", "s2"]);
    // An older build reads the legacy fields as the whole draft: nothing is missing.
    expect((await readFile(file)).text).toBe("first message\n\ntyped later\n\nthird");
  });

  it("keeps another window's newer visible edit at beginSend", async () => {
    using tempDir = new TestTempDir("drafts-pending-newer");
    const { service } = await createHarness(tempDir);
    // Another window appended to the sent text before this window's send landed.
    await service.update({ scope: SCOPE, text: "hello\n\nfrom the other window" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hello"),
      attachments: [],
    });
    expect((await service.get(SCOPE)).text).toBe("from the other window");
  });

  it("beginSend is idempotent by send id and refuses another payload under it", async () => {
    using tempDir = new TestTempDir("drafts-pending-idempotent");
    const { file, service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "hello" });
    const send = pendingSend("s1", "hello");
    await service.beginSend({ scope: SCOPE, pendingSend: send, attachments: [] });
    const before = await fs.readFile(file, "utf-8");
    await service.beginSend({ scope: SCOPE, pendingSend: send, attachments: [] });
    expect(await fs.readFile(file, "utf-8")).toBe(before);

    // A repeat with a new receiver only moves the entry.
    await service.beginSend({
      scope: SCOPE,
      pendingSend: { ...send, receiverId: "receiver-2" },
      attachments: [],
    });
    expect((await service.get(SCOPE)).pendingSends?.[0].receiverId).toBe("receiver-2");
    expect((await readFile(file)).text).toBe("hello");

    let refusal: unknown;
    try {
      await service.beginSend({
        scope: SCOPE,
        pendingSend: pendingSend("s1", "other"),
        attachments: [],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
  });

  it("setSendReceiver never recreates a resolved entry", async () => {
    using tempDir = new TestTempDir("drafts-pending-receiver");
    const { service } = await createHarness(tempDir);
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "hi"),
      attachments: [],
    });
    expect(
      (await service.setSendReceiver({ scope: SCOPE, sendId: "s1", receiverId: "receiver-2" }))
        .present
    ).toBe(true);
    await service.applySendStatuses(SCOPE, [
      { sendId: "s1", receiverId: "receiver-2", status: "accepted" },
    ]);
    expect(
      (await service.setSendReceiver({ scope: SCOPE, sendId: "s1", receiverId: "receiver-3" }))
        .present
    ).toBe(false);
    expect((await service.get(SCOPE)).pendingSends).toBeUndefined();
  });

  it("applies an answer only to the entry and receiver it was asked for", async () => {
    using tempDir = new TestTempDir("drafts-pending-recheck");
    const { service, events } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "visible" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "one"),
      attachments: [],
    });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s2", "two"),
      attachments: [],
    });
    // A retry moved s2 to another receiver after the lookup asked the old one.
    await service.setSendReceiver({ scope: SCOPE, sendId: "s2", receiverId: "receiver-2" });
    events.length = 0;

    await service.applySendStatuses(SCOPE, [
      { sendId: "s1", receiverId: "receiver-1", status: "not-accepted" },
      { sendId: "s2", receiverId: "receiver-1", status: "accepted" },
      { sendId: "gone", receiverId: "receiver-1", status: "accepted" },
    ]);
    const view = await service.get(SCOPE);
    expect(view.text).toBe("one\n\nvisible");
    expect(view.pendingSends?.map(({ sendId }) => sendId)).toEqual(["s2"]);
    expect(events.map((event) => event.type)).toEqual(["changed"]);

    // The same answers again (another window): nothing changes.
    await service.applySendStatuses(SCOPE, [
      { sendId: "s1", receiverId: "receiver-1", status: "not-accepted" },
    ]);
    expect((await service.get(SCOPE)).text).toBe("one\n\nvisible");
  });

  it("an attachment-only send keeps its attachment until accepted, and gives it back if not", async () => {
    using tempDir = new TestTempDir("drafts-pending-attachments");
    const { file, service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, attachments: [image] });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "", { attachmentIds: ["img-1"] }),
      attachments: [image],
    });
    // The composer cleared its attachments: the retained one stays (pending-only, not empty).
    await service.update({ scope: SCOPE, attachments: [] });
    expect((await readFile(file)).attachments).toEqual([image]);
    expect((await service.get(SCOPE)).attachments).toEqual([image]);

    await service.applySendStatuses(SCOPE, [
      { sendId: "s1", receiverId: "receiver-1", status: "not-accepted" },
    ]);
    const restored = await service.get(SCOPE);
    expect([restored.attachments, restored.pendingSends]).toEqual([[image], undefined]);

    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s2", "", { attachmentIds: ["img-1"] }),
      attachments: [image],
    });
    await service.applySendStatuses(SCOPE, [
      { sendId: "s2", receiverId: "receiver-1", status: "accepted" },
    ]);
    // Accepted: the attachment went with the send and the draft is gone.
    let missing = false;
    try {
      await fs.access(file);
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });

  it("drops bookkeeping an older build invalidated, leaving everything visible", async () => {
    using tempDir = new TestTempDir("drafts-pending-downgrade");
    const { config, file, service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "visible" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "sent"),
      attachments: [],
    });

    // An older build edited the legacy text (and kept, or dropped, the unknown key).
    const raw = await readFile(file);
    await fs.writeFile(file, JSON.stringify({ ...raw, text: `edited ${String(raw.text)}` }));
    const reloaded = await new DraftService(config).get(SCOPE);
    expect([reloaded.text, reloaded.pendingSends]).toEqual(["edited sent\n\nvisible", undefined]);

    // An older build rewrote the file without the key: all of it is plain draft text.
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, text: "sent\n\nvisible", attachments: [] })
    );
    expect((await new DraftService(config).get(SCOPE)).text).toBe("sent\n\nvisible");

    // A missing retained attachment invalidates it too.
    await fs.writeFile(
      file,
      JSON.stringify({
        ...raw,
        pendingSends: [pendingSend("s1", "sent", { attachmentIds: ["img-gone"] })],
      })
    );
    expect((await new DraftService(config).get(SCOPE)).text).toBe("sent\n\nvisible");
  });

  it("resolves by receiver outside the draft lock and applies the final answers", async () => {
    using tempDir = new TestTempDir("drafts-pending-resolve");
    const { service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "visible" });
    for (const [sendId, receiverId] of [
      ["s1", "receiver-1"],
      ["s2", "receiver-1"],
      ["s3", "receiver-old"],
      ["s4", "receiver-1"],
    ]) {
      await service.beginSend({
        scope: SCOPE,
        pendingSend: pendingSend(sendId, sendId, { receiverId }),
        attachments: [],
      });
    }
    const receiver = scriptedReceiver({ s1: "accepted", s2: "not-accepted", s4: "pending" });
    const reply = await resolveDraftSends(
      { draftService: service, workspaceService: receiver.workspaceService },
      { scope: SCOPE, exceptSendIds: ["s4"] }
    );
    expect(receiver.calls).toEqual([
      { sendIds: ["s1", "s2"], receiverId: "receiver-1" },
      { sendIds: ["s3"], receiverId: "receiver-old" },
    ]);
    expect(reply.statuses).toEqual([
      { sendId: "s1", status: "accepted" },
      { sendId: "s2", status: "not-accepted" },
      { sendId: "s3", status: "unknown" },
    ]);
    const view = await service.get(SCOPE);
    expect(view.text).toBe("s2\n\nvisible");
    expect(view.pendingSends?.map(({ sendId }) => sendId)).toEqual(["s3", "s4"]);
  });

  it("a send keeps the payload it sends under a stored attachment id (a pending file staged since)", async () => {
    using tempDir = new TestTempDir("draft-pending-staged-payload");
    const { service } = await createHarness(tempDir);
    const pendingFile: DraftAttachment = {
      kind: "pending-file",
      id: "file-1",
      mediaType: "text/plain",
      filename: "notes.txt",
      sizeBytes: 2,
      dataBase64: "aGk=",
    };
    const staged: DraftAttachment = {
      kind: "staged",
      id: "file-1",
      mediaType: "text/plain",
      filename: "notes.txt",
      sizeBytes: 2,
      stagedPath: ".xum/attachments/notes.txt",
    };
    await service.update({ scope: SCOPE, attachments: [pendingFile] });
    // The renderer staged it under the same id but had not saved that yet when it sent.
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "", { attachmentIds: ["file-1"] }),
      attachments: [staged],
    });
    expect((await service.get(SCOPE)).attachments).toEqual([staged]);
  });

  describe("a returned send's text in the middle of the draft", () => {
    const basisOf = (send: PendingSend) => ({
      sendId: send.sendId,
      text: send.text,
      attachmentIds: send.attachmentIds,
    });
    const notAccepted = (...ids: string[]) =>
      ids.map((sendId) => ({ sendId, receiverId: "receiver-1", status: "not-accepted" }));

    /** Pending sends `texts` (as a window's basis), with `visible` text beside them. */
    async function sendAll(service: DraftService, visible: string, texts: string[]) {
      const sends = texts.map((text, index) => pendingSend(`s${index + 1}`, text));
      if (visible.length > 0) await service.update({ scope: SCOPE, text: visible });
      for (const send of sends) {
        await service.beginSend({ scope: SCOPE, pendingSend: send, attachments: [] });
      }
      return sends;
    }

    it("three sends returned at once survive a write from a window that hid them", async () => {
      using tempDir = new TestTempDir("draft-pending-middle-batch");
      const { service } = await createHarness(tempDir);
      const sends = await sendAll(service, "", ["alpha", "bravo", "charlie"]);
      await service.applySendStatuses(SCOPE, notAccepted("s1", "s2", "s3"));
      expect((await service.get(SCOPE)).text).toBe("alpha\n\nbravo\n\ncharlie");
      await service.update({ scope: SCOPE, text: "mine", basisSends: sends.map(basisOf) });
      expect((await service.get(SCOPE)).text).toBe("alpha\n\nbravo\n\ncharlie\n\nmine");
    });

    it("sends returned at different times onto visible text all survive", async () => {
      using tempDir = new TestTempDir("draft-pending-middle-sequential");
      const { service } = await createHarness(tempDir);
      const sends = await sendAll(service, "", ["alpha", "bravo"]);
      await service.update({ scope: SCOPE, text: "keep" });
      await service.applySendStatuses(SCOPE, notAccepted("s1"));
      await service.applySendStatuses(SCOPE, notAccepted("s2"));
      expect((await service.get(SCOPE)).text).toBe("bravo\n\nalpha\n\nkeep");
      await service.update({
        scope: SCOPE,
        text: "keep\n\nmine",
        basisSends: sends.map(basisOf),
      });
      const text = (await service.get(SCOPE)).text;
      for (const block of ["alpha", "bravo", "keep", "mine"]) {
        expect(text.split("\n\n").filter((part) => part === block)).toHaveLength(1);
      }
    });

    it("a multi-paragraph send and repeated texts each keep their own copy", async () => {
      using tempDir = new TestTempDir("draft-pending-middle-repeated");
      const { service } = await createHarness(tempDir);
      const sends = await sendAll(service, "", ["ok", "first\n\nsecond", "ok"]);
      await service.applySendStatuses(SCOPE, notAccepted("s1", "s2", "s3"));
      await service.update({ scope: SCOPE, text: "mine", basisSends: sends.map(basisOf) });
      expect((await service.get(SCOPE)).text).toBe("ok\n\nfirst\n\nsecond\n\nok\n\nmine");
    });

    it("a stale copy of a pending send in the middle of a write is taken out", async () => {
      using tempDir = new TestTempDir("draft-pending-middle-stale");
      const { service } = await createHarness(tempDir);
      await sendAll(service, "", ["bravo"]);
      // A window that never saw the send writes its old text, which holds it in the middle.
      await service.update({ scope: SCOPE, text: "alpha\n\nbravo\n\ncharlie" });
      const stored = await service.get(SCOPE);
      expect([stored.text, stored.pendingSends?.length]).toEqual(["alpha\n\ncharlie", 1]);
    });
  });

  it("a fork copies only the visible part", async () => {
    using tempDir = new TestTempDir("drafts-pending-fork");
    const { config, service } = await createHarness(tempDir);
    await service.update({ scope: SCOPE, text: "sent\n\nvisible" });
    await service.beginSend({
      scope: SCOPE,
      pendingSend: pendingSend("s1", "sent"),
      attachments: [],
    });
    await fs.mkdir(path.join(config.sessionsDir, "fork-ws"), { recursive: true });
    await service.copyWorkspaceDraftForFork(WORKSPACE_ID, "fork-ws");
    const forkFile = path.join(config.sessionsDir, "fork-ws", "draft.json");
    expect(await readFile(forkFile)).toEqual({ version: 1, text: "visible", attachments: [] });
  });
});
