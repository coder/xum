import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import { EventEmitter } from "events";
import path from "path";
import type { Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import {
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { saveWorkspaces } from "./taskService.testHarness";
import { waitForCondition } from "./testDispatchHelpers";

describe("WorkspaceService metadata listeners", () => {
  let harness: WorkspaceServiceHarness;
  let aiEvents: EventEmitter;

  beforeEach(async () => {
    // The service subscribes to AI stream events in its constructor; route them through a
    // real emitter so the test can drive its listeners.
    aiEvents = new EventEmitter();
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        on: aiEvents.on.bind(aiEvents) as AIService["on"],
        off: aiEvents.off.bind(aiEvents) as AIService["off"],
      }),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("error events clear streaming metadata", async () => {
    const workspaceId = "ws-error";
    const setStreaming = spyOn(harness.extensionMetadata, "setStreaming");

    aiEvents.emit("error", {
      type: "error",
      workspaceId,
      messageId: "msg-1",
      error: "rate limited",
      errorType: "rate_limit",
    });

    await waitForCondition(() => setStreaming.mock.calls.length > 0);
    await setStreaming.mock.results[0]?.value;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    // todoStatus is intentionally NOT passed when there are no todos —
    // see updateStreamingStatus comment for rationale.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      generation: 0,
    });
    expect((await harness.extensionMetadata.getSnapshot(workspaceId))?.streaming).toBe(false);
  });

  test("todo_write events publish todo-derived sidebar status", async () => {
    const workspaceId = "ws-todo-status";
    const setTodoStatus = spyOn(harness.extensionMetadata, "setTodoStatus");
    const readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([
      { content: "Run typecheck", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);

    try {
      aiEvents.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "msg-1",
        toolCallId: "tool-1",
        toolName: "todo_write",
        result: { success: true, count: 2 },
        timestamp: Date.now(),
      });

      await waitForCondition(() => setTodoStatus.mock.calls.length > 0);
      await setTodoStatus.mock.results[0]?.value;

      expect(readTodosSpy).toHaveBeenCalledWith(path.join(harness.config.sessionsDir, workspaceId));
      expect(setTodoStatus).toHaveBeenCalledWith(
        workspaceId,
        { emoji: "🔄", message: "Run typecheck" },
        true
      );
    } finally {
      readTodosSpy.mockRestore();
    }
  });
});

/** A complete config entry, so metadata reads have no legacy fields to migrate. */
function workspaceEntry(
  projectPath: string,
  id: string,
  extra: Partial<Workspace> = {}
): Workspace {
  return {
    path: `${projectPath}/${id}`,
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    ...extra,
  };
}

async function setEntryPinnedAt(
  config: Config,
  projectPath: string,
  id: string,
  pinnedAt: string
): Promise<void> {
  await config.editConfig((cfg) => {
    const entry = cfg.projects.get(projectPath)?.workspaces.find((w) => w.id === id);
    if (!entry) throw new Error(`fixture missing ${id}`);
    entry.pinnedAt = pinnedAt;
    return cfg;
  });
}

