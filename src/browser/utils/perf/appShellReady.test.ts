import { expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { APP_SHELL_READY_MARK, markAppShellReady } from "./appShellReady";

// One test only: the "marked" flag is module-level, so the mark is once per module load.
test("sets the app-shell-ready mark on the first attach only", () => {
  const cleanupDom = installDom();
  try {
    performance.clearMarks(APP_SHELL_READY_MARK);
    const marks = () => performance.getEntriesByName(APP_SHELL_READY_MARK, "mark").length;

    // React calls a ref callback with null on detach; that is not a shell commit.
    markAppShellReady(null);
    expect(marks()).toBe(0);

    markAppShellReady(document.createElement("div"));
    expect(marks()).toBe(1);

    // A remount (auth modal, StrictMode) attaches a new root element; the load already has its mark.
    markAppShellReady(null);
    markAppShellReady(document.createElement("div"));
    expect(marks()).toBe(1);
  } finally {
    cleanupDom();
  }
});
