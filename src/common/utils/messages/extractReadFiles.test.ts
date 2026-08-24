import { describe, expect, it } from "bun:test";

import type { XumMessage } from "@/common/types/message";
import { MAX_POST_COMPACTION_READ_FILES } from "@/constants/rlmCompaction";

import { extractReadFilePaths, mergeReadFilePaths } from "./extractReadFiles";

function createAssistantMessage(
  toolCalls: Array<{
    toolName: string;
    filePath?: string;
    success?: boolean;
    state?: "output-available" | "input-available";
  }>
): XumMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: toolCalls.map((tc) =>
      tc.state === "input-available"
        ? {
            type: "dynamic-tool" as const,
            toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
            toolName: tc.toolName,
            state: "input-available" as const,
            input: { path: tc.filePath },
          }
        : {
            type: "dynamic-tool" as const,
            toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
            toolName: tc.toolName,
            state: "output-available" as const,
            input: { path: tc.filePath },
            output: { success: tc.success ?? true },
          }
    ),
  };
}

describe("extractReadFilePaths", () => {
  it("extracts successful file_read paths newest-first, deduped", () => {
    const messages: XumMessage[] = [
      createAssistantMessage([
        { toolName: "file_read", filePath: "/a.ts" },
        { toolName: "file_read", filePath: "/b.ts" },
      ]),
      createAssistantMessage([{ toolName: "file_read", filePath: "/a.ts" }]),
      createAssistantMessage([{ toolName: "file_read", filePath: "/c.ts" }]),
    ];

    expect(extractReadFilePaths(messages)).toEqual(["/c.ts", "/a.ts", "/b.ts"]);
  });

  it("preserves whitespace in path identity (no trim)", () => {
    // Leading/trailing whitespace is legal in path bytes. Normalizing would
    // advertise " report.txt" as "report.txt" post-compaction — a DIFFERENT
    // file — so the agent both believes it read a file it never touched and
    // loses the reference to the one it did.
    const messages = [
      createAssistantMessage([
        { toolName: "file_read", filePath: " report.txt" },
        { toolName: "file_read", filePath: "report.txt " },
      ]),
    ];
    expect(extractReadFilePaths(messages)).toEqual(["report.txt ", " report.txt"]);
  });

  it("ignores failed reads, interrupted calls, and non-read tools", () => {
    const messages: XumMessage[] = [
      createAssistantMessage([
        { toolName: "file_read", filePath: "/failed.ts", success: false },
        { toolName: "file_read", filePath: "/interrupted.ts", state: "input-available" },
        { toolName: "file_edit_insert", filePath: "/edited.ts" },
        { toolName: "file_read", filePath: "/ok.ts" },
      ]),
    ];

    expect(extractReadFilePaths(messages)).toEqual(["/ok.ts"]);
  });

  it("extracts nested kernel reads (xum.file_read / xum.load) from code_execution output", () => {
    // RLM exclusive posture: reads happen inside code_execution as nested
    // records, so the outer part is code_execution and the paths live in
    // output.toolCalls. Kernel compact records use ok; load records have no
    // ok field and signal failure via error.
    const codeExecutionMessage: XumMessage = {
      id: "msg-kernel",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool" as const,
          toolCallId: "tc-kernel",
          toolName: "code_execution",
          state: "output-available" as const,
          input: { code: "..." },
          output: {
            success: true,
            toolCalls: [
              { toolName: "file_read", args: { path: "/nested-read.ts" }, ok: true, bytes: 10 },
              { toolName: "load", args: { path: "/loaded.jsonl", key: "data" } },
              // Failures and non-read nested calls are ignored.
              { toolName: "file_read", args: { path: "/nested-failed.ts" }, error: "denied" },
              { toolName: "load", args: { path: "/load-failed.txt", key: "x" }, error: "missing" },
              { toolName: "bash", args: { path: "/not-a-read.sh" }, ok: true },
              // file_read resolves with {success:false} instead of throwing
              // for missing/oversized/directory paths — non-compacted records
              // carry that result and must not be advertised as read (r22).
              {
                toolName: "file_read",
                args: { path: "/resolved-but-failed.ts" },
                result: { success: false, error: "File not found" },
              },
            ],
          },
        },
      ],
    };
    const messages: XumMessage[] = [
      createAssistantMessage([{ toolName: "file_read", filePath: "/direct.ts" }]),
      codeExecutionMessage,
    ];

    // Newest-first at every level: within the execution, /loaded.jsonl is
    // chronologically after /nested-read.ts, so it surfaces first.
    expect(extractReadFilePaths(messages)).toEqual([
      "/loaded.jsonl",
      "/nested-read.ts",
      "/direct.ts",
    ]);
  });

  it("caps the extracted list", () => {
    const messages = [
      createAssistantMessage(
        Array.from({ length: MAX_POST_COMPACTION_READ_FILES + 20 }, (_, i) => ({
          toolName: "file_read",
          filePath: `/file-${i}.ts`,
        }))
      ),
    ];

    expect(extractReadFilePaths(messages)).toHaveLength(MAX_POST_COMPACTION_READ_FILES);
  });

  it("keeps the NEWEST reads when a single batched execution exceeds the cap", () => {
    // Nested kernel records are chronological within one code_execution; the
    // cap must evict the OLDEST reads, so traversal is reversed at every
    // level. A forward inner loop would retain the earliest paths and drop
    // the files the agent just used.
    const overCap = MAX_POST_COMPACTION_READ_FILES + 20;
    const message: XumMessage = {
      id: "msg-big-batch",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool" as const,
          toolCallId: "tc-big-batch",
          toolName: "code_execution",
          state: "output-available" as const,
          input: { code: "..." },
          output: {
            success: true,
            toolCalls: Array.from({ length: overCap }, (_, i) => ({
              toolName: "file_read",
              args: { path: `/batched-${i}.ts` },
              ok: true,
              bytes: 10,
            })),
          },
        },
      ],
    };

    const extracted = extractReadFilePaths([message]);
    expect(extracted).toHaveLength(MAX_POST_COMPACTION_READ_FILES);
    // Newest (chronologically last) read first; oldest reads evicted.
    expect(extracted[0]).toBe(`/batched-${overCap - 1}.ts`);
    expect(extracted).not.toContain("/batched-0.ts");
    expect(extracted).not.toContain(`/batched-${overCap - MAX_POST_COMPACTION_READ_FILES - 1}.ts`);
  });
});