describe("WorkspaceService setPinned", () => {
  const projectPath = "/tmp/project";
  const rootId = "ws-root";
  const otherRootId = "ws-other";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const getEntry = (id: string) =>
    harness.config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === id);

  const seedPinnedAt = (id: string, pinnedAt: string) =>
    setEntryPinnedAt(harness.config, projectPath, id, pinnedAt);

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceService = harness.service;
    const entry = (id: string, extra: Partial<Workspace> = {}) =>
      workspaceEntry(projectPath, id, extra);
    await saveWorkspaces(harness.config, projectPath, [
      entry(rootId),
      entry(otherRootId),
      entry(childId, { parentWorkspaceId: rootId }),
      entry(archivedId, { archivedAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("pin persists pinnedAt and emits metadata; unpin clears it and emits", async () => {
    const pinResult = await workspaceService.setPinned(rootId, true);
    expect(pinResult.success).toBe(true);

    const pinnedAt = getEntry(rootId)?.pinnedAt;
    expect(pinnedAt).toBeDefined();
    expect(emittedMetadata).toHaveLength(1);
    expect(emittedMetadata[0].workspaceId).toBe(rootId);
    expect(emittedMetadata[0].metadata?.pinnedAt).toBe(pinnedAt);

    const unpinResult = await workspaceService.setPinned(rootId, false);
    expect(unpinResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();
    expect(emittedMetadata).toHaveLength(2);
    expect(emittedMetadata[1].metadata?.pinnedAt).toBeUndefined();
  });

  test("corrupted boundary pinnedAt on another chat cannot block pinning", async () => {
    // A parseable boundary timestamp has no representable +1ms successor; the
    // global monotonic scan must ignore it rather than fail every future pin.
    await seedPinnedAt(otherRootId, "+275760-09-13T00:00:00.000Z");

    const result = await workspaceService.setPinned(rootId, true);
    expect(result.success).toBe(true);
    const pinnedAt = getEntry(rootId)?.pinnedAt;
    expect(pinnedAt).toBeDefined();
    // The assigned timestamp is a normal near-now value, not a successor of
    // the corrupted boundary.
    expect(new Date(pinnedAt ?? "").getTime()).toBeLessThan(Date.now() + 60_000);
  });

  test("pinning heals a saturated boundary timestamp so keys stay unique", async () => {
    // An existing pin at the sane cap has no strictly-greater sane successor;
    // the write path renumbers pins instead of minting a duplicate key.
    const saneMax = new Date(8_640_000_000_000_000 - 1).toISOString();
    await seedPinnedAt(otherRootId, saneMax);

    const result = await workspaceService.setPinned(rootId, true);
    expect(result.success).toBe(true);
    const rootPinnedAt = getEntry(rootId)?.pinnedAt;
    const otherPinnedAt = getEntry(otherRootId)?.pinnedAt;
    expect(rootPinnedAt).toBeDefined();
    expect(otherPinnedAt).toBeDefined();
    expect(rootPinnedAt).not.toBe(otherPinnedAt);
    // The healed pin sorts before the new pin and both are near-now values.
    expect(new Date(otherPinnedAt ?? "").getTime()).toBeLessThan(
      new Date(rootPinnedAt ?? "").getTime()
    );
    expect(new Date(rootPinnedAt ?? "").getTime()).toBeLessThan(Date.now() + 60_000);
  });

  test("pin-when-pinned and unpin-when-unpinned are no-ops without event churn", async () => {
    const first = await workspaceService.setPinned(rootId, true);
    expect(first.success).toBe(true);
    const firstPinnedAt = getEntry(rootId)?.pinnedAt;
    expect(emittedMetadata).toHaveLength(1);

    // Concurrent double-pin from another client must not move the row.
    const again = await workspaceService.setPinned(rootId, true);
    expect(again.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBe(firstPinnedAt);
    expect(emittedMetadata).toHaveLength(1);

    // Unpinning a chat that is not pinned is also a quiet no-op.
    const noopUnpin = await workspaceService.setPinned(otherRootId, false);
    expect(noopUnpin.success).toBe(true);
    expect(emittedMetadata).toHaveLength(1);
  });

  test("rejects pinning sub-agent and archived workspaces", async () => {
    const subAgentResult = await workspaceService.setPinned(childId, true);
    expect(subAgentResult.success).toBe(false);
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();

    const archivedResult = await workspaceService.setPinned(archivedId, true);
    expect(archivedResult.success).toBe(false);
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();

    expect(emittedMetadata).toHaveLength(0);
  });

  test("pinning after an existing pin yields a strictly greater pinnedAt", async () => {
    expect((await workspaceService.setPinned(otherRootId, true)).success).toBe(true);
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);

    const firstMs = Date.parse(getEntry(otherRootId)?.pinnedAt ?? "");
    const secondMs = Date.parse(getEntry(rootId)?.pinnedAt ?? "");
    expect(secondMs).toBeGreaterThan(firstMs);
  });

  test("appends after an existing future pinnedAt (clock skew)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await seedPinnedAt(otherRootId, future);

    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(Date.parse(getEntry(rootId)?.pinnedAt ?? "")).toBeGreaterThan(Date.parse(future));
  });

  test("archive clears pinnedAt and unarchive does not restore it", async () => {
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();

    const archiveResult = await workspaceService.archive(rootId);
    expect(archiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    const unarchiveResult = await workspaceService.unarchive(rootId);
    expect(unarchiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    // Re-pinning after unarchive works (pin state starts fresh).
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();
  });

  test("unarchive pokes task-side workflow attention reconciliation", async () => {
    const noteWorkspaceUnarchived = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    expect((await workspaceService.archive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).not.toHaveBeenCalled();

    expect((await workspaceService.unarchive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledWith(rootId);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledTimes(1);

    // No archived -> unarchived transition: a repeat unarchive must not re-poke.
    expect((await workspaceService.unarchive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceService reorderPinned", () => {
  const projectPath = "/tmp/project";
  const idA = "ws-a";
  const idB = "ws-b";
  const idC = "ws-c";
  const unpinnedId = "ws-unpinned";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const projectWorkspaces = () =>
    harness.config.loadConfigOrDefault().projects.get(projectPath)?.workspaces ?? [];
  const getEntry = (id: string) => projectWorkspaces().find((w) => w.id === id);

  /** Pinned ids in effective order (pinnedAt asc), as the sidebar sorts them. */
  const pinnedOrder = () =>
    projectWorkspaces()
      .filter((w) => w.id && w.pinnedAt && !w.parentWorkspaceId && !w.archivedAt)
      .sort((a, b) => Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? ""))
      .map((w) => w.id);

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceService = harness.service;
    await saveWorkspaces(harness.config, projectPath, [
      // Pinned block in order A, B, C (pinnedAt ascending).
      workspaceEntry(projectPath, idA, { pinnedAt: "2026-01-01T00:00:00.000Z" }),
      workspaceEntry(projectPath, idB, { pinnedAt: "2026-01-01T00:00:10.000Z" }),
      workspaceEntry(projectPath, idC, { pinnedAt: "2026-01-01T00:00:20.000Z" }),
      workspaceEntry(projectPath, unpinnedId),
      workspaceEntry(projectPath, childId, { parentWorkspaceId: idA }),
      workspaceEntry(projectPath, archivedId, { archivedAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("persists the new order and emits metadata only for displaced rows", async () => {
    // Move C to the front: every rank shifts, so all three rows change.
    const result = await workspaceService.reorderPinned([idC, idA, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idA, idB]);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idA, idB, idC].sort());
    // Emitted metadata carries the rewritten pinnedAt values.
    for (const event of emittedMetadata) {
      expect(event.metadata?.pinnedAt).toBe(getEntry(event.workspaceId)?.pinnedAt);
    }
  });

  test("swapping only a suffix leaves preceding pins untouched", async () => {
    const pinnedAtA = getEntry(idA)?.pinnedAt;
    const result = await workspaceService.reorderPinned([idA, idC, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idC, idB]);
    // A kept its rank, so its timestamp is untouched and no event is emitted for it.
    expect(getEntry(idA)?.pinnedAt).toBe(pinnedAtA);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idB, idC].sort());
  });

  test("no-op order emits nothing and rewrites nothing", async () => {
    const before = [getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt];
    const result = await workspaceService.reorderPinned([idA, idB, idC]);
    expect(result.success).toBe(true);
    expect([getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt]).toEqual(
      before
    );
    expect(emittedMetadata).toHaveLength(0);
  });

  test("drops stale/unpinned/duplicate ids and keeps omitted pins in place", async () => {
    // Client sends duplicates, an unpinned id, a sub-agent, an archived chat,
    // and a ghost id, and omits B entirely: C and A swap within the slots
    // they occupy while omitted B keeps its position.
    const result = await workspaceService.reorderPinned([
      idC,
      idC,
      unpinnedId,
      childId,
      archivedId,
      "ws-ghost",
      idA,
    ]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idB, idA]);
    // Ineligible ids never gain pinnedAt.
    expect(getEntry(unpinnedId)?.pinnedAt).toBeUndefined();
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();
  });

  test("reorder preserves the timestamp pool so setPinned still appends at the bottom", async () => {
    const maxBefore = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    expect((await workspaceService.reorderPinned([idC, idB, idA])).success).toBe(true);
    const maxAfter = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    // Re-dealing the pool must not inflate the max timestamp.
    expect(maxAfter).toBe(maxBefore);

    expect((await workspaceService.setPinned(unpinnedId, true)).success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idB, idA, unpinnedId]);
  });

  test("returns Ok no-op when no id resolves to a workspace", async () => {
    const result = await workspaceService.reorderPinned(["ws-ghost-1", "ws-ghost-2"]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idB, idC]);
    expect(emittedMetadata).toHaveLength(0);
  });

  test("identical pinnedAt values (client races) still reorder deterministically", async () => {
    const same = "2026-01-01T00:00:00.000Z";
    for (const id of [idA, idB, idC]) {
      await setEntryPinnedAt(harness.config, projectPath, id, same);
    }

    const result = await workspaceService.reorderPinned([idB, idC, idA]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idB, idC, idA]);
    // Strictly monotonic after the re-deal.
    const values = [idB, idC, idA].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""));
    expect(values[0]).toBeLessThan(values[1]);
    expect(values[1]).toBeLessThan(values[2]);
  });
});

describe("WorkspaceService reorderPinned across projects", () => {
  const projectA = "/tmp/project-a";
  const projectB = "/tmp/project-b";
  const idA1 = "ws-a1";
  const idA2 = "ws-a2";
  const idA3 = "ws-a3";
  const idB1 = "ws-b1";
  const idB2 = "ws-b2";

  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;

  const projects = () => harness.config.loadConfigOrDefault().projects;
  const findEntry = (id: string) => {
    for (const [projectPath, project] of projects()) {
      const entry = project.workspaces.find((w) => w.id === id);
      if (entry) return { projectPath, entry };
    }
    return undefined;
  };

  /** Pinned ids across all projects in effective order (pinnedAt asc), as the flat sidebar sorts them. */
  const globalPinnedOrder = () =>
    [...projects().values()]
      .flatMap((project) => project.workspaces)
      .filter((w) => w.id && w.pinnedAt && !w.parentWorkspaceId && !w.archivedAt)
      .sort((a, b) => Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? ""))
      .map((w) => w.id);

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceService = harness.service;
    // Interleaved global pin order: a1, b1, a2, b2.
    await saveWorkspaces(
      harness.config,
      projectA,
      [
        workspaceEntry(projectA, idA1, { pinnedAt: "2026-01-01T00:00:00.000Z" }),
        workspaceEntry(projectA, idA2, { pinnedAt: "2026-01-01T00:00:20.000Z" }),
        workspaceEntry(projectA, idA3),
      ],
      {
        extraProjects: [
          [
            projectB,
            {
              workspaces: [
                workspaceEntry(projectB, idB1, { pinnedAt: "2026-01-01T00:00:10.000Z" }),
                workspaceEntry(projectB, idB2, { pinnedAt: "2026-01-01T00:00:30.000Z" }),
              ],
            },
          ],
        ],
      }
    );
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("persists a flat-mode reorder spanning project buckets", async () => {
    const maxBefore = Math.max(
      ...[idA1, idA2, idB1, idB2].map((id) => Date.parse(findEntry(id)?.entry.pinnedAt ?? ""))
    );

    // Drag b1 above a1 in the unified pinned block.
    const result = await workspaceService.reorderPinned([idB1, idA1, idA2, idB2]);
    expect(result.success).toBe(true);
    expect(globalPinnedOrder()).toEqual([idB1, idA1, idA2, idB2]);

    // The timestamp pool is re-dealt, not inflated.
    const maxAfter = Math.max(
      ...[idA1, idA2, idB1, idB2].map((id) => Date.parse(findEntry(id)?.entry.pinnedAt ?? ""))
    );
    expect(maxAfter).toBe(maxBefore);
  });

  test("setPinned appends after the global pinned max, not just its own bucket's", async () => {
    // Give the other bucket the newest pin so a bucket-local max would sort the
    // new pin above it in the flat sidebar's unified block.
    const future = new Date(Date.now() + 60_000).toISOString();
    await setEntryPinnedAt(harness.config, projectB, idB2, future);

    expect((await workspaceService.setPinned(idA3, true)).success).toBe(true);
    expect(globalPinnedOrder().at(-1)).toBe(idA3);
  });

  test("partial cross-bucket reorder keeps omitted pins in their global slots", async () => {
    // The grouped multi-project section sends only its own pinned ids, which
    // can live in different project buckets. Swapping b1 and a2 must not
    // displace the ordinary pins a1 and b2 in the flat global order.
    const a1Before = findEntry(idA1)?.entry.pinnedAt;
    const b2Before = findEntry(idB2)?.entry.pinnedAt;

    const result = await workspaceService.reorderPinned([idA2, idB1]);
    expect(result.success).toBe(true);
    expect(globalPinnedOrder()).toEqual([idA1, idA2, idB1, idB2]);
    // The untouched slots keep their exact timestamps.
    expect(findEntry(idA1)?.entry.pinnedAt).toBe(a1Before);
    expect(findEntry(idB2)?.entry.pinnedAt).toBe(b2Before);
  });

  test("grouped-mode reorder of one bucket leaves other buckets' timestamps untouched", async () => {
    const b1Before = findEntry(idB1)?.entry.pinnedAt;
    const b2Before = findEntry(idB2)?.entry.pinnedAt;

    const result = await workspaceService.reorderPinned([idA2, idA1]);
    expect(result.success).toBe(true);

    // Project A flipped within its own timestamp pool.
    const a1 = Date.parse(findEntry(idA1)?.entry.pinnedAt ?? "");
    const a2 = Date.parse(findEntry(idA2)?.entry.pinnedAt ?? "");
    expect(a2).toBeLessThan(a1);
    // Project B was not referenced, so its entries are byte-identical.
    expect(findEntry(idB1)?.entry.pinnedAt).toBe(b1Before);
    expect(findEntry(idB2)?.entry.pinnedAt).toBe(b2Before);
  });
});
