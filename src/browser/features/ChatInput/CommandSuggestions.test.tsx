import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { CommandSuggestions } from "./CommandSuggestions";

const makeSuggestion = (id: string): SlashSuggestion => ({
  id,
  display: id,
  description: `desc:${id}`,
  replacement: id,
});
const suggestions = ["a", "b", "c"].map(makeSuggestion);
const option = (getByText: (text: string) => HTMLElement, id: string) =>
  getByText(id).closest('[role="option"]')?.getAttribute("aria-selected");

describe("CommandSuggestions", () => {
  let originalScrollIntoView: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };
    originalScrollIntoView = prototype.scrollIntoView;
    prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    cleanup();
    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };
    prototype.scrollIntoView = originalScrollIntoView;
    restoreDomGlobals();
  });

  it.each([
    {
      name: "preserves selection by id after reorder",
      downs: 1,
      before: "b",
      next: ["c", "a", "b"],
      after: "b",
    },
    {
      name: "clamps selection when the selected item disappears",
      downs: 2,
      before: "c",
      next: ["a", "b"],
      after: "b",
    },
  ])("$name", ({ downs, before, next, after }) => {
    function Harness() {
      const [items, setItems] = useState(suggestions);
      return (
        <div>
          <CommandSuggestions
            suggestions={items}
            onSelectSuggestion={() => undefined}
            onDismiss={() => undefined}
            isVisible
          />
          <button onClick={() => setItems(next.map(makeSuggestion))}>Update</button>
        </div>
      );
    }
    const { getByText } = render(<Harness />);
    for (let index = 0; index < downs; index++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(option(getByText, before)).toBe("true");
    fireEvent.click(getByText("Update"));
    expect(option(getByText, after)).toBe("true");
  });

  it.each([
    ["Enter", 1, "b"],
    ["Tab", 2, "c"],
  ] as const)("accepts the selected suggestion on %s", (key, downs, expected) => {
    const selectedIds: string[] = [];
    const { getByText } = render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(suggestion) => {
          selectedIds.push(suggestion.id);
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );
    for (let index = 0; index < downs; index++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(option(getByText, expected)).toBe("true");
    fireEvent.keyDown(document, { key });
    expect(selectedIds).toEqual([expected]);
  });

  it("does not accept Shift+Enter", () => {
    let selected: SlashSuggestion | null = null;
    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(suggestion) => {
          selected = suggestion;
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );
    fireEvent.keyDown(document, { key: "Enter", shiftKey: true });
    expect(selected).toBeNull();
  });

  it.each([
    { engine: "WebKit", webKit: true },
    { engine: "Chromium", webKit: false },
  ])(
    "keeps the anchored menu above the input when the visual viewport pans ($engine)",
    ({ webKit }) => {
      Object.defineProperty(window, "CSS", {
        configurable: true,
        value: { supports: () => webKit },
      });
      const viewport = Object.assign(new window.EventTarget(), { offsetLeft: 0, offsetTop: 0 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      // The input sits at (16, 243) in the layout viewport.
      const clientRect = { left: 16, top: 243 };
      const anchor = document.createElement("textarea");
      anchor.getBoundingClientRect = () =>
        new window.DOMRect(clientRect.left, clientRect.top, 360, 40);
      render(
        <CommandSuggestions
          suggestions={suggestions}
          onSelectSuggestion={() => undefined}
          onDismiss={() => undefined}
          isVisible
          anchorRef={{ current: anchor }}
        />
      );
      const menu = document.querySelector<HTMLElement>("[data-command-suggestions]");
      expect(menu?.style.bottom).toBe("calc(100% - 235px)");
      expect(menu?.style.maxHeight).toBe("200px");

      // Only WebKit moves client rects with the visual viewport.
      viewport.offsetLeft = 12;
      viewport.offsetTop = 77;
      if (webKit) {
        clientRect.left -= 12;
        clientRect.top -= 77;
      }
      act(() => {
        viewport.dispatchEvent(new window.Event("scroll"));
      });
      expect(menu?.style.bottom).toBe("calc(100% - 235px)");
      expect(menu?.style.left).toBe("16px");
      expect(menu?.style.maxHeight).toBe("158px");
    }
  );

  it("dismisses on Escape without propagation", () => {
    let dismissed = false;
    let propagated = false;
    const windowListener = () => {
      propagated = true;
    };
    window.addEventListener("keydown", windowListener);
    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={() => undefined}
        onDismiss={() => {
          dismissed = true;
        }}
        isVisible
      />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismissed).toBe(true);
    expect(propagated).toBe(false);
    window.removeEventListener("keydown", windowListener);
  });
});
