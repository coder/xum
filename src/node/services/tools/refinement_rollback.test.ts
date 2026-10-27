import { describe, expect, it } from "bun:test";
import * as path from "node:path";

import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import { createRefinementRollbackTool } from "./refinement_rollback";
import { mockToolCallOptions, TestTempDir } from "./testHelpers";

describe("refinement_rollback", () => {
  it("takes the rollback lock from the locks in its context", async () => {
    using tempDir = new TestTempDir("refinement-rollback-tool-locks");
    const sessionDir = path.join(tempDir.path, "session");
    // The turn's SessionLocks (phase 4) take the rollback lock, not the Node default.
    const lockPaths: string[] = [];
    const locks: SessionLocks = {
      ...nodeSessionLocks,
      acquireProcessFileLock: (options) => {
        lockPaths.push(options.lockPath);
        return nodeSessionLocks.acquireProcessFileLock(options);
      },
    };
    const tool = createRefinementRollbackTool({ workspaceId: "ws", sessionDir, locks });

    const result: unknown = await tool.execute!(
      { id: "missing", reason: "test" },
      mockToolCallOptions
    );

    expect(result).toMatchObject({ success: false });
    expect(lockPaths).toEqual([path.join(path.resolve(sessionDir), "refinement-rollback.lock")]);
  });
});
