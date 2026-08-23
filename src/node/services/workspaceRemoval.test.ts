import { describe, expect, test } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { DisposableTempDir } from "@/node/services/tempDir";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import {
  isWorkspaceRemovalTombstoned,
  removeSessionDirUnderMemoryLocks,
  workspaceRemovalTombstonePath,
} from "./workspaceRemoval";

describe("workspaceRemoval", () => {
  test("deletion waits for a live memory writer, then tombstones and deletes (r61)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-removal";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });
    await fsPromises.writeFile(path.join(sessionDir, "memory", "note.md"), "contents\n");
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);

    // A memory writer holds the workspace store's target lock mid-commit.
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => (releaseWriter = resolve));
    let writerDone = false;
    const writer = withTargetMutationLock(rootDir, path.join(sessionDir, "memory"), async () => {
      await writerGate;
      writerDone = true;
    });

    // Removal must serialize behind the writer, not delete under it.
    const removal = removeSessionDirUnderMemoryLocks({ rootDir, sessionDir, workspaceId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);

    releaseWriter();
    await writer;
    await removal;
    expect(writerDone).toBe(true);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
    // Tombstone published and durable — commit points refuse from now on.
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
    const raw = await fsPromises.readFile(
      workspaceRemovalTombstonePath(rootDir, workspaceId),
      "utf-8"
    );
    expect((JSON.parse(raw) as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });
});
