import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { createCommandToast } from "./ChatInputToasts";
import { ChatInputToast, type Toast } from "./ChatInputToast";

describe("ChatInputToast", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("labels known command flag errors without unknown-command wording", () => {
    const toast = createCommandToast({
      type: "command-unknown-flag",
      command: "goal",
      flag: "--bogus",
    });

    expect(toast).toMatchObject({ type: "error", title: "Unknown Flag" });
    expect(toast?.message).toContain("--bogus");
    expect(toast?.message).not.toContain("Unknown command");
  });

  test("a toast with copyable text offers copy and dismiss controls", () => {
    // Success toasts normally have neither; a saved path must stay copyable.
    const toast: Toast = { id: "t", type: "success", message: "Saved", copyText: "/r/1" };
    const { getByLabelText } = render(<ChatInputToast toast={toast} onDismiss={() => undefined} />);
    expect(getByLabelText("Copy to clipboard")).toBeTruthy();
    expect(getByLabelText("Dismiss")).toBeTruthy();
  });

  test("a success toast with an explicit duration can be dismissed early", async () => {
    // Long-lived success toasts (e.g. the session tapes folder path) would otherwise cover the
    // transcript until they expire.
    let dismissed = 0;
    const toast: Toast = { id: "t", type: "success", message: "Folder: /r", duration: 15_000 };
    const { getByLabelText } = render(
      <ChatInputToast toast={toast} onDismiss={() => (dismissed += 1)} />
    );
    fireEvent.click(getByLabelText("Dismiss"));
    await waitFor(() => expect(dismissed).toBe(1));
  });

  test("a default success toast has no dismiss control", () => {
    const toast: Toast = { id: "t", type: "success", message: "Done" };
    const { queryByLabelText } = render(
      <ChatInputToast toast={toast} onDismiss={() => undefined} />
    );
    expect(queryByLabelText("Dismiss")).toBeNull();
  });

  test("resets leaving state when a new toast is shown", async () => {
    const toast1: Toast = { id: "toast-1", type: "error", message: "first" };
    const toast2: Toast = { id: "toast-2", type: "error", message: "second" };

    function Harness() {
      const [toast, setToast] = React.useState<Toast | null>(toast1);
      return (
        <div>
          <ChatInputToast toast={toast} onDismiss={() => undefined} />
          <button onClick={() => setToast(toast2)}>Next toast</button>
        </div>
      );
    }

    const { getByLabelText, getByRole, getByText } = render(<Harness />);

    fireEvent.click(getByLabelText("Dismiss"));

    await waitFor(() => {
      expect(getByRole("alert").className).toContain("toastFadeOut");
    });

    fireEvent.click(getByText("Next toast"));

    await waitFor(() => {
      const className = getByRole("alert").className;
      expect(className).toContain("toastSlideIn");
      expect(className).not.toContain("toastFadeOut");
    });
  });
});
