import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { SessionHistoryToolCall } from "./SessionHistoryToolCall";

const TEST_WORKSPACE_ID = "session-history-test";

// ToolIcon renders a Radix Tooltip which requires a TooltipProvider and contexts.
function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="session_history">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

const WINDOW_ROW = '[data-testid="session-history-window"]';
const ITEM_ROW = '[data-testid="session-history-item"]';
const EXCERPT = '[data-testid="session-history-excerpt"]';
const PAGE = '[data-testid="session-history-page"]';
const SCOPE = '[data-testid="session-history-scope"]';

describe("SessionHistoryToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("list_windows renders one rail row per run; unknown boundary kinds keep their raw label", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "list_windows" }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          windows: [
            { windowId: "w:0", boundaryKind: "root", itemCount: 3 },
            // A window ID recurs once per contiguous run in repaired history.
            { windowId: "w:0", boundaryKind: "root", itemCount: 1 },
            { windowId: "w:9", boundaryKind: "constructor", itemCount: 2 },
          ],
        }}
      />
    );
    const rows = view.container.querySelectorAll(WINDOW_ROW);
    expect(rows.length).toBe(3);
    // Own-key lookup: a persisted "constructor" kind must not resolve to Object members.
    expect(rows[2].textContent).toContain("constructor");
    expect(rows[1].textContent).toContain("1 item");
    expect(view.getByText("3 windows")).toBeTruthy();
  });

  test("search highlights every case-insensitive literal occurrence, not regex matches", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "a.b" }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          has_more: true,
          items: [
            { itemId: "1", windowId: "w:0", role: "user", text: "A.B then axb then a.b" },
            { itemId: "2", windowId: "w:4", role: "assistant", text: "no dots: axb" },
          ],
        }}
      />
    );
    const marks = Array.from(view.container.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["A.B", "a.b"]);
    expect(view.container.querySelectorAll(ITEM_ROW).length).toBe(2);
    // has_more marks the count as a lower bound.
    expect(view.getByText("2+ matches")).toBeTruthy();
  });

  test("legacy read_item (no startCharOffset) reports returned characters, never an inferred start", () => {
    const text = "x".repeat(600);
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "r:1:chat:0:abc", offset_chars: 600 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            {
              itemId: "r:1:chat:0:abc",
              windowId: "w:0",
              role: "assistant",
              text,
              nextCharOffset: 1200,
            },
          ],
        }}
      />
    );
    const excerpt = view.container.querySelector(EXCERPT)?.textContent ?? "";
    const page = view.container.querySelector(PAGE)?.textContent ?? "";
    expect(page).toContain("600 chars");
    expect(page).toContain("offset 1,200");
    // The requested offset appears only as a request filter, not as the page's start.
    expect(view.container.querySelector(SCOPE)?.textContent).toContain("600");
    expect(excerpt).not.toContain("…x");
    expect(page).not.toContain("600–");
    expect(view.getByText("600 chars")).toBeTruthy();
  });

  test("read_item with startCharOffset shows exact ranges and marks a leading cut", () => {
    const text = "x".repeat(600);
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "r:1:chat:0:abc", offset_chars: 600 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            {
              itemId: "r:1:chat:0:abc",
              windowId: "w:0",
              role: "assistant",
              startCharOffset: 600,
              text,
              nextCharOffset: 1200,
            },
          ],
        }}
      />
    );
    // Header count and footer both carry the exact range.
    expect(view.getByText("chars 600–1,200")).toBeTruthy();
    expect(view.container.querySelector(PAGE)?.textContent).toBe(
      "chars 600–1,200 · continues at offset 1,200"
    );
    expect(view.container.querySelector(EXCERPT)?.textContent).toContain(`…${text}…`);
    cleanup();

    // offset_chars 1 was rounded back to 0: the reported start, not the request, decides.
    const rounded = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "7", offset_chars: 1 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            {
              itemId: "7",
              windowId: "w:0",
              role: "user",
              startCharOffset: 0,
              text: "\u{1F600}tail",
            },
          ],
        }}
      />
    );
    expect(rounded.container.querySelector(PAGE)?.textContent).toBe("chars 0–6 · end of item");
    expect(rounded.container.textContent).not.toContain("…\u{1F600}");
  });

  test("a start that contradicts the reported continuation falls back to the legacy view", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "7" }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            {
              itemId: "7",
              windowId: "w:0",
              role: "user",
              startCharOffset: 50,
              text: "head",
              nextCharOffset: 4,
            },
          ],
        }}
      />
    );
    expect(view.container.querySelector(PAGE)?.textContent).toBe("4 chars · continues at offset 4");
    expect(view.container.querySelector(EXCERPT)?.textContent).not.toContain("…head");
  });

  test("legacy read_item without a continuation ends the item without claiming where it started", () => {
    // offset_chars 1 lands inside the surrogate pair; the backend rounds back to 0.
    const rounded = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "7", offset_chars: 1 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [{ itemId: "7", windowId: "w:0", role: "user", text: "\u{1F600}tail" }],
        }}
      />
    );
    const page = rounded.container.querySelector(PAGE)?.textContent ?? "";
    expect(page).toContain("6 chars");
    expect(page).not.toContain("continues");
    expect(rounded.container.textContent).not.toContain("…\u{1F600}");
    cleanup();

    // An offset past the row end returns an empty page.
    const past = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "read_item", item_id: "7", offset_chars: 5_000 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [{ itemId: "7", windowId: "w:0", role: "user", text: "" }],
        }}
      />
    );
    expect(past.container.querySelector(PAGE)?.textContent).toContain("0 chars");
  });

  test("known error codes are translated; unknown codes render verbatim with the notice", () => {
    const known = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "token" }}
        status="failed"
        defaultExpanded
        result={{ success: false, error: "history_timeout", notice: "narrow the query" }}
      />
    );
    expect(known.queryByText("history_timeout")).toBeNull();
    expect(known.getByText("narrow the query")).toBeTruthy();
    cleanup();

    const unknown = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "token" }}
        status="failed"
        defaultExpanded
        result={{ success: false, error: "brand_new_code" }}
      />
    );
    expect(unknown.getByText("brand_new_code")).toBeTruthy();
  });

  test("unwraps the SDK JSON container and tolerates omitted result arrays", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "list_windows" }}
        status="completed"
        defaultExpanded
        // Persisted list_windows results can omit `items` entirely.
        result={{
          type: "json",
          value: {
            success: true,
            windows: [{ windowId: "w:0", boundaryKind: "root", itemCount: 3 }],
          },
        }}
      />
    );
    expect(view.container.querySelectorAll(WINDOW_ROW).length).toBe(1);
  });

  test("a malformed result degrades to a status note and the raw toggle still shows it", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "token" }}
        status="completed"
        defaultExpanded
        result={{ success: "yes", items: "not-an-array" }}
      />
    );
    expect(view.container.querySelector(ITEM_ROW)).toBeNull();
    // Present-but-invalid output is not a success, whatever the transport status says.
    expect(view.container.querySelector(".status-text")?.textContent).toBe("failed");
    const toggle = view.getByRole("button", { name: /raw input/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("not-an-array");
  });

  test("legacy snippets (no startCharOffset) mark only a reported trailing cut, never an inferred leading one", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "needle", max_chars_per_item: 40 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            // Could be a complete row or a suffix that started mid-row: the result cannot tell.
            { itemId: "1", windowId: "w:0", role: "user", text: `${"x".repeat(20)}needle end` },
            { itemId: "2", windowId: "w:0", role: "user", text: "short needle row" },
            // nextCharOffset reports that the row continues past the snippet.
            { itemId: "3", windowId: "w:0", role: "user", text: "needle head", nextCharOffset: 11 },
          ],
        }}
      />
    );
    const snippets = Array.from(
      view.container.querySelectorAll('[data-testid="session-history-snippet"]')
    ).map((node) => node.textContent ?? "");
    expect(snippets.map((text) => text.startsWith("…"))).toEqual([false, false, false]);
    expect(snippets.map((text) => text.endsWith("…"))).toEqual([false, false, true]);
  });

  test("snippets with startCharOffset mark a leading cut only for a mid-row start", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "needle", max_chars_per_item: 40 }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          items: [
            // Same text shape: a complete row versus a suffix that started mid-row.
            {
              itemId: "1",
              windowId: "w:0",
              role: "user",
              startCharOffset: 0,
              text: `${"x".repeat(20)}needle end`,
            },
            {
              itemId: "2",
              windowId: "w:0",
              role: "user",
              startCharOffset: 10,
              text: `${"y".repeat(20)}needle end`,
            },
            {
              itemId: "3",
              windowId: "w:0",
              role: "user",
              startCharOffset: 30,
              text: `${"z".repeat(20)}needle${"w".repeat(14)}`,
              nextCharOffset: 70,
            },
          ],
        }}
      />
    );
    const snippets = Array.from(
      view.container.querySelectorAll('[data-testid="session-history-snippet"]')
    ).map((node) => node.textContent ?? "");
    expect(snippets.map((text) => text.startsWith("…"))).toEqual([false, true, true]);
    expect(snippets.map((text) => text.endsWith("…"))).toEqual([false, false, true]);
  });

  test("has_more guidance only names filters the action accepts", () => {
    const windows = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "list_windows" }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          has_more: true,
          windows: [{ windowId: "w:0", boundaryKind: "root", itemCount: 1 }],
        }}
      />
    );
    // list_windows rejects role/tool_name (filters_unsupported).
    expect(windows.container.textContent).not.toMatch(/tool_name|role/);
    cleanup();

    const search = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "x" }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          has_more: true,
          items: [{ itemId: "1", windowId: "w:0", role: "user", text: "x" }],
        }}
      />
    );
    expect(search.container.textContent).toContain("tool_name");
  });

  test("the raw fallback redacts attachment payloads", () => {
    const payload = "QkFTRTY0".repeat(64);
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "search", query: "token" }}
        status="completed"
        defaultExpanded
        result={{
          type: "content",
          value: [{ type: "media", mediaType: "image/png", data: payload }],
        }}
      />
    );
    fireEvent.click(view.getByRole("button", { name: /raw input/ }));
    expect(view.container.textContent).toContain("image/png");
    expect(view.container.textContent).not.toContain(payload);
  });

  test("a completed call without output keeps its transport status", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "list_windows" }}
        status="completed"
        defaultExpanded
        result={null}
      />
    );
    expect(view.container.querySelector(".status-text")?.textContent).toBe("completed");
  });

  test("list_items names its window in the header, so the scope omits the window chip", () => {
    const view = renderWithProviders(
      <SessionHistoryToolCall
        args={{ action: "list_items", window_id: "w:42", role: "assistant" }}
        status="completed"
        defaultExpanded
        result={{ success: true, items: [] }}
      />
    );
    const scope = view.container.querySelector(SCOPE)?.textContent ?? "";
    expect(scope).toContain("assistant");
    expect(scope).not.toContain("w:42");
    expect(view.getByText("w:42")).toBeTruthy();
  });
});
