import { describe, expect, it } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { listRefinements } from "@/node/services/refinement/refinementRollback";
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

  it("refuses to roll back a global skill when the sandbox blocks global writes", async () => {
    using tempDir = new TestTempDir("refinement-rollback-tool-global");
    const sessionDir = path.join(tempDir.path, "sessions", "ws");
    const skillFile = path.join(tempDir.path, "skills", "my-skill", "SKILL.md");
    await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
    await fsPromises.writeFile(skillFile, "body\n", "utf-8");
    await appendRefinementEvent({
      sessionDir,
      workspaceId: "ws",
      kind: "skill",
      action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
      inverse: { op: "delete-files", paths: [skillFile] },
      evidence: { toolName: "agent_skill_write" },
    });
    const [row] = await listRefinements(sessionDir);
    const tool = createRefinementRollbackTool({
      workspaceId: "ws",
      sessionDir,
      blocksGlobalWrites: () => true,
    });

    const result: unknown = await tool.execute!(
      { id: row.id, reason: "test" },
      mockToolCallOptions
    );

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain("agent sandbox blocks");
    expect(await fsPromises.readFile(skillFile, "utf-8")).toBe("body\n");
  });
});
