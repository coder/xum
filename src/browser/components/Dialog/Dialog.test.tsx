import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { installDom } from "../../../../tests/ui/dom";
import { isDialogOpen } from "@/browser/utils/ui/keybinds";
import type * as DialogModule from "./Dialog";

// Other suites stub this module (bun module stubs are process-global). Load the real one under
// a distinct specifier so a leaked stub cannot turn these assertions vacuous.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Dialog, DialogOverlay } = require("./Dialog?real=1") as typeof DialogModule;

let cleanupDom: (() => void) | null = null;

/**
 * isDialogOpen() against the REAL shared Dialog primitives. Radix puts no aria-modal on dialog
 * content, so the guard must recognise an open modal by its overlay; the Radix Portal does not
 * render in happy-dom, so overlay/content are mounted inline here and the portaled path is
 * covered by the Dialog and Popover story plays.
 */
describe("isDialogOpen with the shared Dialog primitives", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("detects an open modal dialog whose content carries no aria-modal", () => {
    const view = render(
      <Dialog open>
        <DialogOverlay data-testid="overlay" />
        <DialogPrimitive.Content>
          <DialogPrimitive.Title>Configure MCP</DialogPrimitive.Title>
        </DialogPrimitive.Content>
      </Dialog>
    );

    // The exact runtime shape of the MCP/heartbeat dialogs: role=dialog, open, no aria-modal.
    const content = view.getByRole("dialog");
    expect(content.getAttribute("data-state")).toBe("open");
    expect(content.hasAttribute("aria-modal")).toBe(false);
    expect(view.getByTestId("overlay").getAttribute("data-state")).toBe("open");

    expect(isDialogOpen()).toBe(true);
  });

  test("a closed dialog with a force-mounted overlay is not an open modal", () => {
    const view = render(
      <Dialog open={false}>
        <DialogOverlay forceMount data-testid="overlay" />
      </Dialog>
    );

    // Present in the DOM (force-mounted for exit animations) but closed.
    expect(view.getByTestId("overlay").getAttribute("data-state")).toBe("closed");
    expect(isDialogOpen()).toBe(false);
  });

  test("a non-modal dialog renders no overlay and does not suppress shortcuts", () => {
    const view = render(
      <Dialog open modal={false}>
        <DialogOverlay data-testid="overlay" />
        <DialogPrimitive.Content>
          <DialogPrimitive.Title>Non-modal panel</DialogPrimitive.Title>
        </DialogPrimitive.Content>
      </Dialog>
    );

    // Something IS open (role=dialog), but Radix renders the overlay only for modal roots.
    expect(view.getByRole("dialog").getAttribute("data-state")).toBe("open");
    expect(view.queryByTestId("overlay")).toBeNull();
    expect(isDialogOpen()).toBe(false);
  });

  test("closing the dialog clears the detection", () => {
    const view = render(
      <Dialog open>
        <DialogOverlay data-testid="overlay" />
      </Dialog>
    );
    expect(isDialogOpen()).toBe(true);

    view.rerender(
      <Dialog open={false}>
        <DialogOverlay data-testid="overlay" />
      </Dialog>
    );
    expect(view.queryByTestId("overlay")).toBeNull();
    expect(isDialogOpen()).toBe(false);
  });

  test("dialogs built outside the primitive are still detected through aria-modal", () => {
    const foreign = document.createElement("div");
    foreign.setAttribute("role", "dialog");
    foreign.setAttribute("aria-modal", "true");
    document.body.appendChild(foreign);
    try {
      expect(isDialogOpen()).toBe(true);
    } finally {
      foreign.remove();
    }
    expect(isDialogOpen()).toBe(false);
  });
});
