import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { TaskHandleStore, isActiveWorkspaceTurnTaskStatus } from "@/node/services/taskHandleStore";
import { createWorkspaceTurnManagerHarness } from "@/node/services/workspaceTurnManager.testHarness";
import { Ok, type Result } from "@/common/types/result";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  makeWorkspaceTurnCreateMock,
  saveLocalParentWorkspace,
  stubStableIds,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";

/**
 * Full GCs until the target is collected; a few rounds absorb stale conservative stack slots.
 * Under coverage in CI's shared unit lane, Bun needed up to 30 full GCs before the records were
 * collected, so 20 failed now and then (#7401, probe run 40097463511): hence the bound of 100.
 * After 20 rounds each round also waits 5 ms, so timers get a turn between collections too.
 */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let round = 0; round < 100 && ref.deref() !== undefined; round++) {
    await Bun.sleep(round < 20 ? 0 : 5);
    Bun.gc(true);
  }
  return ref.deref() === undefined;
}

describe("WorkspaceTurnManager.createWorkspaceTurn retention", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-wtm-retention-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  // F29 heap snapshot: the turn's onCanceled callback outlives the turn (a moved background
  // command keeps it reachable), and through its shared scope it kept the full list of every
  // owner's workspace-turn records, about 82 MB per copy in a long-lived server.
  test("a retained onCanceled callback does not keep the list of all workspace turns alive", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: makeWorkspaceTurnCreateMock(config, projectPath),
      sendMessage,
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Settled records are every owner's history. With one on disk, a listing that holds all
    // records holds a settled one, and the callback must not keep such a listing alive.
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "settled-child", "wst_settled", "completed")
    );
    let listings = 0;
    const historyRefs: Array<WeakRef<object>> = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original receiver
    const listAll = TaskHandleStore.prototype.listAllWorkspaceTurns;
    const listSpy = spyOn(TaskHandleStore.prototype, "listAllWorkspaceTurns").mockImplementation(
      async function (this: TaskHandleStore, ...args: Parameters<typeof listAll>) {
        const records = await listAll.apply(this, args);
        listings += 1;
        if (records.some((record) => !isActiveWorkspaceTurnTaskStatus(record.status))) {
          historyRefs.push(new WeakRef(records));
        }
        return records;
      }
    );

    try {
      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        prompt: "Summarize the repo",
        title: "Workspace turn",
        workspace: { mode: "new" },
      });
      expect(result.success).toBe(true);
      expect(listings).toBeGreaterThan(0);
      const internal = (sendMessage.mock.calls[0] as unknown[])[3] as { onCanceled?: unknown };
      const onCanceled = internal.onCanceled;
      expect(typeof onCanceled).toBe("function");
      // Mocks record their calls and results, which would keep the array reachable themselves.
      sendMessage.mockClear();
      listSpy.mockClear();

      for (const ref of historyRefs) expect(await collected(ref)).toBe(true);
      // Keep the callback reachable until after the collection check.
      expect(typeof onCanceled).toBe("function");
    } finally {
      listSpy.mockRestore();
    }
    // One full GC takes about 55 ms under coverage in CI, so 100 rounds need about 6 s.
  }, 20_000);
});
