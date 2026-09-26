import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";
import { WorkBundleMessage } from "./WorkBundleMessage";

const item: WorkBundleInfo = {
  key: "work:one",
  position: "head",
  headIndex: 1,
  entries: [],
  startedAtMs: 0,
  durationMs: 180_000,
  state: "settled",
  defaultExpanded: false,
};

describe("WorkBundleMessage", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders duration and toggles expansion", () => {
    let expanded = false;
    const onToggle = () => {
      expanded = !expanded;
    };
    const view = render(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { expanded: false })).toBeDefined();
    expect(view.getByText("Worked for 3m 0s")).toBeDefined();

    fireEvent.click(view.getByRole("button"));
    view.rerender(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { expanded: true })).toBeDefined();
  });

  test("renders active working label with elapsed duration", () => {
    const view = render(
      <WorkBundleMessage
        item={{
          ...item,
          state: "active",
          startedAtMs: Date.now() - 35_000,
          durationMs: undefined,
          defaultExpanded: true,
        }}
        expanded
        onToggle={() => undefined}
      />
    );

    expect(view.getByText(/Working for \d+s\.\.\./)).toBeDefined();
  });

  test("renders fallback label without duration", () => {
    const view = render(
      <WorkBundleMessage
        item={{ ...item, durationMs: undefined }}
        expanded={false}
        onToggle={() => undefined}
      />
    );

    expect(view.getByText("Worked")).toBeDefined();
  });
});
