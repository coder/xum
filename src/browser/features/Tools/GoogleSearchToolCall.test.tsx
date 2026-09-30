import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { GoogleSearchToolCall } from "./GoogleSearchToolCall";
import {
  SAMPLE_GOOGLE_SEARCH_QUERIES,
  SAMPLE_SEARCH_SUGGESTIONS_HTML,
} from "./GoogleSearchToolCall.fixtures";

function renderTool(props: ComponentProps<typeof GoogleSearchToolCall>) {
  // ThemeProvider is required by JsonHighlight (raw failure-result dump path).
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <GoogleSearchToolCall {...props} />
      </TooltipProvider>
    </ThemeProvider>
  );
}

/** Expand the collapsed tool row by clicking its header label. */
function expand(view: ReturnType<typeof renderTool>) {
  fireEvent.click(view.getByText("Google Search"));
}

describe("GoogleSearchToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalDOMParser: typeof globalThis.DOMParser;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalDOMParser = globalThis.DOMParser;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.DOMParser = domWindow.DOMParser;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.DOMParser = originalDOMParser;
  });

  test("renders queries and Google suggestion chips from the sample payload", () => {
    const view = renderTool({
      args: { queries: SAMPLE_GOOGLE_SEARCH_QUERIES },
      result: { search_suggestions: SAMPLE_SEARCH_SUGGESTIONS_HTML },
      status: "completed",
    });

    // Collapsed header: first query + "+N more" badge for the remaining ones.
    expect(view.getByText("electron 34 release date")).toBeTruthy();
    expect(view.getByText("+2 more")).toBeTruthy();

    expand(view);

    // All queries listed (first one appears in header and details).
    for (const query of SAMPLE_GOOGLE_SEARCH_QUERIES) {
      expect(view.getAllByText(query).length).toBeGreaterThanOrEqual(1);
    }

    const links = view.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://www.google.com/search?q=electron+34+release+date",
      "https://www.google.com/search?q=electron+34+breaking+changes",
      "https://www.google.com/search?q=electron+34+chromium+version",
    ]);
    // New-tab + opener hardening on every chip.
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  test("drops chips whose href is not https://www.google.com/search", () => {
    const hostileHtml = `<div class="container"><div class="carousel">
      <a class="chip" href="https://www.google.com/search?q=safe+query">safe query</a>
      <a class="chip" href="javascript:alert(1)">xss attempt</a>
      <a class="chip" href="https://evil.com/search?q=phish">evil host</a>
      <a class="chip" href="http://www.google.com/search?q=downgrade">plain http</a>
      <a class="chip" href="https://user:pass@www.google.com/search?q=creds">userinfo smuggle</a>
      <a class="chip" href="https://www.google.com:8443/search?q=port">nonstandard port</a>
    </div></div>`;

    const view = renderTool({
      args: { queries: ["safe query"] },
      result: { search_suggestions: hostileHtml },
      status: "completed",
    });
    expand(view);

    const links = view.getAllByRole("link");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://www.google.com/search?q=safe+query");
    expect(view.queryByText("xss attempt")).toBeNull();
    expect(view.queryByText("evil host")).toBeNull();
    expect(view.queryByText("plain http")).toBeNull();
    expect(view.queryByText("userinfo smuggle")).toBeNull();
    expect(view.queryByText("nonstandard port")).toBeNull();
  });

  test("dedupes chips sharing an href (no duplicate React keys)", () => {
    const repeatedHtml = `<div class="carousel">
      <a class="chip" href="https://www.google.com/search?q=dup">dup one</a>
      <a class="chip" href="https://www.google.com/search?q=dup">dup two</a>
      <a class="chip" href="https://www.google.com/search?q=other">other</a>
    </div>`;

    const view = renderTool({
      args: { queries: ["dup"] },
      result: { search_suggestions: repeatedHtml },
      status: "completed",
    });
    expand(view);

    const links = view.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://www.google.com/search?q=dup",
      "https://www.google.com/search?q=other",
    ]);
  });

  test("surfaces the error message for failed calls with the synthesized error shape", () => {
    const view = renderTool({
      args: { queries: ["broken"] },
      result: { success: false, error: "quota exceeded" },
      status: "failed",
    });
    expand(view);

    expect(view.getByText("quota exceeded")).toBeTruthy();
    expect(view.queryAllByRole("link").length).toBe(0);
  });

  test("dumps the raw result for failed calls with an unrecognized shape", () => {
    const view = renderTool({
      args: { queries: ["broken"] },
      result: { blocked_reason: "SAFETY" },
      status: "failed",
    });
    expand(view);

    expect(view.getByText(/blocked_reason/)).toBeTruthy();
  });

  test("renders queries without chips when suggestions HTML is malformed or empty", () => {
    const malformedPayloads = ["", "not html at all", '<div><a class="chip">no href</a></div>'];
    for (const html of malformedPayloads) {
      const view = renderTool({
        args: { queries: ["query one"] },
        result: { search_suggestions: html },
        status: "completed",
      });
      expand(view);

      expect(view.queryAllByRole("link").length).toBe(0);
      expect(view.queryByText("Suggested searches")).toBeNull();
      cleanup();
    }
  });

  test("unwraps { type: 'json', value } results from stream persistence", () => {
    const view = renderTool({
      args: { queries: ["wrapped"] },
      result: {
        type: "json",
        value: {
          search_suggestions:
            '<a class="chip" href="https://www.google.com/search?q=wrapped">wrapped</a>',
        },
      },
      status: "completed",
    });
    expand(view);

    const links = view.getAllByRole("link");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://www.google.com/search?q=wrapped");
  });

  test("shows searching placeholder while executing without args or result", () => {
    const view = renderTool({ args: {}, status: "executing" });

    expect(view.getByText("searching...")).toBeTruthy();

    expand(view);
    expect(view.getByText("Searching")).toBeTruthy();
    expect(view.queryAllByRole("link").length).toBe(0);
  });
});
