import { describe, expect, test } from "bun:test";
import {
  COLLAPSED_NESTED_CALL_LIMIT,
  getCodePreviewLine,
  getHiddenNestedCallCount,
  resolveCodeExecutionViewMode,
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

describe("getHiddenNestedCallCount", () => {
  test("hides only the calls beyond the limit, and none once the user shows all", () => {
    expect(getHiddenNestedCallCount(COLLAPSED_NESTED_CALL_LIMIT, false)).toBe(0);
    expect(getHiddenNestedCallCount(COLLAPSED_NESTED_CALL_LIMIT + 3, false)).toBe(3);
    expect(getHiddenNestedCallCount(COLLAPSED_NESTED_CALL_LIMIT + 3, true)).toBe(0);
  });
});

describe("resolveCodeExecutionViewMode", () => {
  test("collapses to the header immediately for successful completed executions with no nested tools", () => {
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: true,
        hasToolCalls: false,
        noToolCallsDefaultView: "header",
      })
    ).toBe("header");
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
        noToolCallsDefaultView: "header",
      })
    ).toBe("tools");
    expect(
      resolveCodeExecutionViewMode("tools", {
        isComplete: false,
        hasToolCalls: false,
        noToolCallsDefaultView: "header",
      })
    ).toBe("tools");
  });
});
