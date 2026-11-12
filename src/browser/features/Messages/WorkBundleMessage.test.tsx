import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";
import { WorkBundleMessage } from "./WorkBundleMessage";

const item: WorkBundleInfo = {
  key: "work:one",
  headIndex: 1,
  visibleWhenFolded: false,
  state: "settled",
  summary: "Read 2 files, ran 1 command",
};

describe("WorkBundleMessage", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("names the folded steps and toggles expansion", () => {
    let expanded = false;
    const onToggle = () => {
      expanded = !expanded;
    };
    const view = render(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(
      view.getByRole("button", { name: "Read 2 files, ran 1 command", expanded: false })
    ).toBeDefined();

    fireEvent.click(view.getByRole("button"));
    view.rerender(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { expanded: true })).toBeDefined();
  });
});
