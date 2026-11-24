import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";

import type {
  BashToolResult,
  FileEditReplaceStringToolResult,
  FileReadToolResult,
  WebFetchToolResult,
} from "@/common/types/tools";
import { formatToolEnd, formatToolStart } from "./toolFormatters";

describe("formatToolEnd(task)", () => {
  it("formats grouped running task results with spawned task IDs", () => {
    const formatted = formatToolEnd(
      {
        type: "tool-call-end",
        workspaceId: "parent",
        messageId: "message-1",
        toolCallId: "tool-task-1",
        toolName: "task",
        result: {
          status: "running",
          taskIds: ["task-a", "task-b"],
          tasks: [
            { taskId: "task-a", status: "running" },
            { taskId: "task-b", status: "queued" },
          ],
          note: "Tasks continue in background.",
        },
        timestamp: Date.now(),
      },
      {
        agentId: "explore",
        prompt: "compare options",
        title: "Best of 2",
        n: 2,
      }
    );

    expect(formatted).toContain("running:");
    expect(formatted).toContain("task-a");
    expect(formatted).toContain("task-b");
  });

  it("formats grouped completed task results with report counts", () => {
    const formatted = formatToolEnd(
      {
        type: "tool-call-end",
        workspaceId: "parent",
        messageId: "message-1",
        toolCallId: "tool-task-1",
        toolName: "task",
        result: {
          status: "completed",
          taskIds: ["task-a", "task-b"],
          reports: [
            {
              taskId: "task-a",
              title: "Candidate one",
              reportMarkdown: "Report one",
              agentId: "explore",
              agentType: "explore",
            },
            {
              taskId: "task-b",
              title: "Candidate two",
              reportMarkdown: "Report two",
              agentId: "explore",
              agentType: "explore",
            },
          ],
        },
        timestamp: Date.now(),
      },
      {
        agentId: "explore",
        prompt: "compare options",
        title: "Best of 2",
        n: 2,
      }
    );

    expect(formatted).toContain("2 reports");
    expect(formatted).toContain("task-a");
    expect(formatted).toContain("task-b");
  });
});

function endEvent(toolName: string, result: unknown): string | null {
  return formatToolEnd({
    type: "tool-call-end",
    workspaceId: "ws",
    messageId: "message-1",
    toolCallId: "call-1",
    toolName,
    result,
    timestamp: 0,
  });
}

function plainEnd(toolName: string, result: unknown): string | null {
  const formatted = endEvent(toolName, result);
  return formatted === null ? null : stripVTControlCharacters(formatted);
}

function plainStart(toolName: string, args: unknown): string | null {
  const formatted = formatToolStart({
    type: "tool-call-start",
    workspaceId: "ws",
    messageId: "message-1",
    toolCallId: "call-1",
    toolName,
    args,
    tokens: 0,
    timestamp: 0,
  });
  return formatted === null ? null : stripVTControlCharacters(formatted);
}

