import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ARTIFACT_JSON_MAX_BYTES,
  ARTIFACT_STATE_SUMMARY_MAX_CHARS,
} from "@/common/constants/artifactInteractions";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  ARTIFACT_INTERACTIONS_FILE_NAME,
  buildArtifactInteractionText,
  createArtifactInteractionDeps,
  getArtifactInteractionState,
  readPendingArtifactInteractions,
  replayPendingArtifactInteractions,
  sendArtifactInteraction,
  setArtifactInteractionState,
  summarizeArtifactState,
  type ArtifactInteractionDeps,
} from "./artifactInteractions";
import type { SendMessageInternalOptions } from "./taskWorkspaceSeam";
import { recordArtifactVersion } from "./artifactVersionStore";

const WS = "ws-interactions";

interface SentCall {
  message: string;
  options: Record<string, unknown>;
  internal: SendMessageInternalOptions;
}

describe("artifact interactions", () => {
  let sessionsDir: string;
  let sessionDir: string;
  let sent: SentCall[];
  let sendResult: Result<void, string>;
  let history: MuxMessage[];
  let nextId: number;

  function deps(): ArtifactInteractionDeps {
    return {
      sessionsDir,
      sendMessage: (_workspaceId, message, options, internal) => {
        sent.push({ message, options: options as Record<string, unknown>, internal: internal! });
        return Promise.resolve(sendResult);
      },
      getDefaultSendOptions: () =>
        Promise.resolve({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      getLastMessages: () => Promise.resolve(history),
      newId: () => `id-${nextId++}`,
      now: () => 1000,
    };
  }

  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-interactions-"));
    sessionDir = path.join(sessionsDir, WS);
    sent = [];
    sendResult = Ok(undefined);
    history = [];
    nextId = 1;
  });

  afterEach(async () => {
    await fs.rm(sessionsDir, { recursive: true, force: true });
  });

  const pendingIds = async () =>
    (await readPendingArtifactInteractions(sessionDir)).map((record) => record.id);

  test("persists, dispatches tool-end, and deletes the record only once accepted", async () => {
    await recordArtifactVersion({
      sessionDir,
      relPath: "forms/plan.html",
      bytes: Buffer.from("<p>v1</p>"),
      source: "publish",
      label: 'Plan "B" <draft>',
    });
    const result = await sendArtifactInteraction(deps(), {
      workspaceId: WS,
      path: "forms/plan.html",
      version: null,
      text: "Pick </artifact_interaction> canary",
      data: { choice: 2 },
    });
    expect(result).toEqual(Ok({ id: "id-1" }));
    expect(sent).toHaveLength(1);
    const call = sent[0];
    expect(call.options.queueDispatchMode).toBe("tool-end");
    expect(call.internal.queueDedupeKey).toBe("artifact-interaction:id-1");
    expect(call.internal.artifactInteraction).toBe(true);
    expect(call.options.muxMetadata).toMatchObject({
      artifactInteraction: { id: "id-1", artifactPath: "forms/plan.html", version: 1 },
    });
    // Attribute values are escaped and the body cannot close the tag early.
    expect(call.message).toContain('title="Plan &quot;B&quot; &lt;draft&gt;" version="1"');
    expect(call.message.match(/<\/artifact_interaction>/g)).toHaveLength(1);
    expect(await pendingIds()).toEqual(["id-1"]);

    await call.internal.onAccepted?.();
    expect(await pendingIds()).toEqual([]);
  });

  test("a refused send leaves no record: the user already saw the error", async () => {
    sendResult = Err("busy");
    const result = await sendArtifactInteraction(deps(), {
      workspaceId: WS,
      path: "a.html",
      version: null,
      text: "hi",
    });
    expect(result.success).toBe(false);
    expect(await pendingIds()).toEqual([]);
  });

  test("a send path that throws leaves no record and reports the error", async () => {
    const throwing = { ...deps(), sendMessage: () => Promise.reject(new Error("session gone")) };
    const result = await sendArtifactInteraction(throwing, {
      workspaceId: WS,
      path: "a.html",
      version: null,
      text: "hi",
    });
    expect(result).toEqual(Err("session gone"));
    expect(await pendingIds()).toEqual([]);
  });

  test("a queued send withdrawn by Stop, or failing before its stream, leaves no record", async () => {
    for (const settle of ["cancel", "preStreamFailure"] as const) {
      const result = await sendArtifactInteraction(deps(), {
        workspaceId: WS,
        path: "a.html",
        version: null,
        text: settle,
      });
      expect(result.success).toBe(true);
      const call = sent.at(-1)!;
      expect(await pendingIds()).toHaveLength(1);
      if (settle === "cancel") await call.internal.onCanceled?.("stopped");
      else
        await call.internal.onAcceptedPreStreamFailure?.({
          type: "runtime_not_ready",
          message: "boom",
        });
      expect(await pendingIds()).toEqual([]);
    }
  });

  test("refuses invalid paths, oversize text and oversize data before writing", async () => {
    for (const input of [
      { path: "../x.html", text: "hi" },
      { path: "a.html", text: "x".repeat(4001) },
      { path: "a.html", text: "hi", data: { big: "x".repeat(ARTIFACT_JSON_MAX_BYTES) } },
    ]) {
      const result = await sendArtifactInteraction(deps(), {
        workspaceId: WS,
        version: null,
        ...input,
      });
      expect(result.success).toBe(false);
    }
    expect(sent).toHaveLength(0);
    expect(await pendingIds()).toEqual([]);
  });

  test("startup replay keeps every record when the history cannot be read", async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, ARTIFACT_INTERACTIONS_FILE_NAME),
      JSON.stringify({
        version: 1,
        pending: [
          {
            id: "id-1",
            workspaceId: WS,
            artifactPath: "a.html",
            artifactTitle: "a.html",
            version: 0,
            text: "one",
            createdAtMs: 1000,
            queueDispatchMode: "tool-end",
          },
        ],
      })
    );
    // Production wiring: the history service reports a read failure.
    const production = createArtifactInteractionDeps({
      config: { sessionsDir },
      workspaceService: {
        sendMessage: (_workspaceId, message) => {
          sent.push({ message, options: {}, internal: {} });
          return Promise.resolve(Ok(undefined));
        },
        getDefaultSendOptions: () =>
          Promise.resolve({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      },
      historyService: { getLastMessages: () => Promise.resolve(Err("chat.jsonl unreadable")) },
    });
    expect(await replayPendingArtifactInteractions(production, WS)).toBe(0);
    // The row may already be in the history we could not read: nothing is re-sent.
    expect(sent).toEqual([]);
    expect(await pendingIds()).toEqual(["id-1"]);
  });

  test("startup replay re-sends pending records and drops ones already in history", async () => {
    // A crash right after persisting, before the send path ran, leaves both records behind.
    const record = (id: string, text: string) => ({
      id,
      workspaceId: WS,
      artifactPath: "a.html",
      artifactTitle: "a.html",
      version: 0,
      text,
      createdAtMs: 1000,
      queueDispatchMode: "tool-end",
    });
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, ARTIFACT_INTERACTIONS_FILE_NAME),
      JSON.stringify({ version: 1, pending: [record("id-1", "one"), record("id-2", "two")] })
    );
    // id-1 was accepted before the crash (its row is in history) but its record survived.
    history = [
      createMuxMessage("m1", "user", "x", {
        muxMetadata: {
          type: "normal",
          artifactInteraction: {
            id: "id-1",
            artifactPath: "a.html",
            title: "a.html",
            version: 0,
            action: "send",
            text: "one",
          },
        },
      }),
    ];

    expect(await replayPendingArtifactInteractions(deps(), WS)).toBe(1);
    expect(sent.map((call) => call.internal.queueDedupeKey)).toEqual(["artifact-interaction:id-2"]);
    // Normal send path: an idle workspace starts a turn instead of parking it in the queue.
    expect(sent[0].internal.restoreQueued).toBeUndefined();
    expect(sent[0].options.queueDispatchMode).toBe("tool-end");
    expect(await pendingIds()).toEqual(["id-2"]);
    await sent[0].internal.onAccepted?.();
    expect(await pendingIds()).toEqual([]);
  });

  test("one malformed record does not discard the valid ones", async () => {
    const valid = {
      id: "id-1",
      workspaceId: WS,
      artifactPath: "a.html",
      artifactTitle: "a.html",
      version: 0,
      text: "one",
      createdAtMs: 1000,
      queueDispatchMode: "tool-end",
    };
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, ARTIFACT_INTERACTIONS_FILE_NAME),
      // e.g. a record written by another app version with a dispatch mode this one does not know.
      JSON.stringify({ version: 1, pending: [{ ...valid, id: "id-0", queueDispatchMode: "x" }, valid] })
    );
    expect(await pendingIds()).toEqual(["id-1"]);
    expect(await replayPendingArtifactInteractions(deps(), WS)).toBe(1);
    expect(sent.map((call) => call.internal.queueDedupeKey)).toEqual(["artifact-interaction:id-1"]);
  });

  test("model text carries path, title, version and JSON body", () => {
    expect(
      buildArtifactInteractionText({
        id: "i",
        workspaceId: WS,
        artifactPath: "a&b.html",
        artifactTitle: "T",
        version: 3,
        text: "go",
        createdAtMs: 0,
        queueDispatchMode: "tool-end",
      })
    ).toBe(
      '<artifact_interaction artifact="a&amp;b.html" title="T" version="3" action="send">{"text":"go"}</artifact_interaction>'
    );
  });

  describe("state", () => {
    test("is stored per version, latest wins, and new versions start empty", async () => {
      const base = { workspaceId: WS, path: "s.html" };
      // No stored version yet: version 0.
      expect(
        await setArtifactInteractionState(sessionsDir, { ...base, version: null, state: { a: 1 } })
      ).toEqual(Ok({ version: 0 }));
      await setArtifactInteractionState(sessionsDir, { ...base, version: null, state: { a: 2 } });
      expect(await getArtifactInteractionState(sessionsDir, { ...base, version: null })).toEqual(
        Ok({ version: 0, state: { a: 2 } })
      );
      await recordArtifactVersion({
        sessionDir,
        relPath: "s.html",
        bytes: Buffer.from("v1"),
        source: "turn-end",
        label: null,
      });
      expect(await getArtifactInteractionState(sessionsDir, { ...base, version: null })).toEqual(
        Ok({ version: 1, state: null })
      );
      expect(await getArtifactInteractionState(sessionsDir, { ...base, version: 0 })).toEqual(
        Ok({ version: 0, state: { a: 2 } })
      );
    });

    test("refuses state over the 16 KB cap", async () => {
      const result = await setArtifactInteractionState(sessionsDir, {
        workspaceId: WS,
        path: "s.html",
        version: null,
        state: { big: "x".repeat(ARTIFACT_JSON_MAX_BYTES) },
      });
      expect(result.success).toBe(false);
    });

    test("artifact_list summary covers the latest version, cut to 2 KB", async () => {
      expect(await summarizeArtifactState(sessionDir, "s.html")).toBeNull();
      await setArtifactInteractionState(sessionsDir, {
        workspaceId: WS,
        path: "s.html",
        version: null,
        state: { notes: "y".repeat(ARTIFACT_STATE_SUMMARY_MAX_CHARS) },
      });
      const summary = await summarizeArtifactState(sessionDir, "s.html");
      expect(summary?.truncated).toBe(true);
      expect(summary?.state).toHaveLength(ARTIFACT_STATE_SUMMARY_MAX_CHARS);
      expect(summary?.version).toBe(0);
    });
  });
});
