import fs from "fs";
import path from "path";
import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

// Chromium never reports `unresponsive` while a debugger is attached, and Playwright drives
// the page over CDP. The test therefore emits the event from the main process while real
// renderer JS loops: this covers stack collection, the feature switch, and the
// Document-Policy header, not Chromium's hang detection itself.
const BUSY_LOOP_MS = 8_000;
const STACK_LOG_DEADLINE_MS = 20_000;
const STACK_LOG_MARKER = "[diag] renderer unresponsive JS stack";
const LOOP_FUNCTION_NAME = "xumE2eHangBusyLoop";

/** Hang-stack log lines naming the test's busy loop, across rotated log files. */
function readHangStackLines(logsDir: string): string[] {
  if (!fs.existsSync(logsDir)) return [];
  return fs
    .readdirSync(logsDir)
    .filter((name) => /^mux(\.\d+)?\.log$/.test(name))
    .flatMap((name) => fs.readFileSync(path.join(logsDir, name), "utf-8").split("\n"))
    .filter((line) => line.includes(STACK_LOG_MARKER) && line.includes(LOOP_FUNCTION_NAME));
}

test("logs the renderer JS stack once when the window hangs", async ({ app, page, workspace }) => {
  test.setTimeout(90_000);
  await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
  const logsDir = path.join(workspace.configRoot, "logs");
  expect(readHangStackLines(logsDir)).toEqual([]);

  // Start the loop from a timer so evaluate returns before the renderer blocks.
  await page.evaluate((loopMs) => {
    function xumE2eHangBusyLoop(durationMs: number): void {
      const end = Date.now() + durationMs;
      while (Date.now() < end) {
        // Busy-wait: keep the renderer main thread blocked.
      }
    }
    setTimeout(() => xumE2eHangBusyLoop(loopMs), 0);
  }, BUSY_LOOP_MS);

  // Let the timer start the loop, then report the hang twice: one hang episode must
  // collect and log one stack.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.emit("unresponsive");
        }
      }
    });
  }

  await expect
    .poll(() => readHangStackLines(logsDir).length, {
      timeout: STACK_LOG_DEADLINE_MS,
      intervals: [500],
    })
    .toBeGreaterThan(0);

  // The renderer recovers once the loop ends; the episode must have logged one stack.
  await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible({
    timeout: BUSY_LOOP_MS,
  });
  expect(await page.evaluate(() => document.readyState)).toBe("complete");
  expect(readHangStackLines(logsDir)).toHaveLength(1);
});

// The Document-Policy header comes from a main-frame webRequest listener, not a custom
// file:// protocol handler: a handler would route every file:// subresource through a
// main-process JS callback and turn native load errors into ERR_UNEXPECTED.
test("keeps Chromium's native file:// handling", async ({ app, page, workspace }) => {
  await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
  const missingPath = path.join(workspace.configRoot, "xum-e2e-missing-page.html");
  expect(fs.existsSync(missingPath)).toBe(false);

  const result = await app.evaluate(async ({ BrowserWindow, session }, filePath) => {
    const fileHandled = session.defaultSession.protocol.isProtocolHandled("file");
    const probe = new BrowserWindow({ show: false });
    try {
      await probe.loadFile(filePath);
      return { fileHandled, loadError: null };
    } catch (error) {
      return { fileHandled, loadError: (error as { code?: string }).code ?? String(error) };
    } finally {
      probe.destroy();
    }
  }, missingPath);

  expect(result).toEqual({ fileHandled: false, loadError: "ERR_FILE_NOT_FOUND" });
});
