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
  omitPostCompactionContextFrom,
  renderPostCompactionContext,
  restorePostCompactionContextBefore,
  shiftContextUsageByHeader,
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

const plan = { path: "/plans/ws.md", content: "plan v1", modifiedTimeMs: 5 };

describe("renderPostCompactionContext", () => {
  test("returns no header without attachments", () => {
    expect(renderPostCompactionContext([], plan)).toBeNull();
  });

  test("carries the plan baseline only when the text renders the plan", () => {
    const planAttachment = {
      type: "plan_file_reference" as const,
      planFilePath: plan.path,
      planContent: plan.content,
    };
    const todos = {
      type: "todo_list" as const,
      todos: [{ content: "a", status: "pending" as const }],
    };
    expect(renderPostCompactionContext([planAttachment, todos], plan)?.plan).toEqual(plan);
    const withoutPlan = renderPostCompactionContext([todos], plan);
    expect(withoutPlan?.text.length).toBeGreaterThan(0);
    expect(withoutPlan?.plan).toBeUndefined();
  });

  test("keeps the text within the injection budget", () => {
    const context = renderPostCompactionContext(
      [
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
      ],
      null
    );
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
    const mixedFields = JSON.parse(
      '{"text":"CTX","skillNames":["a",1],"omittedFromRequestSequence":"3","plan":{"path":"p"}}'
    ) as PostCompactionContext;
    expect(findPostCompactionContext([compactionBoundary("summary", mixedFields)])).toEqual({
      text: "CTX",
      skillNames: ["a"],
    });
  });
});

describe("omitPostCompactionContextFrom", () => {
  const renderedHeaders = (messages: MuxMessage[]) =>
    insertPostCompactionContext(messages)
      .filter((message) => message.id.startsWith("post-compaction-context-"))
      .map((message) => message.parts);

  test("leaves the header out of requests from the sequence on, and replay restores it before", () => {
    const omitted = omitPostCompactionContextFrom(compactionBoundary("s", header("CTX")), 7);
    if (!omitted) throw new Error("expected the header to be left out");
    const messages = [omitted, createMuxMessage("u1", "user", "first")];

    expect(renderedHeaders(messages)).toEqual([]);
    expect(findPostCompactionContext(messages)).toBeNull();
    expect(renderedHeaders(restorePostCompactionContextBefore(messages, 6))).toEqual([
      [{ type: "text", text: "CTX" }],
    ]);
    expect(restorePostCompactionContextBefore(messages, 7)).toBe(messages);
    // A second retry cannot leave out a header that requests no longer render.
    expect(omitPostCompactionContextFrom(omitted, 9)).toBeNull();
  });

  test("removes the header's tokens from the boundary's context usage", () => {
    const usage = { inputTokens: 100, outputTokens: 0, totalTokens: 100 };
    const boundary = compactionBoundary("s", header("CTX ".repeat(500)));
    const counted = shiftContextUsageByHeader(
      { ...boundary, metadata: { ...boundary.metadata, contextUsage: usage } },
      1
    );
    expect(counted.metadata?.contextUsage?.inputTokens).toBeGreaterThan(100);

    expect(omitPostCompactionContextFrom(counted, 7)?.metadata?.contextUsage).toEqual(usage);
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

  test("drops the header with its plan baseline when the baseline does not fit", () => {
    const bare = compactionBoundary("s");
    const text = "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES / 2);
    const bigPlan = { ...plan, content: "y".repeat(SESSION_HISTORY_MAX_LINE_BYTES / 2) };
    expect(withPostCompactionContext(bare, { ...header(text), plan: bigPlan }, "ws")).toBe(bare);
  });
});
