import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test as browserTest, type Page, type TestInfo } from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";

type HandoffEvent = { type: "send"; bytes: number[] } | { type: "disconnect" | "connect" };

interface KeyEvent {
  keysym: number;
  down: boolean;
}
interface Connection {
  keys: KeyEvent[];
  pointerMasks: number[];
  closed: boolean;
}

function readKeyEvent(bytes: Uint8Array): KeyEvent | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 8 && bytes[0] === 4) {
    return { keysym: view.getUint32(4), down: bytes[1] !== 0 };
  }
  if (bytes.length === 12 && bytes[0] === 255 && bytes[1] === 0) {
    return { keysym: view.getUint32(4), down: view.getUint16(2) !== 0 };
  }
  return undefined;
}

function observeDesktopConnections(page: Page): Connection[] {
  const connections: Connection[] = [];
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/desktop/ws")) return;
    const connection: Connection = { keys: [], pointerMasks: [], closed: false };
    connections.push(connection);
    socket.on("close", () => {
      connection.closed = true;
    });
    // noVNC flushes each RFB key message separately. Accept both ordinary RFB
    // and QEMU extended key events, depending on the real server's negotiation.
    socket.on("framesent", ({ payload }) => {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      if ((bytes.length === 6 || bytes.length === 7) && bytes[0] === 5) {
        connection.pointerMasks.push(bytes[1] & 0x7f);
      }
      const key = readKeyEvent(bytes);
      if (key) connection.keys.push(key);
    });
  });
  return connections;
}

async function enableRealDesktop(page: Page, workspaceId: string) {
  await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__));
  const capability = await page.evaluate(async (id) => {
    const api = window.__ORPC_CLIENT__;
    if (!api) throw new Error("E2E API client not initialized");
    await api.experiments.setOverride({ experimentId: "portable-desktop", enabled: true });
    return api.desktop.getCapability({ workspaceId: id });
  }, workspaceId);
  if (!capability.available) {
    // Startup failures on an installed runtime must fail, not silently skip regressions.
    expect(capability.reason).not.toBe("startup_failed");
    test.skip(true, `Real PortableDesktop unavailable: ${capability.reason}`);
  }
  // Experiment subscriptions are refreshed on app startup.
  await page.reload();
}

const viewport = (page: Page) => page.locator("[data-desktop-viewport] canvas");

