import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { isEventFromDialogPortal } from "./events";

describe("isEventFromDialogPortal", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("detects targets inside role=dialog ancestors", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);

    expect(isEventFromDialogPortal(button)).toBe(true);
  });

  test("returns false for non-dialog targets and null", () => {
    const button = document.createElement("button");
    document.body.append(button);

    expect(isEventFromDialogPortal(button)).toBe(false);
    expect(isEventFromDialogPortal(null)).toBe(false);
  });
});
