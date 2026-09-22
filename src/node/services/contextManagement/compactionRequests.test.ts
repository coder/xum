import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";
import {
  RLM_COMPACTION_CHARS_PER_TOKEN,
  RLM_KEEP_RECENT_FLOOR_TOKENS,
} from "@/constants/rlmCompaction";
import type { HistoryService } from "../historyService";
import { createTestHistoryService } from "../testHistoryService";
import { computeKeepRecentTailStamp } from "./compactionRequests";

const workspaceId = "keep-recent-tail-workspace";

/**
 * Hidden plan snapshot row whose content alone exceeds the whole keep-recent floor. Real plan
 * snapshots can approach the 256 KiB record cap, so this is a realistic size, not a corner case.
 */
function oversizedSnapshotRow(id: string): MuxMessage {
  const record: PlanReviewRecord = {
    v: 1,
    kind: "snapshot",
    recordId: `rec_${id}`,
    snapshotId: `snap_${id}`,
    planPath: "/plans/p.md",
    contentHash: "a".repeat(64),
    content: "x".repeat((RLM_KEEP_RECENT_FLOOR_TOKENS + 1) * RLM_COMPACTION_CHARS_PER_TOKEN),
  };
  return createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
    synthetic: true,
    muxMetadata: buildPlanReviewMetadata(record),
  });
}

function fileSnapshotRow(id: string): MuxMessage {
  return createMuxMessage(id, "user", "snapshot: file contents", {
    synthetic: true,
    fileAtMentionSnapshot: ["src/foo.ts"],
  });
}

describe("computeKeepRecentTailStamp", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function append(...messages: MuxMessage[]): Promise<void> {
    for (const message of messages) {
      const result = await historyService.appendToHistory(workspaceId, message);
      expect(result.success).toBe(true);
    }
  }

  /** The durable sequence HistoryService stamped on the persisted row with this id. */
  async function persistedSequence(id: string): Promise<number> {
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    const row = history.success ? history.data.find((message) => message.id === id) : undefined;
    const sequence = row?.metadata?.historySequence;
    if (typeof sequence !== "number") {
      throw new Error(`row ${id} was not persisted with a historySequence`);
    }
    return sequence;
  }

  test("returns no stamp while RLM keep-recent is disabled", async () => {
    await append(
      createMuxMessage("u0", "user", "start"),
      createMuxMessage("a0", "assistant", "reply")
    );
    expect(await computeKeepRecentTailStamp(historyService, workspaceId, false)).toBeUndefined();
  });

  test("does not charge an oversized hidden snapshot appended after the newest turn", async () => {
    // Typical plan-mode tail: the snapshot record lands after the assistant's proposal. It never
    // reaches a provider request, so it must not consume the floor and drop the visible tail.
    await append(
      createMuxMessage("u0", "user", "start"),
      createMuxMessage("a0", "assistant", "reply"),
      createMuxMessage("u1", "user", "propose the plan"),
      createMuxMessage("a1", "assistant", "Proposed."),
      oversizedSnapshotRow("s1")
    );

    expect(await computeKeepRecentTailStamp(historyService, workspaceId, true)).toEqual({
      startHistorySequence: await persistedSequence("u1"),
    });
  });

  test("does not charge an oversized hidden snapshot persisted before the newest human turn", async () => {
    // Sitting directly above the newest real user row, the hidden record would otherwise be
    // pulled into that row's snapshot cluster and push the only safe boundary over the floor.
    await append(
      createMuxMessage("u0", "user", "start"),
      createMuxMessage("a0", "assistant", "reply"),
      oversizedSnapshotRow("s1"),
      createMuxMessage("u1", "user", "next"),
      createMuxMessage("a1", "assistant", "Proposed.")
    );

    expect(await computeKeepRecentTailStamp(historyService, workspaceId, true)).toEqual({
      startHistorySequence: await persistedSequence("u1"),
    });
  });

  test("stamps the durable sequence of the @file prelude, not its position among visible rows", async () => {
    // The hidden record between the answered turn and the next prompt's @file snapshot is
    // skipped, but the stamp must still be the prelude row's persisted historySequence.
    await append(
      createMuxMessage("u0", "user", "start"),
      createMuxMessage("a0", "assistant", "reply"),
      oversizedSnapshotRow("s1"),
      fileSnapshotRow("f1"),
      createMuxMessage("u1", "user", "@src/foo.ts what does this do?"),
      createMuxMessage("a1", "assistant", "it does things")
    );

    // The prelude is the 4th persisted row but only the 3rd visible one, so a leaked
    // visible-row index would not equal its durable sequence.
    expect(await computeKeepRecentTailStamp(historyService, workspaceId, true)).toEqual({
      startHistorySequence: await persistedSequence("f1"),
    });
  });
});