async function expectConnectedViewOnly(page: Page) {
  await expect(viewport(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  // RFB's connect event precedes its first framebuffer update; a visible canvas
  // alone can still produce an empty screenshot of an otherwise healthy viewer.
  await expect
    .poll(
      () =>
        viewport(page).evaluate((canvas: HTMLCanvasElement) => {
          if (canvas.width === 0 || canvas.height === 0) return false;
          const pixel = canvas
            .getContext("2d")
            ?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
          return (pixel?.data[3] ?? 0) > 0;
        }),
      { message: `${name}: waiting for a decoded desktop framebuffer`, timeout: 30_000 }
    )
    .toBe(true);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("Electron desktop", () => {
  // No VNC stubs: these scenarios require a real PortableDesktop installation and a
  // display for Electron (e.g. xvfb-run). Missing prerequisites are skips, not passes.
  test.skip(({ browserName }) => browserName !== "chromium", "Electron requires Chromium");
  test.skip(process.platform !== "linux", "Portable Desktop is currently enabled on Linux only");
  test.skip(!process.env.DISPLAY, "Electron desktop E2E requires DISPLAY (run under xvfb-run)");

  test("real VNC is view-only until opted in, releases modifiers, and zoom does not reconnect", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    await enableRealDesktop(page, workspace.demoProject.workspaceId);
    await ui.projects.openFirstWorkspace();
    const connections = observeDesktopConnections(page);
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    expect(connections).toHaveLength(1);
    const connection = connections[0];
    assert(connection);
    const canvas = viewport(page);
    const geometry = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width,
      height: element.height,
    }));

    await canvas.click();
    await page.keyboard.press("a");
    await page.getByRole("button", { name: "Zoom to 100%", exact: true }).click();
    await expect(page.getByRole("button", { name: "Zoom to fit", exact: true })).toBeVisible();
    expect(await canvas.evaluate((element) => element.getBoundingClientRect().width)).toBe(
      geometry.width
    );
    expect(await canvas.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      geometry.height
    );
    const screen = canvas.locator("..");
    expect(await screen.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    );
    await screen.evaluate((element) => {
      element.scrollLeft = 80;
    });
    expect(await screen.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await screen.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await canvas.hover({ position: { x: 40, y: 40 } });
    await page.mouse.wheel(160, 0);
    await expect.poll(() => screen.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await screenshot(page, testInfo, "native-one-to-one-scrolled");
    await page.getByRole("button", { name: "Zoom to fit", exact: true }).click();
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
      }))
    ).toEqual(geometry);
    expect(connection.keys).toEqual([]);
    expect(connection.closed).toBe(false);
    expect(connections).toHaveLength(1);

    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await canvas.click();
    await expect(page.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
    const modifiers = [
      { key: "Shift", keysym: 0xffe1 },
      { key: "Control", keysym: 0xffe3 },
    ];
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier.key);
      await expect
        .poll(() => connection.keys.some((key) => key.keysym === modifier.keysym && key.down))
        .toBe(true);
    }
    await page.getByRole("button", { name: "Release control", exact: true }).click();
    for (const modifier of modifiers) {
      await expect
        .poll(() => connection.keys.some((key) => key.keysym === modifier.keysym && !key.down))
        .toBe(true);
      await page.keyboard.up(modifier.key);
    }
    await expectConnectedViewOnly(page);

    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await canvas.hover();
    await page.mouse.down();
    await expect.poll(() => connection.pointerMasks.at(-1)).toBe(1);
    // Disable Playwright's per-renderer focus emulation so a real second native
    // window can exercise window-blur release instead of leaving every page focused.
    const nativeFocus = await page.context().newCDPSession(page);
    await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const otherWindow = await app.evaluateHandle(
      ({ BrowserWindow }) => new BrowserWindow({ show: false, width: 300, height: 200 })
    );
    try {
      await otherWindow.evaluate(async (window) => {
        await window.loadURL("about:blank");
        window.show();
        window.focus();
      });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      await expect.poll(() => connection.pointerMasks.at(-1)).toBe(0);
    } finally {
      await page.mouse.up();
      await otherWindow.evaluate((window) => window.destroy());
      await otherWindow.dispose();
      await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await nativeFocus.detach();
    }
    await page.bringToFront();
    await expectConnectedViewOnly(page);
    await screenshot(page, testInfo, "inline-view-only-after-release");
  });

  test("real Electron popout survives remount and returns one view-only connection on bring-back or close", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    await enableRealDesktop(page, workspace.demoProject.workspaceId);
    await ui.projects.openFirstWorkspace();
    const inlineConnections = observeDesktopConnections(page);
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    const originalConnection = inlineConnections[0];
    assert(originalConnection);
    const existingWindows = app.windows().length;
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await viewport(page).hover();
    await page.mouse.down();
    await expect.poll(() => originalConnection.pointerMasks.at(-1)).toBe(1);

    const childReady = app.waitForEvent("window");
    // Keyboard activation preserves the held mouse button until disconnect releases it.
    await page.getByRole("button", { name: "Detach", exact: true }).focus();
    await page.keyboard.press("Enter");
    const child = await childReady;
    await expectConnectedViewOnly(child);
    await expect(viewport(page)).toHaveCount(0);
    await expect.poll(() => originalConnection.closed).toBe(true);
    expect(originalConnection.pointerMasks.at(-1)).toBe(0);
    await page.mouse.up();
    expect(app.windows()).toHaveLength(existingWindows + 1);
    await screenshot(child, testInfo, "real-detached-desktop");
    await child.setViewportSize({ width: 375, height: 812 });
    const toolbar = child.getByRole("toolbar", { name: "Desktop controls" });
    await expect(toolbar).toBeVisible();
    expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await screenshot(child, testInfo, "narrow-desktop-controls");
    await child.setViewportSize({ width: 1100, height: 800 });

    await ui.metaSidebar.selectTab("Stats");
    await ui.metaSidebar.selectTab("Desktop");
    await expect(page.getByRole("button", { name: "Bring back", exact: true })).toBeVisible();
    await expect(viewport(page)).toHaveCount(0);
    expect(inlineConnections).toHaveLength(1);
    expect(app.windows()).toHaveLength(existingWindows + 1);

    const childClosed = child.waitForEvent("close");
    await child.getByRole("button", { name: "Bring back", exact: true }).click();
    await childClosed;
    await expectConnectedViewOnly(page);
    expect(inlineConnections).toHaveLength(2);
    await screenshot(page, testInfo, "inline-after-bring-back");

    const nextChildReady = app.waitForEvent("window");
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    const nextChild = await nextChildReady;
    await expectConnectedViewOnly(nextChild);
    const nextClosed = nextChild.waitForEvent("close");
    const nativeWindow = await app.browserWindow(nextChild);
    await nativeWindow.evaluate((window) => window.close());
    await nextClosed;
    await page.bringToFront();
    await expectConnectedViewOnly(page);
    expect(inlineConnections).toHaveLength(3);
    expect(inlineConnections.filter((connection) => !connection.closed)).toHaveLength(1);
    expect(app.windows()).toHaveLength(existingWindows);
    await screenshot(page, testInfo, "inline-after-native-close");
  });
});

// Set both variables to a dedicated, unauthenticated local sandbox from this branch.
// This does not launch or mutate the user's normal Xum instance.
const browserUrl = process.env.XUM_DESKTOP_E2E_URL;
const browserWorkspaceId = process.env.XUM_DESKTOP_E2E_WORKSPACE_ID;

