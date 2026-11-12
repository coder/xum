import { describe, expect, test } from "bun:test";
import {
  COLLAPSED_NESTED_CALL_LIMIT,
  getCodePreviewLine,
  resolveCodeExecutionViewMode,
  selectVisibleNestedCalls,
} from "./codeExecutionViewMode";

describe("getCodePreviewLine", () => {
  test("skips blank and comment lines to the first statement", () => {
    expect(
      getCodePreviewLine("\n// read config\n/* note\n * more\n */\n  const a = 1;\nb();")
    ).toBe("const a = 1;");
  });

  test("returns empty for comment-only scripts", () => {
    expect(getCodePreviewLine("// nothing to run\n")).toBe("");
  });
});

describe("selectVisibleNestedCalls", () => {
  const done = (id: string) => ({ id, state: "output-available" });
  const running = (id: string) => ({ id, state: "input-available" });
  const ids = (calls: ReadonlyArray<{ id: string }>) => calls.map((call) => call.id);

  test("shows the latest calls, and all of them once the user asks", () => {
    const calls = ["a", "b", "c", "d", "e", "f", "g"].map(done);
    expect(calls.length).toBe(COLLAPSED_NESTED_CALL_LIMIT + 3);

    const cut = selectVisibleNestedCalls(calls, false);
    expect(ids(cut.visible)).toEqual(["d", "e", "f", "g"]);
    expect(cut.hiddenCount).toBe(3);

    expect(selectVisibleNestedCalls(calls, true)).toEqual({ visible: calls, hiddenCount: 0 });
    expect(selectVisibleNestedCalls(calls.slice(0, COLLAPSED_NESTED_CALL_LIMIT), false)).toEqual({
      visible: calls.slice(0, COLLAPSED_NESTED_CALL_LIMIT),
      hiddenCount: 0,
    });
  });

  // A call waiting for sandbox approval holds its approval card and shortcuts in its own row.
  test("never cuts an earlier call that has not finished", () => {
    const calls = [
      done("a"),
      running("approval"),
      done("c"),
      done("d"),
      done("e"),
      done("f"),
      done("g"),
    ];

    const cut = selectVisibleNestedCalls(calls, false);
    expect(ids(cut.visible)).toEqual(["approval", "d", "e", "f", "g"]);
    expect(cut.hiddenCount).toBe(2);
  });
});

describe("selectVisibleNestedCalls with MCP App views", () => {
  const done = (id: string) => ({ id, state: "output-available" });

  // The user may have the view open while the script makes more calls: cutting its row would
  // unmount the view.
  test("never cuts an earlier call that carries an MCP App view", () => {
    const calls = [
      done("a"),
      { ...done("board"), mcpServer: { app: { resourceUri: "ui://board" } } },
      // A plain MCP call has no view to keep.
      { ...done("c"), mcpServer: {} },
      done("d"),
      done("e"),
      done("f"),
      done("g"),
    ];

    const cut = selectVisibleNestedCalls(calls, false);
    expect(cut.visible.map((call) => call.id)).toEqual(["board", "d", "e", "f", "g"]);
    expect(cut.hiddenCount).toBe(2);
  });
});

describe("resolveCodeExecutionViewMode", () => {
  test("uses the code view immediately for successful completed executions with no nested tools", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: false,
        noToolCallsDefaultView: "code",
      })
    ).toBe("code");
  });

  test("uses the result view immediately for failed completed executions with no nested tools", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: false,
        noToolCallsDefaultView: "result",
      })
    ).toBe("result");
  });

  test("keeps tools selected while nested tools exist or execution is still active", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: true,
        noToolCallsDefaultView: "code",
      })
    ).toBe("tools");
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: false,
        hasToolCalls: false,
        noToolCallsDefaultView: "code",
      })
    ).toBe("tools");
  });
});