describe("CLI tool formatters", () => {
  // The formatters color through the shared chalk instance. Pin a color level so the
  // diff-coloring checks do not depend on whether the test process has a TTY.
  let savedLevel: typeof chalk.level;
  beforeAll(() => {
    savedLevel = chalk.level;
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = savedLevel;
  });

  it("colors added, removed and hunk lines of an edit diff, but not file headers", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new", " same"].join("\n");
    const result = {
      success: true,
      diff,
      edits_applied: 1,
    } satisfies FileEditReplaceStringToolResult;

    const lines = endEvent("file_edit_replace_string", result)?.split("\n");
    // Guard: the color level above really adds escape codes.
    expect(lines?.[3]).not.toBe("-old");
    expect(lines).toEqual([
      "--- a/x.ts",
      "+++ b/x.ts",
      chalk.cyan("@@ -1 +1 @@"),
      chalk.red("-old"),
      chalk.green("+new"),
      " same",
    ]);
  });

  it("reports edit failures with the error, or a default when the error is empty", () => {
    expect(plainEnd("file_edit_insert", { success: false, error: "anchor not found" })).toBe(
      "✗ anchor not found"
    );
    expect(plainEnd("file_edit_replace_lines", { success: false, error: "" })).toBe(
      "✗ Edit failed"
    );
    // A success without a diff, or a missing result, still shows a check mark.
    expect(plainEnd("file_edit_insert", { success: true, diff: "" })).toBe("✓");
    expect(plainEnd("file_edit_insert", undefined)).toBe("✓");
  });

  it("shows the read range of a file_read call only when one is given", () => {
    expect(plainStart("file_read", { path: "src/a.ts" })).toBe("📖 src/a.ts");
    expect(plainStart("file_read", { path: "src/a.ts", offset: 10, limit: 5 })).toBe(
      "📖 src/a.ts (L10, +5)"
    );
    expect(plainStart("file_read", { file_path: "src/a.ts", limit: 5 })).toBe("📖 src/a.ts (+5)");
    expect(plainStart("file_read", { filePath: "src/a.ts", offset: 3 })).toBe("📖 src/a.ts (L3)");
    expect(plainStart("file_read", { offset: 3 })).toBeNull();
  });

  it("summarizes file_read results with line count and size", () => {
    const read = {
      success: true,
      file_size: 2048,
      modifiedTime: "2026-01-01T00:00:00.000Z",
      lines_read: 12,
      content: "1\tx",
    } satisfies FileReadToolResult;
    expect(plainEnd("file_read", read)).toBe("✓ 12 lines (2.0KB)");
    expect(plainEnd("file_read", { ...read, file_size: 0, lines_read: 0 })).toBe("✓");
    expect(plainEnd("file_read", { success: false, error: "ENOENT" })).toBe("✗ ENOENT");
    expect(plainEnd("file_read", { success: false, error: "" })).toBe("✗ Read failed");
    // Unknown shapes fall back to the generic formatter.
    expect(plainEnd("file_read", { content: "x" })).toBeNull();
  });

  it("formats bash results: background spawns, exit codes, duration and output", () => {
    const background = {
      success: true,
      output: "",
      exitCode: 0,
      wall_duration_ms: 5,
      taskId: "bash:7",
      backgroundProcessId: "proc-7",
    } satisfies BashToolResult;
    expect(plainEnd("bash", background)).toBe("→ background: proc-7");

    const ok = {
      success: true,
      output: "hello\nworld",
      exitCode: 0,
      wall_duration_ms: 1500,
    } satisfies BashToolResult;
    expect(plainEnd("bash", ok)).toBe("exit:0 (1.5s)\n  hello\n  world");
    // No duration suffix when the duration is zero, and whitespace-only output is hidden.
    expect(plainEnd("bash", { ...ok, output: "  \n ", wall_duration_ms: 0 })).toBe("exit:0");

    const failed = {
      success: false,
      exitCode: 2,
      error: "command failed",
      wall_duration_ms: 0,
    } satisfies BashToolResult;
    expect(plainEnd("bash", failed)).toBe("exit:2\n  command failed");
    expect(plainEnd("bash", "not a record")).toBeNull();
  });

  it("keeps the first 20 lines of long bash output and counts the rest", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const formatted = plainEnd("bash", {
      success: true,
      output: lines.join("\n"),
      exitCode: 0,
      wall_duration_ms: 0,
    } satisfies BashToolResult);

    const shown = formatted?.split("\n") ?? [];
    expect(shown[0]).toBe("exit:0");
    expect(shown.slice(1, 21)).toEqual(lines.slice(0, 20).map((line) => `  ${line}`));
    expect(shown.slice(21)).toEqual(["  ... 5 more lines"]);
  });

  it("formats built-in web_fetch results, unwrapped or wrapped in an SDK JSON value", () => {
    const fetched = {
      success: true,
      title: "Docs",
      content: "body",
      url: "https://example.com",
      length: 2048,
    } satisfies WebFetchToolResult;
    expect(plainEnd("web_fetch", fetched)).toBe('✓ "Docs" 2.0KB');
    expect(plainEnd("web_fetch", { type: "json", value: fetched })).toBe('✓ "Docs" 2.0KB');
    expect(plainEnd("web_fetch", { ...fetched, title: "", length: 0 })).toBe("✓");
    expect(plainEnd("web_fetch", { success: false, error: "HTTP 404" })).toBe("✗ HTTP 404");
    expect(plainEnd("web_fetch", { success: false })).toBe("✗ Fetch failed");
  });

  it("formats Anthropic-native web_fetch results and errors", () => {
    expect(
      plainEnd("web_fetch", {
        type: "web_fetch_result",
        url: "https://example.com",
        content: { title: "Example", source: { data: "hello" } },
      })
    ).toBe('✓ "Example" 5B');
    expect(plainEnd("web_fetch", { type: "web_fetch_result", url: "https://example.com" })).toBe(
      "✓"
    );
    expect(
      plainEnd("web_fetch", { type: "web_fetch_tool_result_error", errorCode: "url_not_allowed" })
    ).toBe("✗ url_not_allowed");
    expect(plainEnd("web_fetch", { type: "web_fetch_tool_result_error" })).toBe("✗ fetch error");
  });

  it("falls back to the generic formatter for web_fetch results it cannot read", () => {
    expect(plainEnd("web_fetch", null)).toBeNull();
    expect(plainEnd("web_fetch", "text")).toBeNull();
    expect(plainEnd("web_fetch", { type: "json", value: "text" })).toBeNull();
    expect(plainEnd("web_fetch", { url: "https://example.com" })).toBeNull();
  });

  it("previews code_execution results up to 10 lines", () => {
    expect(plainEnd("code_execution", "done")).toBe("✓\n  done");
    expect(plainEnd("code_execution", { answer: 42 })).toBe('✓\n  {\n    "answer": 42\n  }');
    expect(plainEnd("code_execution", "   ")).toBe("✓");
    expect(plainEnd("code_execution", null)).toBeNull();

    const lines = Array.from({ length: 13 }, (_, i) => `row ${i + 1}`);
    const shown = plainEnd("code_execution", lines.join("\n"))?.split("\n") ?? [];
    expect(shown.slice(1, 11)).toEqual(lines.slice(0, 10).map((line) => `  ${line}`));
    expect(shown.slice(11)).toEqual(["  ... 3 more lines"]);
  });
});
