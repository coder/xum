import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";
import { WorkBundleMessage } from "./WorkBundleMessage";

const item: WorkBundleInfo = {
  key: "work:one",
  headIndex: 1,
  role: "work",
  visibleWhenFolded: false,
  startedAtMs: 0,
  durationMs: 134_000,
  state: "settled",
  kind: "work",
  editedFileCount: 0,
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

  test("names the finished work with its duration and toggles expansion", () => {
    let expanded = false;
    const onToggle = () => {
      expanded = !expanded;
    };
    const view = render(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { name: "Worked for 2m 14s", expanded: false })).toBeDefined();

    fireEvent.click(view.getByRole("button"));
    view.rerender(<WorkBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { expanded: true })).toBeDefined();
  });

  test("says that the folded work changed files", () => {
    const view = render(
      <WorkBundleMessage
        item={{ ...item, editedFileCount: 2 }}
        expanded={false}
        onToggle={() => undefined}
      />
    );
    expect(view.getByRole("button", { name: "Worked for 2m 14s · edited 2 files" })).toBeDefined();

    view.rerender(
      <WorkBundleMessage
        item={{ ...item, durationMs: undefined, editedFileCount: 1 }}
        expanded={false}
        onToggle={() => undefined}
      />
    );
    expect(view.getByRole("button", { name: "Worked · edited 1 file" })).toBeDefined();
  });

  test("runs a clock while the turn is live", () => {
    const view = render(
      <WorkBundleMessage
        item={{ ...item, state: "live", startedAtMs: Date.now() - 35_000, durationMs: undefined }}
        expanded={false}
        onToggle={() => undefined}
      />
    );

    expect(view.getByText(/^Working for \d+s$/)).toBeDefined();
  });

  test("a live turn names its current step, and not yet the files it edited", () => {
    const live: WorkBundleInfo = {
      ...item,
      state: "live",
      startedAtMs: undefined,
      durationMs: undefined,
      editedFileCount: 2,
      liveStep: "Running the unit tests",
    };
    const view = render(
      <WorkBundleMessage item={live} expanded={false} onToggle={() => undefined} />
    );
    expect(view.getByText("Working · Running the unit tests")).toBeDefined();

    // The same line once the turn is done: what it did, not what it was doing.
    view.rerender(
      <WorkBundleMessage
        item={{ ...live, state: "settled", liveStep: undefined, durationMs: 134_000 }}
        expanded={false}
        onToggle={() => undefined}
      />
    );
    expect(view.getByText("Worked for 2m 14s · edited 2 files")).toBeDefined();
  });

  test("drops a duration that is unknown or too short to read", () => {
    const view = render(
      <WorkBundleMessage
        item={{ ...item, durationMs: undefined }}
        expanded={false}
        onToggle={() => undefined}
      />
    );
    expect(view.getByText("Worked")).toBeDefined();

    view.rerender(
      <WorkBundleMessage
        item={{ ...item, kind: "thought", durationMs: 400 }}
        expanded={false}
        onToggle={() => undefined}
      />
    );
    expect(view.getByText("Thought")).toBeDefined();
  });
});
