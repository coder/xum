import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  TERMINAL_ATTENTION_DIR,
  TerminalAttentionStore,
} from "@/node/services/terminalAttentionStore";

function makeConfig(rootDir: string): { sessionsDir: string } {
  return { sessionsDir: path.join(rootDir, "sessions") };
}

describe("TerminalAttentionStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "terminal-attention-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("enqueueIfAbsent persists a pending notification and reloads it", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    const created = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst_abc",
    });
    expect(created).not.toBeNull();
    expect(created?.status).toBe("pending");

    const persisted = JSON.parse(
      await fsPromises.readFile(
        path.join(
          path.join(makeConfig(rootDir).sessionsDir, "owner-1"),
          TERMINAL_ATTENTION_DIR,
          `${encodeURIComponent("workspace_turn:wst_abc")}.json`
        ),
        "utf-8"
      )
    ) as unknown;
    expect(persisted).toMatchObject({
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });

    const pending = await store.listPending("owner-1");
    expect(pending.map((n) => n.sourceId)).toEqual(["wst_abc"]);
  });

  test("loads pending notifications written with legacy derived fields", async () => {
    const config = makeConfig(rootDir);
    const dir = path.join(config.sessionsDir, "owner-1", TERMINAL_ATTENTION_DIR);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, `${encodeURIComponent("agent_task:task-1")}.json`),
      JSON.stringify({
        id: "agent_task:task-1",
        ownerWorkspaceId: "owner-1",
        sourceKind: "agent_task",
        sourceId: "task-1",
        outputDelivery: "already_injected",
        terminalOutcome: "completed",
        status: "pending",
        createdAt: "2026-08-01T00:00:00.000Z",
      })
    );

    expect((await new TerminalAttentionStore(config).listPending("owner-1"))[0]).toMatchObject({
      sourceId: "task-1",
      status: "pending",
    });
  });

  test("enqueueIfAbsent is idempotent by source kind + id", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    const base = {
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task" as const,
      sourceId: "task-1",
    };
    const first = await store.enqueueIfAbsent(base);
    const second = await store.enqueueIfAbsent(base);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await store.listPending("owner-1")).toHaveLength(1);
  });

  test("agent task generations enqueue independently of prior state or timestamps", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    const legacy = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task",
      sourceId: "task-1",
      createdAt: "zzz",
    });
    expect(legacy).not.toBeNull();
    await store.markDelivered("owner-1", legacy!.id);

    const generation = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task",
      sourceId: "task-1",
      generationId: "wst_generation_2",
    });

    expect(generation).not.toBeNull();
    if (generation == null) return;
    expect(generation).toMatchObject({
      id: "agent_task:task-1:wst_generation_2",
      generationId: "wst_generation_2",
      status: "pending",
    });
    expect(await store.listPending("owner-1")).toEqual([generation]);
  });

  test("delivered notifications are not redelivered and survive reload", async () => {
    const config = makeConfig(rootDir);
    const store = new TerminalAttentionStore(config);
    const created = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst_done",
    });
    await store.markDelivered("owner-1", created!.id);

    // Reload via a fresh store instance to prove durability.
    const reloaded = new TerminalAttentionStore(config);
    expect(await reloaded.listPending("owner-1")).toHaveLength(0);
    // Re-enqueue is suppressed because the delivered record still exists.
    expect(
      await reloaded.enqueueIfAbsent({
        ownerWorkspaceId: "owner-1",
        sourceKind: "workspace_turn",
        sourceId: "wst_done",
      })
    ).toBeNull();
  });

  test("listPending coalesces and orders multiple sources for one owner", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task",
      sourceId: "task-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst-b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const pending = await store.listPending("owner-1");
    expect(pending.map((n) => n.sourceId)).toEqual(["task-a", "wst-b"]);
  });

  test("listPendingOwnerWorkspaceIds finds pending notifications across session dirs", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-b",
      sourceKind: "workspace_turn",
      sourceId: "wst-b",
    });
    const delivered = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-a",
      sourceKind: "agent_task",
      sourceId: "task-a",
    });
    expect(delivered).not.toBeNull();
    await store.markDelivered("owner-a", delivered!.id);
    await fsPromises.mkdir(path.join(rootDir, "sessions", "owner-empty"), { recursive: true });

    expect(await store.listPendingOwnerWorkspaceIds()).toEqual(["owner-b"]);
  });
});
