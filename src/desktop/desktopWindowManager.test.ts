import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { EventEmitter } from "node:events";
import { DesktopWindowManager } from "./desktopWindowManager";

class TestWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  url = "";
  loading = Promise.resolve();
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: mock<(handler: () => { action: string }) => void>(),
  });
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore = mock(() => {
    this.minimized = false;
  });
  focus = mock(() => undefined);
  loadURL = (url: string) => {
    this.url = url;
    return this.loading;
  };
  destroy = () => {
    this.destroyed = true;
    this.emit("closed");
  };
}

function setup(isPackaged = false) {
  const windows: TestWindow[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  let loading = Promise.resolve();
  const manager = new DesktopWindowManager((windowOptions) => {
    const window = new TestWindow();
    window.loading = loading;
    windows.push(window);
    options.push(windowOptions);
    // Electron is the foreign host boundary; no global module mocking can leak into other suites.
    return window as unknown as BrowserWindow;
  }, isPackaged);
  return {
    manager,
    windows,
    options,
    setLoading: (promise: Promise<void>) => {
      loading = promise;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of ["XUM_DEVSERVER_HOST", "XUM_DEVSERVER_PORT", "XUM_E2E_LOAD_DIST"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("DesktopWindowManager", () => {
  test("uses the sandbox origin, encodes identities, and isolates the preload", async () => {
    process.env.XUM_DEVSERVER_HOST = "localhost";
    process.env.XUM_DEVSERVER_PORT = "54321";
    process.env.XUM_E2E_LOAD_DIST = "0";
    const { manager, windows, options } = setup();
    await manager.openWindow("workspace & one", "instance?two");
    const url = new URL(windows[0].url);
    expect(url.origin).toBe("http://localhost:54321");
    expect(url.pathname).toBe("/desktop.html");
    expect(url.searchParams.get("workspaceId")).toBe("workspace & one");
    expect(url.searchParams.get("instanceId")).toBe("instance?two");
    expect(options[0].webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
    });
    expect(options[0].webPreferences?.preload).toEndWith("preload.js");
    manager.closeAll();
  });

  test.each([false, true])(
    "blocks navigation to other origins, files, app pages, or instances (packaged=%s)",
    async (packaged) => {
      process.env.XUM_E2E_LOAD_DIST = "0";
      const { manager, windows } = setup(packaged);
      await manager.openWindow("workspace", "instance");
      const window = windows[0];
      const trusted = new URL(window.url);
      const otherPage = new URL("./index.html", trusted).href;
      const otherInstance = new URL(trusted);
      otherInstance.searchParams.set("instanceId", "replacement");
      const forbidden = [
        "https://example.com",
        "file:///etc/passwd",
        otherPage,
        otherInstance.href,
        "javascript:alert(1)",
        "not a URL",
      ];
      for (const eventName of ["will-navigate", "will-redirect"]) {
        for (const url of forbidden) {
          const preventDefault = mock(() => undefined);
          window.webContents.emit(eventName, { preventDefault }, url);
          expect(preventDefault).toHaveBeenCalledTimes(1);
        }
        const preventDefault = mock(() => undefined);
        window.webContents.emit(eventName, { preventDefault }, `${window.url}#viewer`);
        expect(preventDefault).not.toHaveBeenCalled();
      }
      const handler = window.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(handler()).toEqual({ action: "deny" });
      const preventDefault = mock(() => undefined);
      window.webContents.emit("will-attach-webview", { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      manager.closeAll();
    }
  );

  test("forced dist mode never contacts the dev server", async () => {
    process.env.XUM_E2E_LOAD_DIST = "1";
    const { manager, windows } = setup();
    await manager.openWindow("workspace", "instance");
    expect(new URL(windows[0].url).protocol).toBe("file:");
    manager.closeAll();
  });

  test("racing opens focus and return the original instance, even while loading", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const first = manager.openWindow("workspace", "first");
    windows[0].minimized = true;
    const second = manager.openWindow("workspace", "second");
    expect(windows).toHaveLength(1);
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "first" });
    expect(windows[0].focus).toHaveBeenCalledTimes(1);
    expect(windows[0].minimized).toBe(false);
    gate.resolve();
    expect(await first).toEqual({ instanceId: "first" });
    expect(await second).toEqual({ instanceId: "first" });
    manager.closeWindow("workspace", "second");
    expect(windows[0].destroyed).toBe(false);
    manager.closeWindow("workspace", "first");
    expect(manager.getWindow("workspace")).toBeNull();
  });

  test("failed loading releases the window and permits a retry", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const first = manager.openWindow("workspace", "failed").catch((error: unknown) => error);
    const duplicate = manager.openWindow("workspace", "duplicate").catch((error: unknown) => error);
    gate.reject(new Error("load failed"));
    expect(await first).toEqual(new Error("load failed"));
    expect(await duplicate).toEqual(new Error("load failed"));
    expect(windows[0].destroyed).toBe(true);
    expect(manager.getWindow("workspace")).toBeNull();
    setLoading(Promise.resolve());
    expect(await manager.openWindow("workspace", "retry")).toEqual({ instanceId: "retry" });
    manager.closeAll();
  });

  test("closing a loading window cannot resurrect it or remove its replacement", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const pending = manager.openWindow("workspace", "old").catch((error: unknown) => error);
    manager.closeWorkspace("workspace");
    setLoading(Promise.resolve());
    await manager.openWindow("workspace", "new");
    windows[0].emit("closed");
    gate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    manager.closeWindow("workspace", "old");
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "new" });
    manager.closeAll();
  });

  test("renderer crashes and main-frame load failures release manager truth", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("workspace", "crashing");
    windows[0].webContents.emit("render-process-gone");
    expect(manager.getWindow("workspace")).toBeNull();
    expect(windows[0].destroyed).toBe(true);
    await manager.openWindow("workspace", "reloading");
    windows[1].webContents.emit("did-fail-load", {}, -3, "aborted", "", true);
    windows[1].webContents.emit("did-fail-load", {}, -2, "subframe failed", "", false);
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "reloading" });
    windows[1].webContents.emit("did-fail-load", {}, -2, "reload failed", "", true);
    expect(manager.getWindow("workspace")).toBeNull();
    expect(windows[1].destroyed).toBe(true);
  });

  test("constructor failure leaves no reservation", async () => {
    const manager = new DesktopWindowManager(() => {
      throw new Error("constructor failed");
    }, false);
    expect(
      await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
    ).toEqual(new Error("constructor failed"));
    expect(manager.getWindow("workspace")).toBeNull();
  });

  test("shutdown closes every workspace and rejects new opens", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("one", "one");
    await manager.openWindow("two", "two");
    manager.closeAll();
    expect(windows.every((window) => window.destroyed)).toBe(true);
    expect(manager.getWindow("one")).toBeNull();
    expect(await manager.openWindow("one", "new").catch((error: unknown) => error)).toBeInstanceOf(
      Error
    );
    expect(windows).toHaveLength(2);
  });
});
