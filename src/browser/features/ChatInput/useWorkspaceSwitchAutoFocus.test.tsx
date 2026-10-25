// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { PHONE_TOUCH_QUERY } from "@/browser/utils/env";
import { useWorkspaceSwitchAutoFocus } from "./useWorkspaceSwitchAutoFocus";

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });
}

describe("useWorkspaceSwitchAutoFocus", () => {
  let cleanupDom: (() => void) | null = null;
  let section: HTMLDivElement;
  let input: HTMLTextAreaElement;
  let states: string[];

  beforeEach(() => {
    cleanupDom = installDom();
    section = document.createElement("div");
    input = document.createElement("textarea");
    section.appendChild(input);
    document.body.appendChild(section);
    states = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderFocus() {
    return renderHook(() =>
      useWorkspaceSwitchAutoFocus({
        workspaceId: "ws-1",
        inputRef: { current: input },
        sectionRef: { current: section },
        focusInput: () => input.focus(),
        setAutoFocusState: (state) => states.push(state),
      })
    );
  }

  test("focuses the composer when a workspace opens", async () => {
    renderFocus();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(states.at(-1)).toBe("done");
  });

  test("leaves the composer unfocused on a phone, so the keyboard stays closed", async () => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = original(query);
      if (query === PHONE_TOUCH_QUERY) Object.defineProperty(list, "matches", { value: true });
      return list;
    };

    renderFocus();
    await nextFrames(3);
    expect(document.activeElement).not.toBe(input);
    expect(states).toEqual([]);
  });
});
