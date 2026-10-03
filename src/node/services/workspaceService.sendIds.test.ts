import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import { HistoryService } from "@/node/services/historyService";
import * as schemas from "@/common/orpc/schemas";
import { MINTED_SEND_ID_PREFIX, SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import {
  computeSendDigest,
  SEND_ID_CONFLICT_MESSAGE,
  SEND_ID_PARTLY_ACCEPTED_MESSAGE,
  SEND_ID_REFUSED_MESSAGE,
} from "@/node/services/sendIds";
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
    const mintedId = held.send.sendIdentities?.[0]?.id;
    if (mintedId === undefined) throw new Error("the held send keeps its minted id");
    expect(mintedId.startsWith(MINTED_SEND_ID_PREFIX)).toBe(true);
    // Held input can be re-sent after a publication, so its ids are always read back.
    expect(held.send.sendIdentities?.[0]?.unpublished).toBeUndefined();

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

  test("H1 under the lock: a held Retry whose lookup answered 'not on a row' still adds no second row", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    expect(await h.workspaceService.sendMessage(workspaceId, "follow-up", sendOptions)).toEqual(
      Ok(undefined)
    );
    expect(await h.workspaceService.interruptStream(workspaceId)).toMatchObject({ success: true });
    await h.until(() => h.session.getHeldInputs().length === 1, "Stop to hold the queued send");
    const held = h.session.getHeldInputs()[0];
    await h.until(() => !h.session.isBusy(), "the stopped turn to settle");
    h.startPlan.push("fail");
    expect((await h.workspaceService.sendHeldInput(workspaceId, held.id)).success).toBe(false);

    // A stale negative answer (as if read before the first try's row landed) must not authorize
    // a second append: the publication reads history again under the write lock.
    const lookup = spyOn(fixture.historyService, "decideSendIds").mockResolvedValueOnce(
      Ok({ kind: "append" })
    );
    const calls = h.streamCalls();
    expect(await h.workspaceService.sendHeldInput(workspaceId, held.id)).toEqual(Ok(undefined));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(h.session.getHeldInputs()).toEqual([]);
    expect(h.streamCalls()).toBe(calls);
    expect((await h.userRows()).filter((row) => row.text === "follow-up")).toHaveLength(1);
  });

  test("a client id may not use the backend's minted prefix", () => {
    expect(SendMessageOptionsSchema.safeParse({ ...sendOptions, sendId: "client-1" }).success).toBe(
      true
    );
    expect(
      SendMessageOptionsSchema.safeParse({ ...sendOptions, sendId: `${MINTED_SEND_ID_PREFIX}x` })
        .success
    ).toBe(false);
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

  test("a queued batch whose id another backend accepted meanwhile is refused whole and held with every id", async () => {
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
    await h.until(() => h.session.getHeldInputs().length === 1, "the refused batch to be held");
    const held = h.session.getHeldInputs()[0];
    expect(held.send.sendIdentities?.map((entry) => entry.id)).toEqual(["b1", "b2"]);
    expect(held.send.message).toBe("one\ntwo");
    // No partial row: "one" is not sent without its batch, and "two" is not sent twice.
    expect((await h.userRows()).map((row) => row.text)).toEqual(["first", "two"]);
    expect(h.streamCalls()).toBe(1);

    // A Retry of the held batch is refused the same way: nothing is duplicated, the entry stays.
    await h.until(() => !h.session.isBusy(), "the refused dispatch to settle");
    expect(await h.workspaceService.sendHeldInput(workspaceId, held.id)).toEqual(
      Err({ type: "unknown", raw: SEND_ID_PARTLY_ACCEPTED_MESSAGE })
    );
    expect(h.session.getHeldInputs().map((entry) => entry.id)).toEqual([held.id]);
    expect((await h.userRows()).map((row) => row.text)).toEqual(["first", "two"]);
  });

  test("a queued [/compact, follow-up] batch whose /compact was accepted elsewhere is refused whole, never sent as a compaction", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    const compactMetadata = { type: "compaction-request", rawCommand: "/compact", parsed: {} };
    expect(
      await h.workspaceService.sendMessage(workspaceId, "/compact", {
        ...sendOptions,
        sendId: "c1",
        muxMetadata: compactMetadata,
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
              digest: computeSendDigest({ message: "/compact", muxMetadata: compactMetadata }),
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

  test("a client id repeated while queued is queued once; under another payload it is held as a conflict", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    const send = (text: string, sendId: string) =>
      h.workspaceService.sendMessage(workspaceId, text, { ...sendOptions, sendId });
    expect(await send("one", "q1")).toEqual(Ok(undefined));
    // The same send again (a client retry): the queued copy covers it.
    expect(await send("one", "q1")).toEqual(Ok(undefined));
    expect(await send("two", "q2")).toEqual(Ok(undefined));
    // The same id with another payload is never batched with the first copy.
    expect(await send("changed", "q1")).toEqual(Ok(undefined));
    await h.endStream();
    await h.until(() => h.streamCalls() === 2, "the first batch to dispatch");
    await h.endStream();
    await h.until(() => h.session.getHeldInputs().length === 1, "the conflicting copy to be held");
    expect(h.streamCalls()).toBe(2);
    expect(h.session.getHeldInputs()[0].send.message).toBe("changed");
    expect(await h.userRows()).toEqual([
      { text: "first", sendIds: [expect.any(String)] },
      { text: "one\ntwo", sendIds: ["q1", "q2"] },
    ]);
  });

  test("a held Retry while busy is queued on its own, never batched with later input", async () => {
    const h = await createStack();
    await h.startBusyTurn("first");
    expect(await h.workspaceService.sendMessage(workspaceId, "held", sendOptions)).toEqual(
      Ok(undefined)
    );
    expect(await h.workspaceService.interruptStream(workspaceId)).toMatchObject({ success: true });
    await h.until(() => h.session.getHeldInputs().length === 1, "Stop to hold the queued send");
    const held = h.session.getHeldInputs()[0];
    await h.until(() => !h.session.isBusy(), "the stopped turn to settle");

    await h.startBusyTurn("second");
    expect(await h.workspaceService.sendHeldInput(workspaceId, held.id)).toEqual(Ok(undefined));
    expect(await h.workspaceService.sendMessage(workspaceId, "later", sendOptions)).toEqual(
      Ok(undefined)
    );
    await h.endStream();
    await h.until(() => h.streamCalls() === 3, "the held re-send to dispatch");
    await h.endStream();
    await h.until(() => h.streamCalls() === 4, "the later send to dispatch");
    expect((await h.userRows()).map((row) => row.text)).toEqual([
      "first",
      "second",
      "held",
      "later",
    ]);
  });

  // Task launch briefs (U4 in formal/task-launch): an automatic send carries only the ids its
  // caller supplies, and its row keeps them, also when the send returns Err after that row became
  // durable. Only that row tells the launch's caller the brief reached history.
  test("an automatic send stamps the ids its caller supplies, also when it fails after its row is durable", async () => {
    const h = await createStack();
    const sendId = `${MINTED_SEND_ID_PREFIX}task-brief`;

    // The row becomes durable, then the stream start fails: Err, and the row stays.
    h.startPlan.push("fail");
    const failed = await h.workspaceService.sendMessage(workspaceId, "the brief", sendOptions, {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
      sendIdentities: [
        { id: sendId, digest: computeSendDigest({ message: "the brief" }), unpublished: true },
      ],
    });
    expect(failed.success).toBe(false);
    expect(await h.userRows()).toEqual([{ text: "the brief", sendIds: [sendId] }]);

    // Without caller ids an automatic send gets none: nothing is minted for it.
    await h.until(() => !h.session.isBusy(), "the failed send to settle");
    expect(
      await h.workspaceService.sendMessage(workspaceId, "wake", sendOptions, {
        acceptanceOrigin: "automatic",
        agentInitiated: true,
      })
    ).toEqual(Ok(undefined));
    await h.until(() => h.streamCalls() === 2, "the wake to stream");
    expect((await h.userRows()).at(-1)).toEqual({ text: "wake", sendIds: undefined });
  });

  /** Hold every manual publication at its entry until `release` (before the history lock). */
  function gatePublications() {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = fixture.historyService.acceptCompactionReplacement.bind(
      fixture.historyService
    );
    const spy = spyOn(fixture.historyService, "acceptCompactionReplacement").mockImplementation(
      async (...args) => {
        reached.resolve();
        await gate.promise;
        return original(...args);
      }
    );
    return {
      reached: reached.promise,
      release: () => {
        gate.resolve();
        spy.mockRestore();
      },
    };
  }

  const statusesOf = (
    answer: Awaited<ReturnType<WorkspaceService["getSendStatus"]>>
  ): Record<string, string> => {
    if (!answer.success) throw new Error(answer.error);
    return Object.fromEntries(answer.data.statuses.map((entry) => [entry.sendId, entry.status]));
  };

  test("lookups: accepted on its row, pending while queued or held, otherwise not accepted and a late arrival is refused", async () => {
    const h = await createStack();
    const send = (text: string, sendId: string) =>
      h.workspaceService.sendMessage(workspaceId, text, { ...sendOptions, sendId });
    expect(await send("on a row", "s-row")).toEqual(Ok(undefined));
    await h.until(() => h.streamCalls() === 1, "the first send to stream");
    expect(await send("queued", "s-queued")).toEqual(Ok(undefined));
    const lookup = (ids: string[], receiverId?: string) =>
      h.workspaceService.getSendStatus(workspaceId, ids, receiverId);

    const first = await lookup(["s-row", "s-queued", "s-none", "__proto__"]);
    // Compared as a list: an object literal cannot hold an own "__proto__" key.
    expect(first.success && first.data.statuses).toEqual([
      { sendId: "s-row", status: "accepted" },
      { sendId: "s-queued", status: "pending" },
      { sendId: "s-none", status: "not-accepted" },
      { sendId: "__proto__", status: "not-accepted" },
    ]);
    // The answer survives the RPC's own output validation, "__proto__" included.
    const parsed = schemas.workspace.getSendStatus.output.parse(first);
    expect(parsed.success && parsed.data.statuses.map((entry) => entry.sendId)).toEqual([
      "s-row",
      "s-queued",
      "s-none",
      "__proto__",
    ]);
    // Late arrivals of ids answered "not accepted" are refused: the client shows them again.
    for (const id of ["s-none", "__proto__"]) {
      expect(await send("late", id)).toEqual(
        Err({ type: "unknown", raw: SEND_ID_REFUSED_MESSAGE })
      );
    }

    // Held input is still pending here.
    expect(await h.workspaceService.interruptStream(workspaceId)).toMatchObject({ success: true });
    await h.until(() => h.session.getHeldInputs().length === 1, "Stop to hold the queued send");
    expect(statusesOf(await lookup(["s-queued"]))).toEqual({ "s-queued": "pending" });
    expect((await h.userRows()).map((row) => row.text)).toEqual(["on a row"]);
  });

  test("lookups name this receiver; another receiver's unknown id is not remembered as refused", async () => {
    const h = await createStack();
    const empty = await h.workspaceService.getSendStatus(workspaceId, []);
    if (!empty.success) throw new Error(empty.error);
    expect(empty.data.statuses).toEqual([]);
    const receiverId = empty.data.receiverId;
    // Asked about a send that another process received: unknown, never a rejection.
    expect(
      statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-other"], "other-process"))
    ).toEqual({ "s-other": "unknown" });
    expect(
      await h.workspaceService.sendMessage(workspaceId, "retried here", {
        ...sendOptions,
        sendId: "s-other",
      })
    ).toEqual(Ok(undefined));
    expect(
      statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-other"], receiverId))
    ).toEqual({ "s-other": "accepted" });
  });

  test("a send still running, or dispatched from the queue but not yet published, is pending, never not-accepted", async () => {
    const h = await createStack();
    // In WorkspaceService's preflight, before the session has seen it.
    const preflight = Promise.withResolvers<void>();
    const preflightReached = Promise.withResolvers<void>();
    const capture = fixture.historyService.captureCompactionReplacement.bind(
      fixture.historyService
    );
    const captureSpy = spyOn(
      fixture.historyService,
      "captureCompactionReplacement"
    ).mockImplementationOnce(async (...args) => {
      preflightReached.resolve();
      await preflight.promise;
      return capture(...args);
    });
    const early = h.workspaceService.sendMessage(workspaceId, "early", {
      ...sendOptions,
      sendId: "s-early",
    });
    await preflightReached.promise;
    expect(statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-early"]))).toEqual({
      "s-early": "pending",
    });
    preflight.resolve();
    expect(await early).toEqual(Ok(undefined));
    captureSpy.mockRestore();
    await h.until(() => h.streamCalls() === 1, "the early send to stream");
    await h.endStream();
    // Direct send, held before its publication: the WorkspaceService call is still running.
    let gate = gatePublications();
    const direct = h.workspaceService.sendMessage(workspaceId, "direct", {
      ...sendOptions,
      sendId: "s-direct",
    });
    await gate.reached;
    expect(statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-direct"]))).toEqual({
      "s-direct": "pending",
    });
    gate.release();
    expect(await direct).toEqual(Ok(undefined));
    expect(statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-direct"]))).toEqual({
      "s-direct": "accepted",
    });

    // Queued, then dispatched by the drain (no WorkspaceService call running any more).
    expect(
      await h.workspaceService.sendMessage(workspaceId, "queued", {
        ...sendOptions,
        sendId: "s-dispatch",
      })
    ).toEqual(Ok(undefined));
    gate = gatePublications();
    await h.endStream();
    await gate.reached;
    expect(statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-dispatch"]))).toEqual(
      { "s-dispatch": "pending" }
    );
    gate.release();
    await h.until(() => h.streamCalls() === 3, "the queued send to stream");
    expect(statusesOf(await h.workspaceService.getSendStatus(workspaceId, ["s-dispatch"]))).toEqual(
      { "s-dispatch": "accepted" }
    );
  });

  test("a line that proves nothing (torn, unreadable, digestless) is never reported accepted", async () => {
    const h = await createStack();
    const chat = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
    await fsPromises.mkdir(path.dirname(chat), { recursive: true });
    await fsPromises.appendFile(
      chat,
      [
        JSON.stringify({ id: "noparts", role: "user", metadata: { sendIds: ["s-noparts"] } }),
        JSON.stringify({
          ...createMuxMessage("nodigest", "user", "x"),
          metadata: { sendIds: ["s-nodigest"] },
        }),
        '{"id":"torn","role":"user","metadata":{"sendIds":["s-torn"]',
      ].join("\n")
    );
    expect(
      statusesOf(
        await h.workspaceService.getSendStatus(workspaceId, ["s-noparts", "s-nodigest", "s-torn"])
      )
    ).toEqual({
      "s-noparts": "not-accepted",
      "s-nodigest": "not-accepted",
      "s-torn": "not-accepted",
    });
  });
});
