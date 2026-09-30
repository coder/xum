import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ToolSearchToolCall, toToolSearchView } from "./ToolSearchToolCall";

describe("ToolSearchToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders query, match count, and matched tools when expanded", () => {
    const view = render(
      <TooltipProvider>
        <ToolSearchToolCall
          args={{ query: "send slack message" }}
          status="completed"
          defaultExpanded={true}
          result={{
            query: "send slack message",
            matches: [
              { name: "slack_send_message", description: "Send a message to a channel" },
              { name: "slack_list_channels", description: "List channels" },
            ],
            totalDeferred: 5,
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("send slack message")).toBeTruthy();
    expect(view.getByText(/2 matches/)).toBeTruthy();
    expect(view.getByText("slack_send_message")).toBeTruthy();
    expect(view.getByText("Send a message to a channel")).toBeTruthy();
    expect(view.getByText("slack_list_channels")).toBeTruthy();
  });

  test("renders the error when the call failed", () => {
    const view = render(
      <TooltipProvider>
        <ToolSearchToolCall
          args={{ query: "anything" }}
          status="failed"
          defaultExpanded={true}
          result={{ success: false, error: "Tool execution aborted" }}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Tool execution aborted/)).toBeTruthy();
  });

  test("toToolSearchView filters malformed matches and tolerates pending results", () => {
    expect(toToolSearchView(undefined)).toEqual({ kind: "none" });
    expect(toToolSearchView("garbage")).toEqual({ kind: "none" });

    const view = toToolSearchView({
      query: "q",
      matches: [{ name: "ok_tool", description: "fine" }, { bogus: true }, null],
      totalDeferred: "not-a-number",
    });
    expect(view.kind).toBe("matches");
    if (view.kind === "matches") {
      expect(view.result.matches).toEqual([{ name: "ok_tool", description: "fine" }]);
      expect(view.result.totalDeferred).toBe(0);
    }
  });

  test("toToolSearchView coerces non-string descriptions so React never renders objects", () => {
    const view = toToolSearchView({
      query: "q",
      matches: [
        { name: "obj_desc", description: { nested: true } },
        { name: "arr_desc", description: ["a", "b"] },
      ],
      totalDeferred: 2,
    });
    expect(view.kind).toBe("matches");
    if (view.kind === "matches") {
      expect(view.result.matches).toEqual([
        { name: "obj_desc", description: "" },
        { name: "arr_desc", description: "" },
      ]);
    }

    // Rendering the coerced result must not throw.
    const rendered = render(
      <TooltipProvider>
        <ToolSearchToolCall
          args={{ query: "q" }}
          status="completed"
          defaultExpanded={true}
          result={{
            query: "q",
            matches: [{ name: "obj_desc", description: { nested: true } }],
            totalDeferred: 1,
          }}
        />
      </TooltipProvider>
    );
    expect(rendered.getByText("obj_desc")).toBeTruthy();
  });
});
