import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  getSubagentAttemptSettlementReceiptPath,
  readSubagentAttemptSettlementReceiptStrict,
  writeSubagentAttemptSettlementReceipt,
} from "@/node/services/subagentAttemptSettlements";
import { isTaskAttemptId, newTaskAttemptId } from "@/node/utils/taskAttemptId";

describe("subagentAttemptSettlements", () => {
  let root: string;
  let parentDir: string;
  let grandparentDir: string;
  const taskId = "child/task:1";

  beforeEach(async () => {
    root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "attempt-receipts-"));
    parentDir = path.join(root, "parent");
    grandparentDir = path.join(root, "grandparent");
  });

  afterEach(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  test("mints well-formed, distinct attempt ids", () => {
    const first = newTaskAttemptId();
    const second = newTaskAttemptId();
    expect(isTaskAttemptId(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(isTaskAttemptId("att_short")).toBe(false);
    expect(isTaskAttemptId(undefined)).toBe(false);
  });

  test("unwritten attempt reads not_found; written attempt reads found in every owner dir", async () => {
    const attemptId = newTaskAttemptId();
    expect(await readSubagentAttemptSettlementReceiptStrict(parentDir, taskId, attemptId)).toEqual({
      kind: "not_found",
    });
    const written = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir, grandparentDir],
      receipt: {
        taskId,
        attemptId,
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(written).toEqual({ success: true, data: undefined });
    for (const dir of [parentDir, grandparentDir]) {
      const read = await readSubagentAttemptSettlementReceiptStrict(dir, taskId, attemptId);
      expect(read).toEqual({
        kind: "found",
        receipt: {
          version: 1,
          taskId,
          attemptId,
          parentWorkspaceId: "parent",
          source: "idle-settled",
          settledAt: "2026-09-18T00:00:00.000Z",
        },
      });
    }
    // The path encodes the task id so ids with separators cannot escape the directory.
    expect(getSubagentAttemptSettlementReceiptPath(parentDir, taskId, attemptId)).toBe(
      path.join(
        parentDir,
        "subagent-attempt-settlements",
        encodeURIComponent(taskId),
        `${attemptId}.json`
      )
    );
  });

  test("a second write of the same attempt is a no-op that keeps the original receipt", async () => {
    const attemptId = newTaskAttemptId();
    const receipt = {
      taskId,
      attemptId,
      parentWorkspaceId: "parent",
      source: "execution-settled" as const,
      settledAt: "2026-09-18T00:00:00.000Z",
    };
    await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir],
      receipt,
    });
    const again = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir],
      receipt: { ...receipt, source: "launch-failed", settledAt: "2026-09-19T00:00:00.000Z" },
    });
    expect(again.success).toBe(true);
    const read = await readSubagentAttemptSettlementReceiptStrict(parentDir, taskId, attemptId);
    expect(read.kind).toBe("found");
    if (read.kind === "found") expect(read.receipt.source).toBe("execution-settled");
  });

  test("a receipt for another attempt never matches, and corrupt or mismatched files read unreadable", async () => {
    const attemptId = newTaskAttemptId();
    const other = newTaskAttemptId();
    await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir],
      receipt: {
        taskId,
        attemptId: other,
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(await readSubagentAttemptSettlementReceiptStrict(parentDir, taskId, attemptId)).toEqual({
      kind: "not_found",
    });

    const corruptPath = getSubagentAttemptSettlementReceiptPath(parentDir, taskId, attemptId);
    await fsPromises.mkdir(path.dirname(corruptPath), { recursive: true });
    await fsPromises.writeFile(corruptPath, "{not json", "utf-8");
    const corrupt = await readSubagentAttemptSettlementReceiptStrict(parentDir, taskId, attemptId);
    expect(corrupt.kind).toBe("unreadable");

    // A body naming a different attempt at this path is evidence of nothing.
    await fsPromises.writeFile(
      corruptPath,
      JSON.stringify({
        version: 1,
        taskId,
        attemptId: other,
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      }),
      "utf-8"
    );
    const mismatched = await readSubagentAttemptSettlementReceiptStrict(
      parentDir,
      taskId,
      attemptId
    );
    expect(mismatched.kind).toBe("unreadable");
    // Writing over an unreadable file is refused, not repaired: the write reports the conflict.
    const conflicting = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir],
      receipt: {
        taskId,
        attemptId,
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(conflicting.success).toBe(false);
    expect(
      await readSubagentAttemptSettlementReceiptStrict(parentDir, taskId, "not-an-id")
    ).toMatchObject({
      kind: "unreadable",
    });
  });

  test("malformed ids and empty owner lists are refused without touching disk", async () => {
    const refused = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [parentDir],
      receipt: {
        taskId,
        attemptId: "bogus",
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(refused.success).toBe(false);
    const noOwner = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [],
      receipt: {
        taskId,
        attemptId: newTaskAttemptId(),
        parentWorkspaceId: "parent",
        source: "idle-settled",
        settledAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(noOwner.success).toBe(false);
    let parentDirExists = true;
    try {
      await fsPromises.access(parentDir);
    } catch {
      parentDirExists = false;
    }
    expect(parentDirExists).toBe(false);
  });
});
