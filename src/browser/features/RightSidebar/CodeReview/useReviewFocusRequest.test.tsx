// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { useReviewFocusRequest } from "./useReviewFocusRequest";

describe("useReviewFocusRequest", () => {
  let cleanupDom: (() => void) | null = null;
  let panel: HTMLDivElement;

  beforeEach(() => {
    cleanupDom = installDom();
    panel = document.createElement("div");
    panel.tabIndex = -1;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderRequest(focusTrigger: number, isCreating: boolean) {
    const panelRef = { current: panel };
    return renderHook(
      (props: { focusTrigger: number; isCreating: boolean }) =>
        useReviewFocusRequest(panelRef, props.focusTrigger, props.isCreating),
      { initialProps: { focusTrigger, isCreating } }
    );
  }

  test("a request during setup focuses the panel once setup ends (#7449)", () => {
    const hook = renderRequest(0, true);
    hook.rerender({ focusTrigger: 1, isCreating: true });
    expect(document.activeElement).not.toBe(panel);

    hook.rerender({ focusTrigger: 1, isCreating: false });
    expect(document.activeElement).toBe(panel);
  });

  test("a request that went to another Review tab during setup does not focus this one", () => {
    const hook = renderRequest(0, true);
    hook.rerender({ focusTrigger: 1, isCreating: true });
    hook.rerender({ focusTrigger: 0, isCreating: true });

    hook.rerender({ focusTrigger: 0, isCreating: false });
    expect(document.activeElement).not.toBe(panel);
  });
});
