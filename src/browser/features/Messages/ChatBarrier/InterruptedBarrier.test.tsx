import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { InterruptedBarrier } from "./InterruptedBarrier";

describe("InterruptedBarrier", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("clicking the resumable label invokes onResume", () => {
    const onResume = mock(() => undefined);
    const view = render(<InterruptedBarrier resumable onResume={onResume} />);

    fireEvent.click(view.getByRole("button", { name: "Continue interrupted response" }));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("a non-resumable divider renders no clickable control", () => {
    const onResume = mock(() => undefined);
    const view = render(<InterruptedBarrier resumable={false} onResume={onResume} />);

    expect(view.queryByRole("button")).toBeNull();
    expect(view.getByText("interrupted")).toBeTruthy();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("surfaces a resume failure so the action is not a silent no-op", () => {
    const view = render(
      <InterruptedBarrier resumable onResume={() => undefined} error="Runtime failed to start" />
    );

    expect(view.getByText("Couldn't continue:")).toBeTruthy();
    expect(view.getByText(/Runtime failed to start/)).toBeTruthy();
  });

  test("does not surface an error on a non-resumable divider", () => {
    const view = render(<InterruptedBarrier resumable={false} error="ignored" />);

    expect(view.queryByText("Couldn't continue:")).toBeNull();
  });
});
