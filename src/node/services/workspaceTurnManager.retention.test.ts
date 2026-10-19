import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { TaskHandleStore } from "@/node/services/taskHandleStore";
import { createWorkspaceTurnManagerHarness } from "@/node/services/workspaceTurnManager.testHarness";
import { Ok, type Result } from "@/common/types/result";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  makeWorkspaceTurnCreateMock,
  saveLocalParentWorkspace,
  stubStableIds,
} from "@/node/services/taskService.testHarness";

/** Full GCs until the target is collected; a few rounds absorb stale conservative stack slots. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let round = 0; round < 20 && ref.deref() !== undefined; round++) {
    await Bun.sleep(0);
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

    // createWorkspaceTurn's own unfiltered listing is the only call without options here.
    const listedRefs: Array<WeakRef<object>> = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original receiver
    const listAll = TaskHandleStore.prototype.listAllWorkspaceTurns;
    const listSpy = spyOn(TaskHandleStore.prototype, "listAllWorkspaceTurns").mockImplementation(
      async function (this: TaskHandleStore, ...args: Parameters<typeof listAll>) {
        const records = await listAll.apply(this, args);
        if (args[0] == null) listedRefs.push(new WeakRef(records));
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
      expect(listedRefs).toHaveLength(1);
      const internal = (sendMessage.mock.calls[0] as unknown[])[3] as { onCanceled?: unknown };
      const onCanceled = internal.onCanceled;
      expect(typeof onCanceled).toBe("function");
      // Mocks record their calls and results, which would keep the array reachable themselves.
      sendMessage.mockClear();
      listSpy.mockClear();

      expect(await collected(listedRefs[0])).toBe(true);
      // Keep the callback reachable until after the collection check.
      expect(typeof onCanceled).toBe("function");
    } finally {
      listSpy.mockRestore();
    }
  });
});
