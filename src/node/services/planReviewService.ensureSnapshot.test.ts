import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import type { Runtime } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS } from "@/constants/planReview";
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
  async function captureWithSiblingMutation(
    mutate: () => Promise<unknown>,
    proposedContent?: string
  ) {
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
        { workspaceId, metadata, ...(proposedContent !== undefined ? { proposedContent } : {}) }
      );
    } finally {
      spy.mockRestore();
    }
  }

  const deletePlan = () => fs.rm(expandTilde(getPlanFilePath(workspaceId, projectName)));

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

  test("a capture is refused when the plan was deleted after the read, even without a generation change", async () => {
    // A compaction-boundary replace (or a clear of empty history) with deletePlanFile keeps the
    // generation; deleting the plan before its commit is what keeps these bytes out.
    await seedRow();
    const captured = await captureWithSiblingMutation(deletePlan);
    expect(!captured.success && captured.error.type).toBe("plan_missing");
    expect(emitted).toHaveLength(0);
    expect(await snapshotCount()).toBe(0);
  });

  test("a proposal capture is refused once the plan file is deleted, not once it is edited", async () => {
    await seedRow();
    // Existence, not equality: the proposed bytes still land after a later edit...
    const edited = await captureWithSiblingMutation(
      () => fs.writeFile(expandTilde(getPlanFilePath(workspaceId, projectName)), "# Edited\n"),
      "# Plan\n\nProposed\n"
    );
    expect(edited.success && edited.data.created).toBe(true);
    // ...but not after the plan was deleted.
    const deleted = await captureWithSiblingMutation(deletePlan, "# Plan\n\nProposed again\n");
    expect(!deleted.success && deleted.error.type).toBe("plan_missing");
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

  /**
   * The existence probe runs while the append holds the cross-process history write lock. SSH
   * metadata routes it through one remote exec; the runtime is a real local one (so the plan read
   * works) whose exec these tests control, standing in for a slow or stalled host.
   */
  describe("existence probe under the history lock", () => {
    const remoteMetadata = {
      ...metadata,
      runtimeConfig: { type: "ssh" as const, host: "remote.invalid", srcBaseDir: "~/src" },
    };
    let runtime: Runtime;
    let probeSignals: AbortSignal[];
    let probeCount: number;

    beforeEach(() => {
      runtime = runtimeFactory.createRuntime(
        { type: "local" },
        { projectPath: metadata.projectPath }
      );
      spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
      probeSignals = [];
      probeCount = 0;
    });

    afterEach(() => {
      mock.restore();
    });

    /**
     * Intercept the runtime's exec calls. With a local runtime the plan read uses the filesystem,
     * so every exec here is the existence probe. `stall` makes it never answer, like a hung host.
     */
    function watchProbe(options: { stall: boolean; onStart?: () => void }) {
      const original = runtime.exec.bind(runtime);
      spyOn(runtime, "exec").mockImplementation((command, execOptions) => {
        probeCount += 1;
        if (execOptions.abortSignal) probeSignals.push(execOptions.abortSignal);
        options.onStart?.();
        return options.stall ? new Promise(() => undefined) : original(command, execOptions);
      });
    }

    function capture(
      options: { signal?: AbortSignal; beforeAppend?: () => Promise<unknown> } = {}
    ) {
      const original = handle.historyService.appendDerivedFromFullHistory.bind(
        handle.historyService
      );
      const spy = spyOn(handle.historyService, "appendDerivedFromFullHistory").mockImplementation(
        async <T>(id: string, derive: Derive<T>) => {
          await options.beforeAppend?.();
          return original(id, derive);
        }
      );
      return ensurePlanSnapshot(
        {
          historyService: handle.historyService,
          emitChatEvent: (_id, message) => emitted.push(message),
        },
        {
          workspaceId,
          metadata: remoteMetadata,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }
      ).finally(() => spy.mockRestore());
    }

    test("one remote exec probes both plan paths and refuses once the plan is gone", async () => {
      await seedRow();
      watchProbe({ stall: false });
      const found = await capture();
      expect(found.success && found.data.created).toBe(true);
      const gone = await capture({ beforeAppend: deletePlan });
      expect(!gone.success && gone.error.type).toBe("plan_missing");
      expect(probeCount).toBe(2);
      expect(await snapshotCount()).toBe(1);
    });

    test("a stalled remote probe refuses the capture within its bound and frees the lock", async () => {
      await seedRow();
      watchProbe({ stall: true });
      const startedAt = Date.now();
      const captured = await capture();
      const elapsed = Date.now() - startedAt;
      // Fail closed: an unanswered probe refuses instead of skipping the check.
      expect(!captured.success && captured.error.type).toBe("capture_aborted");
      expect(elapsed).toBeLessThan(PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS + 2_000);
      // The abandoned remote command is cancelled too.
      expect(probeSignals).toHaveLength(1);
      expect(probeSignals[0]?.aborted).toBe(true);
      // The history write lock is free again: another backend's append goes through at once
      // instead of waiting out the lock timeout.
      const appendStartedAt = Date.now();
      const appended = await sibling.appendToHistory(
        workspaceId,
        createMuxMessage("user-2", "user", "after the probe", {})
      );
      expect(appended.success).toBe(true);
      expect(Date.now() - appendStartedAt).toBeLessThan(2_000);
      expect(await snapshotCount()).toBe(0);
    }, 20_000);

    test("the capture's abort ends a stalled probe well before the bound", async () => {
      await seedRow();
      const controller = new AbortController();
      watchProbe({ stall: true, onStart: () => setTimeout(() => controller.abort(), 50) });
      const startedAt = Date.now();
      const captured = await capture({ signal: controller.signal });
      expect(!captured.success && captured.error.type).toBe("capture_aborted");
      expect(Date.now() - startedAt).toBeLessThan(PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS / 2);
      expect(probeSignals[0]?.aborted).toBe(true);
      expect(await snapshotCount()).toBe(0);
    }, 20_000);
  });
});
