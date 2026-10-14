import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { BaseSelectorPopover } from "./BaseSelectorPopover";

describe("BaseSelectorPopover", () => {
  let cleanupDom: (() => void) | undefined;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  // #6168: a base that arrived while the list was open (trunk detection, a project default)
  // replaced the typed search, and that text then filtered the list.
  test("a base that changes while the list is open keeps the typed search", async () => {
    const onChange = () => undefined;
    const view = render(
      <BaseSelectorPopover value="HEAD" onChange={onChange} data-testid="base-trigger" />
    );
    fireEvent.click(view.getByTestId("base-trigger"));
    const search = view.getByPlaceholderText("Enter base...") as HTMLInputElement;
    expect(search.value).toBe("");
    // Real key events: React's change tracking ignores a bare value write in happy-dom.
    await userEvent.setup({ document: search.ownerDocument }).type(search, "dev");
    expect(search.value).toBe("dev");

    view.rerender(
      <BaseSelectorPopover value="main" onChange={onChange} data-testid="base-trigger" />
    );

    expect(search.value).toBe("dev");
    expect(view.getByTestId("base-trigger").textContent).toBe("main");
    expect(view.queryByTestId("base-suggestion-develop")).not.toBeNull();
  });

  test("opening again starts with an empty search", async () => {
    const view = render(
      <BaseSelectorPopover value="HEAD" onChange={() => undefined} data-testid="base-trigger" />
    );
    const trigger = view.getByTestId("base-trigger");
    fireEvent.click(trigger);
    const search = view.getByPlaceholderText("Enter base...") as HTMLInputElement;
    await userEvent.setup({ document: search.ownerDocument }).type(search, "dev");
    expect(search.value).toBe("dev");
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect((view.getByPlaceholderText("Enter base...") as HTMLInputElement).value).toBe("");
  });
});