browserTest.describe("browser desktop", () => {
  browserTest.skip(
    !browserUrl || !browserWorkspaceId,
    "Set XUM_DESKTOP_E2E_URL and XUM_DESKTOP_E2E_WORKSPACE_ID for an isolated real-VNC server"
  );

  browserTest(
    "real browser popup preserves exclusivity across parent reload and recovery",
    async ({ page }, testInfo) => {
      assert(browserUrl && browserWorkspaceId);
      const workspaceUrl = `${browserUrl.replace(/\/$/, "")}/workspace/${encodeURIComponent(browserWorkspaceId)}`;
      await page.goto(workspaceUrl);
      await enableRealDesktop(page, browserWorkspaceId);
      const connections = observeDesktopConnections(page);
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expectConnectedViewOnly(page);
      const originalConnection = connections[0];
      assert(originalConnection);

      const popupReady = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Detach", exact: true }).click();
      const popup = await popupReady;
      const popupConnections = observeDesktopConnections(popup);
      await expectConnectedViewOnly(popup);
      expect(popupConnections).toHaveLength(1);
      const popupConnection = popupConnections[0];
      assert(popupConnection);
      await expect(viewport(page)).toHaveCount(0);
      await expect.poll(() => originalConnection.closed).toBe(true);
      await screenshot(popup, testInfo, "browser-real-popout");

      await page.reload();
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expect(page.getByRole("button", { name: "Reconnect here", exact: true })).toBeVisible();
      await expect(viewport(page)).toHaveCount(0);
      expect(connections).toHaveLength(1);
      await expect(viewport(popup)).toBeVisible();
      // Popup destruction can discard its final DevTools socket/frame events. Record
      // native send/close calls synchronously in the surviving same-origin opener;
      // all calls still reach the real browser WebSocket and real VNC server.
      await page.evaluate(() => {
        const events: HandoffEvent[] = [];
        (window as Window & { __desktopHandoffEvents?: HandoffEvent[] }).__desktopHandoffEvents =
          events;
        const NativeWebSocket = window.WebSocket;
        // Preserve the native prototype; noVNC validates its immediate method properties.
        window.WebSocket = new Proxy(NativeWebSocket, {
          construct(target, args, newTarget) {
            const socket = Reflect.construct(target, args, newTarget) as WebSocket;
            if (new URL(socket.url).pathname.endsWith("/desktop/ws"))
              events.push({ type: "connect" });
            return socket;
          },
        });
      });
      await popup.evaluate(() => {
        const events = (window.opener as Window & { __desktopHandoffEvents?: HandoffEvent[] })
          .__desktopHandoffEvents;
        if (!events) throw new Error("Missing opener handoff recorder");
        const originalSend = WebSocket.prototype.send;
        const originalClose = WebSocket.prototype.close;
        WebSocket.prototype.send = function (data) {
          originalSend.call(this, data);
          if (!new URL(this.url).pathname.endsWith("/desktop/ws")) return;
          if (typeof data === "string" || data instanceof Blob) return;
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          events.push({ type: "send", bytes: Array.from(bytes) });
        };
        WebSocket.prototype.close = function (...args) {
          originalClose.apply(this, args);
          if (new URL(this.url).pathname.endsWith("/desktop/ws"))
            events.push({ type: "disconnect" });
        };
      });
      await popup.getByRole("button", { name: "Take control", exact: true }).click();
      await viewport(popup).click();
      await expect(
        popup.getByRole("button", { name: "Release control", exact: true })
      ).toBeVisible();
      await popup.keyboard.down("Shift");
      await expect
        .poll(() => popupConnection.keys.some((key) => key.keysym === 0xffe1 && key.down))
        .toBe(true);

      const closed = popup.waitForEvent("close");
      await page.getByRole("button", { name: "Reconnect here", exact: true }).click();
      await closed;
      await expectConnectedViewOnly(page);
      const events = await page.evaluate(
        () =>
          (window as Window & { __desktopHandoffEvents?: HandoffEvent[] }).__desktopHandoffEvents
      );
      assert(events);
      const evidencePath = testInfo.outputPath("browser-handoff-wire.json");
      await writeFile(evidencePath, JSON.stringify(events, null, 2));
      await testInfo.attach("browser-handoff-wire", {
        path: evidencePath,
        contentType: "application/json",
      });
      const keyIndex = (down: boolean) =>
        events.findIndex((event) => {
          if (event.type !== "send") return false;
          const key = readKeyEvent(new Uint8Array(event.bytes));
          return key?.keysym === 0xffe1 && key.down === down;
        });
      const disconnectIndex = events.findIndex((event) => event.type === "disconnect");
      expect(keyIndex(true)).toBeGreaterThanOrEqual(0);
      expect(keyIndex(false)).toBeGreaterThan(keyIndex(true));
      expect(disconnectIndex).toBeGreaterThan(keyIndex(false));
      expect(events.findIndex((event) => event.type === "connect")).toBeGreaterThan(
        disconnectIndex
      );
      expect(popupConnections).toHaveLength(1);
      expect(connections).toHaveLength(2);
      expect(connections.filter((connection) => !connection.closed)).toHaveLength(1);
      await screenshot(page, testInfo, "browser-recovered-after-parent-reload");
    }
  );
});
