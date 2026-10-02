import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { Err, Ok } from "@/common/types/result";
import {
  createAgentSessionHarness,
  runSessionTerminalPolicy,
} from "@/node/services/agentSession.testHarness";
import type { AgentSession } from "@/node/services/agentSession";
import type { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { InitStateManager } from "@/node/services/initStateManager";
import { createMuxMessage } from "@/common/types/message";
import * as schemas from "@/common/orpc/schemas";
import { HistoryService } from "@/node/services/historyService";
import {
  computeSendDigest,
  SEND_ID_CONFLICT_MESSAGE,
  SEND_ID_REFUSED_MESSAGE,
} from "@/node/services/sendIdIndex";
import type { TurnCompletion } from "@/node/services/streamManager";
import {
  createTestProject,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceService } from "@/node/services/workspaceService";

/**
 * Idempotent sends end to end through the real WorkspaceService + AgentSession + MessageQueue +
 * HistoryService (only the AI stream mocked). H1: a held Retry whose first try left a durable
 * row and then failed must find that row ("already accepted"), add no second row, and drop the
 * held entry -- also for a client that sends no ids (the backend mints them).
 */
const workspaceId = "send-ids-ws";
const model = "openai:gpt-5.2";
const sendOptions = { model, agentId: "exec" };

describe("idempotent sends (real host)", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  const cleanups: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    fixture = await createTestHistoryService();
  });
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    await fixture.cleanup();
  });

  /** Another backend on the same session dir accepts a send (its own HistoryService). */
  async function acceptElsewhere(sendId: string, text: string): Promise<void> {
    const other = new HistoryService(fixture.config);
    const capture = await other.captureCompactionReplacement(workspaceId);
    if (!capture.success) throw new Error(capture.error);
    const appended = await other.acceptCompactionReplacement(
      workspaceId,
      capture.data,
      { kind: "append", messages: [createMuxMessage(`elsewhere-${sendId}`, "user", text)] },
      {
        isCurrent: () => true,
        onCommitted: () => undefined,
        sendIds: {
          identities: [{ id: sendId, digest: computeSendDigest({ message: text }) }],
          onDecision: () => undefined,
        },
      }
    );
    expect(appended).toMatchObject({ success: true, data: { kind: "accepted" } });
  }

  async function createStack() {
    const { config, historyService } = fixture;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          ...projectWorkspace(projectPath, "ws", workspaceId, { runtimeConfig: { type: "local" } }),
          path: projectPath,
        },
      ],
      testTaskSettings()
    );
    const aiEmitter = new EventEmitter();
    const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
    /** Per stream start, in order: "fail" makes that start fail after the user row is durable. */
    const startPlan: Array<"ok" | "fail"> = [];
    let streamCalls = 0;
    let streaming = false;
    // The stopStream override runs after the harness exists; it reaches the session through this.
    const sessionRef: { current?: AgentSession } = {};
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      captureEvents: true,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        getWorkspaceMetadata: mock(async (id: string) => {
          const found = (await config.getAllWorkspaceMetadata()).find((m) => m.id === id);
          return found ? Ok(found) : Err("not found");
        }),
        streamMessage: mock(() => {
          streamCalls++;
          if (startPlan.shift() === "fail") {
            return Promise.resolve(Err({ type: "unknown" as const, raw: "provider refused" }));
          }
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          streaming = true;
          const messageId = `assistant-${completions.length}`;
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
        stopStream: mock(() => {
          streaming = false;
          completions.at(-1)?.resolve({ status: "aborted", abortReason: "user" });
          // The abort reaches the session's terminal policy the way StreamManager reports it.
          void runSessionTerminalPolicy(sessionRef.current!, aiEmitter, {
            type: "stream-abort",
            workspaceId,
            messageId: `assistant-${completions.length}`,
            abortReason: "user",
          });
          return Promise.resolve(Ok(undefined));
        }),
      },
    });
    sessionRef.current = harness.session;
    const aiService = harness.aiService as unknown as AIService;
    const workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      new InitStateManager(config),
      new ExtensionMetadataService(path.join(config.rootDir, "send-ids-extension-metadata.json")),
      new BackgroundProcessManager(path.join(config.rootDir, "send-ids-background-processes"))
    );
    (workspaceService as unknown as { sessions: Map<string, unknown> }).sessions.set(
      workspaceId,
      harness.session
    );
    cleanups.push(async () => {
      for (const completion of completions) {
        completion.resolve({ status: "aborted", abortReason: "user" });
      }
      workspaceService.beginShutdown();
      await harness.session.dispose();
      const pending = (
        workspaceService as unknown as { pendingWorkspaceCleanup: Set<Promise<void>> }
      ).pendingWorkspaceCleanup;
      while (pending.size > 0) await Promise.all([...pending]);
      await harness.cleanup();
    });
    const userRows = async () => {
      const rows = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!rows.success) throw new Error(rows.error);
      return (
        rows.data
          // The sends' own rows (snapshot rows are synthetic user rows before them).
          .filter((row) => row.role === "user" && row.metadata?.synthetic !== true)
          .map((row) => ({
            text: row.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            sendIds: row.metadata?.sendIds,
          }))
      );
    };
    async function until(condition: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!condition()) throw new Error(`timed out waiting for ${label}`);
    }
    /** Start a turn that stays streaming until stopped. */
    const startBusyTurn = async (text: string) => {
      expect(await workspaceService.sendMessage(workspaceId, text, sendOptions)).toEqual(
        Ok(undefined)
      );
      await until(() => streaming, "the first turn to stream");
    };
    /** End the current stream normally (event first, then the completion), as StreamManager does. */
    const endStream = async () => {
      const index = completions.length - 1;
      const event = {
        type: "stream-end" as const,
        workspaceId,
        messageId: `assistant-${index + 1}`,
        metadata: { model, finishReason: "stop" },
        parts: [{ type: "text" as const, text: "done" }],
      };
      streaming = false;
      const policy = runSessionTerminalPolicy(harness.session, aiEmitter, event);
      completions[index]?.resolve({
        status: "completed",
        streamEnd: event as unknown as Extract<
          TurnCompletion,
          { status: "completed" }
        >["streamEnd"],
      });
      await policy;
    };
    return {
      workspaceService,
      session: harness.session,
      endStream,
      startPlan,
      streamCalls: () => streamCalls,
      userRows,
      until,
      startBusyTurn,
    };
  }

  test("H1: a held Retry whose first try left a durable row then failed finds it, adds no row, and drops the entry (ID-less client)", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    // The client sends no id: the backend mints one, and the queued entry keeps it.
    expect(await h.workspaceService.sendMessage(workspaceId, "follow-up", sendOptions)).toEqual(
      Ok(undefined)
    );
    expect(await h.workspaceService.interruptStream(workspaceId)).toMatchObject({ success: true });
    await h.until(() => h.session.getHeldInputs().length === 1, "Stop to hold the queued send");
    const held = h.session.getHeldInputs()[0];
    const mintedId = held.send.sendAdds?.[0]?.identity?.id;
    if (mintedId === undefined) throw new Error("the held send keeps its minted id");

    await h.until(() => !h.session.isBusy(), "the stopped turn to settle");
    // The re-send's row becomes durable, then its stream start fails: Err, entry kept.
    h.startPlan.push("fail");
    const failed = await h.workspaceService.sendHeldInput(workspaceId, held.id);
    expect(failed.success).toBe(false);
    expect(h.session.getHeldInputs().map((entry) => entry.id)).toEqual([held.id]);
    expect((await h.userRows()).filter((row) => row.text === "follow-up")).toEqual([
      { text: "follow-up", sendIds: [mintedId] },
    ]);

    // Retry: already accepted. No second row, no stream, and the held entry is gone.
    const calls = h.streamCalls();
    expect(await h.workspaceService.sendHeldInput(workspaceId, held.id)).toEqual(Ok(undefined));
    expect(h.session.getHeldInputs()).toEqual([]);
    expect(h.streamCalls()).toBe(calls);
    expect((await h.userRows()).filter((row) => row.text === "follow-up")).toHaveLength(1);
  });

  test("a client retry under its id adds no row; the same id with another payload is a conflict", async () => {
    const h = await createStack();
    const send = (text: string) =>
      h.workspaceService.sendMessage(workspaceId, text, { ...sendOptions, sendId: "client-1" });
    h.startPlan.push("fail");
    expect((await send("hello")).success).toBe(false);
    const calls = h.streamCalls();
    expect(await send("hello")).toEqual(Ok(undefined));
    expect(h.streamCalls()).toBe(calls);
    expect(await send("changed")).toEqual(Err({ type: "unknown", raw: SEND_ID_CONFLICT_MESSAGE }));
    expect(await h.userRows()).toEqual([{ text: "hello", sendIds: ["client-1"] }]);
  });

  test("a queued batch whose id another backend accepted meanwhile appends only the rest", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    for (const [sendId, text] of [
      ["b1", "one"],
      ["b2", "two"],
    ]) {
      expect(
        await h.workspaceService.sendMessage(workspaceId, text, { ...sendOptions, sendId })
      ).toEqual(Ok(undefined));
    }
    // Another backend on the same session dir accepts b2 (same payload) while the batch waits.
    await acceptElsewhere("b2", "two");

    await h.endStream();
    await h.until(() => h.streamCalls() === 2, "the batch to dispatch");
    expect(await h.userRows()).toEqual([
      { text: "first", sendIds: [expect.any(String)] },
      { text: "two", sendIds: ["b2"] },
      { text: "one", sendIds: ["b1"] },
    ]);
  });

  test("a partly accepted batch with a snapshot row is refused whole, held with its ids, and its Retry sends only the rest", async () => {
    const h = await createStack();
    const projectPath = path.join(fixture.tempDir, "repo");
    await fsPromises.writeFile(path.join(projectPath, "notes.txt"), "notes body\n");
    await h.startBusyTurn("first");
    for (const [sendId, text] of [
      ["b1", "see @notes.txt"],
      ["b2", "two"],
    ]) {
      expect(
        await h.workspaceService.sendMessage(workspaceId, text, { ...sendOptions, sendId })
      ).toEqual(Ok(undefined));
    }
    await acceptElsewhere("b2", "two");
    await h.endStream();
    // The @file snapshot was built from the whole batch: no partial row, the batch is held.
    await h.until(() => h.session.getHeldInputs().length === 1, "the refused batch to be held");
    const held = h.session.getHeldInputs()[0];
    expect(held.send.sendAdds?.map((add) => add.identity?.id)).toEqual(["b1", "b2"]);
    expect((await h.userRows()).map((row) => row.text)).toEqual(["first", "two"]);

    await h.until(() => !h.session.isBusy(), "the refused dispatch to settle");
    expect(await h.workspaceService.sendHeldInput(workspaceId, held.id)).toEqual(Ok(undefined));
    expect(h.session.getHeldInputs()).toEqual([]);
    expect((await h.userRows()).slice(1)).toEqual([
      { text: "two", sendIds: ["b2"] },
      { text: "see @notes.txt", sendIds: ["b1"] },
    ]);
  });

  test("a queued [/compact, follow-up] batch whose /compact was accepted elsewhere is refused whole, never sent as a compaction", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    expect(
      await h.workspaceService.sendMessage(workspaceId, "/compact", {
        ...sendOptions,
        sendId: "c1",
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      })
    ).toEqual(Ok(undefined));
    expect(
      await h.workspaceService.sendMessage(workspaceId, "follow-up", {
        ...sendOptions,
        sendId: "c2",
      })
    ).toEqual(Ok(undefined));
    const other = new HistoryService(fixture.config);
    const capture = await other.captureCompactionReplacement(workspaceId);
    if (!capture.success) throw new Error(capture.error);
    await other.acceptCompactionReplacement(
      workspaceId,
      capture.data,
      { kind: "append", messages: [createMuxMessage("elsewhere-c1", "user", "/compact")] },
      {
        isCurrent: () => true,
        onCommitted: () => undefined,
        sendIds: {
          identities: [
            {
              id: "c1",
              digest: computeSendDigest({
                message: "/compact",
                muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
              }),
            },
          ],
          onDecision: () => undefined,
        },
      }
    );
    await h.endStream();
    await h.until(() => h.session.getHeldInputs().length === 1, "the refused batch to be held");
    // No row for the follow-up, and nothing streamed it as a compaction request.
    expect((await h.userRows()).map((row) => row.text)).toEqual(["first", "/compact"]);
    expect(h.streamCalls()).toBe(1);
  });

  test("lookups: accepted, pending while queued, not accepted -- and a late arrival of a not-accepted id is refused", async () => {
    const h = await createStack();
    expect(
      await h.workspaceService.sendMessage(workspaceId, "one", { ...sendOptions, sendId: "s-row" })
    ).toEqual(Ok(undefined));
    await h.until(() => h.streamCalls() === 1, "the first turn to stream");
    expect(
      await h.workspaceService.sendMessage(workspaceId, "two", {
        ...sendOptions,
        sendId: "s-queued",
      })
    ).toEqual(Ok(undefined));
    expect(
      await h.workspaceService.getSendStatus(workspaceId, ["s-row", "s-queued", "s-lost"])
    ).toEqual(
      Ok([
        { sendId: "s-row", status: "accepted" },
        { sendId: "s-queued", status: "pending" },
        { sendId: "s-lost", status: "not-accepted" },
      ])
    );
    // The same id with another payload while the first copy is queued is a conflict.
    expect(
      await h.workspaceService.sendMessage(workspaceId, "changed", {
        ...sendOptions,
        sendId: "s-queued",
      })
    ).toEqual(Err({ type: "unknown", raw: SEND_ID_CONFLICT_MESSAGE }));
    // Any valid id gets an answer through the RPC output schema, even "__proto__".
    const prototypeKey = await h.workspaceService.getSendStatus(workspaceId, ["__proto__"]);
    expect(schemas.workspace.getSendStatus.output.parse(prototypeKey)).toEqual(
      Ok([{ sendId: "__proto__", status: "not-accepted" }])
    );
    // A retry of a queued id while it is queued does not queue it twice.
    expect(
      await h.workspaceService.sendMessage(workspaceId, "two", {
        ...sendOptions,
        sendId: "s-queued",
      })
    ).toEqual(Ok(undefined));
    expect(
      await h.workspaceService.sendMessage(workspaceId, "late", {
        ...sendOptions,
        sendId: "s-lost",
      })
    ).toEqual(Err({ type: "unknown", raw: SEND_ID_REFUSED_MESSAGE }));
    expect(await h.workspaceService.interruptStream(workspaceId)).toMatchObject({ success: true });
    await h.until(() => h.session.getHeldInputs().length === 1, "Stop to hold the queued send");
    // The batch held exactly one add for the repeated id.
    expect(h.session.getHeldInputs()[0].send.sendAdds?.map((add) => add.identity?.id)).toEqual([
      "s-queued",
    ]);
    expect(h.session.getHeldInputs()[0].send.message).toBe("two");
    expect((await h.userRows()).map((row) => row.text)).toEqual(["one"]);
  });
});
