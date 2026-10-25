import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";
import {
  TaskHandleStore,
  WORKSPACE_TURN_TASK_ID_PREFIX,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";

// Runs under Jest (Node) on purpose: Node's fs.promises.writeFile truncates the file and then
// writes it in separate thread-pool steps, so a concurrent readFile can observe an empty file.
// Bun did not interleave these steps in local probes, so the same test under `bun test` would
// pass even without the fix. Production runs on Node (Electron main / server).
describe("TaskHandleStore concurrent reads", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir) {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  test("readers racing a handle update never see the handle as missing (coder/xum#4410)", async () => {
    // Settlement bookkeeping rewrites terminal handles (terminalAttentionNotifiedAt,
    // directParentResultDeliveredAt) while waitForWorkspaceTurn, task_await and task_list read
    // them without the settlement lock. A reader that saw a truncated file got null and failed
    // with "Workspace turn not found or out of scope".
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "task-handle-concurrent-read-"));
    const config = new Config(rootDir);
    const store = new TaskHandleStore(config);
    const handleId = `${WORKSPACE_TURN_TASK_ID_PREFIX}race`;
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: "owner",
      workspaceId: "child",
      turnId: "turn-race",
      status: "completed",
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "report ".repeat(4096),
    };
    await store.upsertWorkspaceTurn(record);

    let writing = true;
    const writer = (async () => {
      try {
        for (let round = 0; round < 200; round++) {
          await store.upsertWorkspaceTurn({ ...record, terminalAttentionNotifiedAt: `${round}` });
        }
      } finally {
        writing = false;
      }
    })();
    let reads = 0;
    let missingReads = 0;
    const readers = Array.from({ length: 4 }, async () => {
      while (writing) {
        reads++;
        if ((await store.getWorkspaceTurn("owner", handleId)) == null) missingReads++;
      }
    });
    await Promise.all([writer, ...readers]);

    expect(reads).toBeGreaterThan(0);
    expect(missingReads).toBe(0);
    // Updates must not leave temp files behind in the handle directory.
    expect(await store.listWorkspaceTurns("owner")).toHaveLength(1);
    expect(
      await fsPromises.readdir(path.join(config.sessionsDir, "owner", "task-handles"))
    ).toEqual([`${handleId}.json`]);
  });
});
