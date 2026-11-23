// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import {
  SettingsAnchor,
  SettingsFocusContext,
  SettingsMark,
  type SettingsFocusTarget,
} from "./SettingsLayout";

function renderFocused(target: SettingsFocusTarget | null, children: ReactNode) {
  return render(
    <SettingsFocusContext.Provider value={target}>{children}</SettingsFocusContext.Provider>
  );
}

const focused = (element: Element | null) => element?.getAttribute("data-search-focused");

describe("settings search focus", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a mark inside closed disclosures opens all of them and highlights its block", () => {
    const view = renderFocused(
      { id: "add-form" },
      <details data-testid="outer">
        <summary>Outer</summary>
        <details data-testid="inner">
          <summary>Add server</summary>
          <SettingsMark id="add-form" />
          <input aria-label="Name" />
        </details>
      </details>
    );
    const outer = view.getByTestId("outer") as HTMLDetailsElement;
    const inner = view.getByTestId("inner") as HTMLDetailsElement;
    expect([outer.open, inner.open]).toEqual([true, true]);
    expect(focused(inner)).toBe("true");
  });

  test("a disclosure stays closed when another setting is the target", () => {
    const view = renderFocused(
      { id: "something-else" },
      <details data-testid="form">
        <summary>Add server</summary>
        <SettingsMark id="add-form" />
      </details>
    );
    const form = view.getByTestId("form") as HTMLDetailsElement;
    expect(form.open).toBe(false);
    expect(focused(form)).toBeNull();
  });

  test("the parent row stands in for a sub-option only while the sub-option is hidden", () => {
    const target = { id: "badge-size", fallbackId: "badge" };
    const hidden = renderFocused(
      target,
      <SettingsAnchor id="badge">
        <span>Badge</span>
      </SettingsAnchor>
    );
    expect(focused(hidden.container.querySelector('[data-setting-id="badge"]'))).toBe("true");
    hidden.unmount();

    const shown = renderFocused(
      target,
      <>
        <SettingsAnchor id="badge">
          <span>Badge</span>
        </SettingsAnchor>
        <SettingsAnchor id="badge-size">
          <span>Badge size</span>
        </SettingsAnchor>
      </>
    );
    expect(focused(shown.container.querySelector('[data-setting-id="badge"]'))).toBeNull();
    expect(focused(shown.container.querySelector('[data-setting-id="badge-size"]'))).toBe("true");
  });
});
