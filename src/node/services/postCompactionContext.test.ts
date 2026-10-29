import { describe, expect, test } from "bun:test";
import { MAX_POST_COMPACTION_INJECTION_CHARS } from "@/common/constants/attachments";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/utils/messages/compactionBoundary";
import {
  createMuxMessage,
  type MuxMessage,
  type PostCompactionContext,
} from "@/common/types/message";
import {
  findPostCompactionContext,
  insertPostCompactionContext,
  renderPostCompactionContext,
  withPostCompactionContext,
} from "./postCompactionContext";

const compactionBoundary = (id: string, postCompactionContext?: PostCompactionContext) =>
  createMuxMessage(id, "assistant", `summary ${id}`, {
    timestamp: 1000,
    compacted: "user",
    compactionBoundary: true,
    compactionEpoch: 1,
    postCompactionContext,
  });

const header = (text: string): PostCompactionContext => ({ text, skillNames: [] });

describe("renderPostCompactionContext", () => {
  test("returns no header without attachments", () => {
    expect(renderPostCompactionContext([])).toBeNull();
  });

  test("keeps the text within the injection budget", () => {
    const context = renderPostCompactionContext([
      {
        type: "edited_files_reference",
        files: [
          {
            path: "src/huge.ts",
            diff: "x".repeat(MAX_POST_COMPACTION_INJECTION_CHARS + 10_000),
            truncated: false,
          },
        ],
      },
    ]);
    expect(context?.text.length).toBeGreaterThan(0);
    expect(context?.text.length).toBeLessThanOrEqual(MAX_POST_COMPACTION_INJECTION_CHARS);
  });
});

describe("insertPostCompactionContext", () => {
  test("inserts the latest boundary's header right after that boundary", () => {
    const older = compactionBoundary("older", header("OLD"));
    const latest = compactionBoundary("latest", header("NEW"));
    const u1 = createMuxMessage("u1", "user", "first");
    const u2 = createMuxMessage("u2", "user", "second");

    const result = insertPostCompactionContext([older, u1, latest, u2]);

    expect(result.map((message) => message.id)).toEqual([
      "older",
      "u1",
      "latest",
      "post-compaction-context-latest",
      "u2",
    ]);
    expect(result[3]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "NEW" }],
      metadata: { timestamp: 1000, synthetic: true },
    });
    expect(result[3].metadata?.historySequence).toBeUndefined();
  });

  test("inserts nothing when a reset boundary follows the compaction", () => {
    const reset = createMuxMessage("reset", "assistant", "", {
      contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
    });
    const messages = [
      compactionBoundary("summary", header("STALE")),
      createMuxMessage("u1", "user", "first"),
      reset,
    ];
    expect(insertPostCompactionContext(messages)).toBe(messages);
    expect(findPostCompactionContext(messages)).toBeNull();
  });

  test("ignores a malformed persisted header", () => {
    for (const persisted of ['{"text":42}', '{"text":""}', "null"]) {
      const messages = [
        compactionBoundary("summary", JSON.parse(persisted) as PostCompactionContext),
        createMuxMessage("u1", "user", "first"),
      ];
      expect(insertPostCompactionContext(messages)).toBe(messages);
    }
    const mixedNames = JSON.parse('{"text":"CTX","skillNames":["a",1]}') as PostCompactionContext;
    expect(findPostCompactionContext([compactionBoundary("summary", mixedNames)])).toEqual({
      text: "CTX",
      skillNames: ["a"],
    });
  });
});

describe("withPostCompactionContext", () => {
  const boundaryHeader = (message: MuxMessage) => message.metadata?.postCompactionContext;

  test("sets the header only on a boundary without one", () => {
    const fresh = withPostCompactionContext(compactionBoundary("s"), header("NEW"), "ws");
    expect(boundaryHeader(fresh)).toEqual(header("NEW"));

    const existing = compactionBoundary("s", header("KEPT"));
    expect(withPostCompactionContext(existing, header("NEW"), "ws")).toBe(existing);

    const bare = compactionBoundary("s");
    expect(withPostCompactionContext(bare, null, "ws")).toBe(bare);
  });

  test("drops a header that would push the row over the history line limit", () => {
    const bare = compactionBoundary("s");
    const oversized = header("x".repeat(SESSION_HISTORY_MAX_LINE_BYTES));
    expect(withPostCompactionContext(bare, oversized, "ws")).toBe(bare);
  });
});
