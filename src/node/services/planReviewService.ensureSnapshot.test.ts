import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
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

/**
 * A sibling backend (XUM_ALLOW_MULTIPLE_INSTANCES) shares the session directory and the
 * cross-process history write lock but none of WorkspaceService's in-memory mutation fencing,
 * so it is modelled as a second HistoryService over the same config.
 */
describe("ensurePlanSnapshot against a sibling backend's history mutation", () => {
  let handle: Awaited<ReturnType<typeof createTestHistoryService>>;
  let sibling: HistoryService;
  const emitted: MuxMessage[] = [];

  beforeEach(async () => {
    handle = await createTestHistoryService();
    sibling = new HistoryService(handle.config);
    emitted.length = 0;
    const seeded = await handle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "please plan", {})
    );
    expect(seeded.success).toBe(true);
    const planPath = expandTilde(getPlanFilePath(workspaceId, projectName));
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, "# Plan\n\nStep one\n");
  });

  afterEach(async () => {
    await handle.cleanup();
    await fs.rm(planDir, { recursive: true, force: true });
  });

  /** Run `mutate` in the sibling after the plan read, right before the locked append. */
  async function captureWithSiblingMutation(
    mutate: () => Promise<unknown>,
    refuseAfterHistoryRemoval: boolean
  ) {
    const original = handle.historyService.appendDerivedFromFullHistory.bind(handle.historyService);
    const spy = spyOn(handle.historyService, "appendDerivedFromFullHistory").mockImplementation(
      async <T>(
        id: string,
        derive: (messages: MuxMessage[]) => { message: MuxMessage | null; value: T }
      ) => {
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
        { workspaceId, metadata, refuseAfterHistoryRemoval }
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

  test("an on-demand capture refuses to append into history a sibling cleared after the read", async () => {
    const captured = await captureWithSiblingMutation(
      () => sibling.truncateHistory(workspaceId, 1),
      true
    );
    expect(!captured.success && captured.error.type).toBe("capture_aborted");
    expect(emitted).toHaveLength(0);
    expect(await snapshotCount()).toBe(0);
  });

  test("sibling appends alone do not refuse an on-demand capture", async () => {
    const captured = await captureWithSiblingMutation(
      () => sibling.appendToHistory(workspaceId, createMuxMessage("user-2", "user", "more", {})),
      true
    );
    expect(captured.success && captured.data.created).toBe(true);
    expect(await snapshotCount()).toBe(1);
  });

  test("turn-owned captures (no anchor check) still append after rows were replaced", async () => {
    // Mid-turn compaction can legitimately replace rows under a turn-owned capture; its fencing
    // is the turn's abort signal, so the anchor check is opt-in for on-demand captures only.
    const captured = await captureWithSiblingMutation(
      () => sibling.truncateHistory(workspaceId, 1),
      false
    );
    expect(captured.success && captured.data.created).toBe(true);
    expect(await snapshotCount()).toBe(1);
  });
});