describe("mergeReadFilePaths", () => {
  it("puts incoming (newer) paths first and dedupes against existing", () => {
    expect(mergeReadFilePaths(["/old.ts", "/both.ts"], ["/new.ts", "/both.ts"])).toEqual([
      "/new.ts",
      "/both.ts",
      "/old.ts",
    ]);
  });

  it("preserves whitespace in paths and keeps whitespace-distinct files separate", () => {
    // " report.txt" and "report.txt" are different files; trimming during the
    // merge would collapse them and advertise the wrong already-read path.
    expect(mergeReadFilePaths(["report.txt"], [" report.txt"])).toEqual([
      " report.txt",
      "report.txt",
    ]);
  });

  it("caps the merged list, evicting the oldest entries", () => {
    const existing = Array.from({ length: MAX_POST_COMPACTION_READ_FILES }, (_, i) => `/old-${i}`);
    const incoming = ["/new-1", "/new-2"];

    const merged = mergeReadFilePaths(existing, incoming);
    expect(merged).toHaveLength(MAX_POST_COMPACTION_READ_FILES);
    expect(merged.slice(0, 2)).toEqual(incoming);
    expect(merged).not.toContain(`/old-${MAX_POST_COMPACTION_READ_FILES - 1}`);
    expect(merged).not.toContain(`/old-${MAX_POST_COMPACTION_READ_FILES - 2}`);
  });
});
