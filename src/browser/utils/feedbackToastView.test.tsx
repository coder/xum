import "../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { installDom } from "../../../tests/ui/dom";
import type * as DialogModule from "@/browser/components/Dialog/Dialog";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { showFeedbackToast } from "./feedbackToast";

// Other suites stub the Dialog module (bun module stubs are process-global).
const { Dialog, DialogOverlay } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../components/Dialog/Dialog?real=1") as typeof DialogModule;

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

test("a composer behind an open modal dialog is no toast host, so the message alerts", () => {
  // Radix keeps aria-live regions (the composer has one) out of aria-hidden behind a modal.
  render(
    <>
      <div data-component="ChatInputSection">
        <div aria-live="polite" />
      </div>
      <Dialog open>
        <DialogOverlay />
        <DialogPrimitive.Content>
          <DialogPrimitive.Title>Settings</DialogPrimitive.Title>
        </DialogPrimitive.Content>
      </Dialog>
    </>
  );
  const alerts: unknown[] = [];
  window.alert = (message: unknown) => alerts.push(message);
  const toasts: unknown[] = [];
  window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, (event) => toasts.push(event));

  showFeedbackToast({ type: "error", message: "Settings could not be saved" });

  expect(alerts).toEqual(["Settings could not be saved"]);
  expect(toasts).toEqual([]);
});

test("a composer under an inert page (a full-screen view covers it) is no toast host", () => {
  // The phone full-screen right sidebar makes the rest of the page inert and covers it, so a
  // toast in the composer would be neither visible nor clickable.
  const view = render(
    <div data-testid="page">
      <div data-component="ChatInputSection" />
    </div>
  );
  view.getByTestId("page").setAttribute("inert", "");
  const alerts: unknown[] = [];
  window.alert = (message: unknown) => alerts.push(message);
  const toasts: unknown[] = [];
  window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, (event) => toasts.push(event));

  showFeedbackToast({ type: "error", message: "Side chat failed" });

  expect(alerts).toEqual(["Side chat failed"]);
  expect(toasts).toEqual([]);
});
