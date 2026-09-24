import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { HistoryService } from "./historyService";
import { ensurePlanSnapshot, getPlanReviewState } from "./planReviewService";
import { createTestHistoryService } from "./testHistoryService";

// Plan files live under the runtime's xum home, like the AgentSession snapshot suite; unique
// names keep parallel runs apart and afterEach removes them.
const projectName = `plan-review-ensure-${process.pid}-${Date.now()}`;
const planDir = expandTilde(path.dirname(getPlanFilePath("x", projectName)));
const workspaceId = "ws-plan-review-ensure";
const metadata = {
  id: workspaceId,
  name: workspaceId,
  projectName,
  projectPath: "/tmp/project",
  runtimeConfig: { type: "local" as const },
};

type Derive<T> = (
  messages: MuxMessage[],
  lockState: { generation: string | undefined }
) => { message: MuxMessage | null; value: T };

/**
 * A sibling backend (XUM_ALLOW_MULTIPLE_INSTANCES, or the desktop app beside `xum server`)
 * shares the session directory and the cross-process history write lock but none of
 * WorkspaceService's in-memory mutation fencing, so it is modelled as a second HistoryService
 * (and, for a full clear, a second AgentSession) over the same config.
 */
describe("on-demand ensurePlanSnapshot against a sibling backend's history mutation", () => {
  let handle: Awaited<ReturnType<typeof createTestHistoryService>>;
  let sibling: HistoryService;
  const emitted: MuxMessage[] = [];

  beforeEach(async () => {
    handle = await createTestHistoryService();
    sibling = new HistoryService(handle.config);
    emitted.length = 0;
    const planPath = expandTilde(getPlanFilePath(workspaceId, projectName));
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, "# Plan\n\nStep one\n");
  });

  afterEach(async () => {
    await handle.cleanup();
    await fs.rm(planDir, { recursive: true, force: true });
  });

  async function seedRow() {
    const seeded = await handle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "please plan", {})
    );
    expect(seeded.success).toBe(true);
  }

  /**
   * The sibling's full clear, through the same call WorkspaceService.truncateHistory makes for a
   * full clear (clearHistoryThroughCompactionCancellation). It deletes the plan file as well.
   */
  async function siblingFullClear() {
    const other = await createAgentSessionHarness({
      workspaceId,
      config: handle.config,
      historyService: sibling,
    });
    try {
      let deleted: number[] | undefined;
      const cleared = await other.session.cancelCompaction(true, undefined, {
        fullHistoryDeletion: {
          percentage: 1,
          onCommitted: (sequences) => {
            deleted = sequences;
            return undefined;
          },
        },
      });
      expect(cleared.success).toBe(true);
      expect(deleted).toBeDefined();
      await fs.rm(expandTilde(getPlanFilePath(workspaceId, projectName)), { force: true });
    } finally {
      await other.session.dispose();
      await other.cleanup();
    }
  }

  /** Run `mutate` in the sibling after the plan read, right before the locked append. */
  async function captureWithSiblingMutation(mutate: () => Promise<unknown>) {
    const original = handle.historyService.appendDerivedFromFullHistory.bind(handle.historyService);
    const spy = spyOn(handle.historyService, "appendDerivedFromFullHistory").mockImplementation(
      async <T>(id: string, derive: Derive<T>) => {
        await mutate();
        return original(id, derive);
      }
    );
    try {
      return await ensurePlanSnapshot(
        {
          historyService: handle.historyService,
          emitChatEvent: (_id, message) => emitted.push(message),
        },
        { workspaceId, metadata }
      );
    } finally {
      spy.mockRestore();
    }
  }

  async function snapshotCount(): Promise<number> {
    const state = await getPlanReviewState(handle.historyService, workspaceId);
    expect(state.success).toBe(true);
    return state.success ? state.data.snapshots.length : -1;
  }

  test("a capture refuses to append into history a sibling fully cleared after the read", async () => {
    await seedRow();
    const captured = await captureWithSiblingMutation(siblingFullClear);
    expect(!captured.success && captured.error.type).toBe("capture_aborted");
    expect(emitted).toHaveLength(0);
    expect(await snapshotCount()).toBe(0);
  });

  test("a capture over empty history refuses to append after a sibling's full clear", async () => {
    // No row exists to anchor on: a clear of empty history still deletes the plan file, so the
    // pre-clear bytes must not land either.
    const captured = await captureWithSiblingMutation(siblingFullClear);
    expect(!captured.success && captured.error.type).toBe("capture_aborted");
    expect(emitted).toHaveLength(0);
    expect(await snapshotCount()).toBe(0);
  });

  test("a capture over empty history with no concurrent mutation still appends", async () => {
    const captured = await captureWithSiblingMutation(() => Promise.resolve());
    expect(captured.success && captured.data.created).toBe(true);
    expect(await snapshotCount()).toBe(1);
  });

  test("sibling appends alone do not refuse a capture", async () => {
    await seedRow();
    const captured = await captureWithSiblingMutation(() =>
      sibling.appendToHistory(workspaceId, createMuxMessage("user-2", "user", "more", {}))
    );
    expect(captured.success && captured.data.created).toBe(true);
    expect(await snapshotCount()).toBe(1);
  });

  test("a sibling's compaction boundary does not refuse a capture", async () => {
    await seedRow();
    const captured = await captureWithSiblingMutation(() =>
      sibling.persistBoundaryWithTailCopies(
        workspaceId,
        createMuxMessage("summary-1", "assistant", "summary", {
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        }),
        [],
        false
      )
    );
    expect(captured.success && captured.data.created).toBe(true);
    expect(await snapshotCount()).toBe(1);
  });
});
