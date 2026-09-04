import type { BrowserWindow, BrowserWindowConstructorOptions, Event } from "electron";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";

interface DesktopWindowEntry {
  window: BrowserWindow;
  instanceId: string;
  loaded: Promise<void>;
}

/** One desktop viewer per workspace; closing the viewer never stops the desktop session. */
export class DesktopWindowManager {
  private readonly windows = new Map<string, DesktopWindowEntry>();
  private disposed = false;

  constructor(
    private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow,
    private readonly isPackaged: boolean
  ) {}

  async openWindow(workspaceId: string, instanceId: string): Promise<{ instanceId: string }> {
    assert(workspaceId.length > 0 && instanceId.length > 0, "Desktop window IDs must be non-empty");
    if (this.disposed) throw new Error("Desktop windows are shutting down");

    const existing = this.windows.get(workspaceId);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      await existing.loaded;
      this.assertCurrent(workspaceId, existing);
      return { instanceId: existing.instanceId };
    }

    const getEnv = (suffix: string) => resolveXumEnvironmentValue(suffix, process.env);
    const useDevServer = !this.isPackaged && getEnv("E2E_LOAD_DIST") !== "1";
    const url = useDevServer
      ? new URL(
          `http://${getEnv("DEVSERVER_HOST") ?? "127.0.0.1"}:${getEnv("DEVSERVER_PORT") ?? "5173"}/desktop.html`
        )
      : pathToFileURL(path.join(__dirname, "../desktop.html"));
    url.search = new URLSearchParams({ workspaceId, instanceId }).toString();

    const window = this.createWindow({
      width: 1100,
      height: 800,
      title: "Desktop",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "../preload.js"),
        spellcheck: false,
      },
    });
    const entry: DesktopWindowEntry = { window, instanceId, loaded: Promise.resolve() };
    // Reserve before loadURL yields so duplicate opens share this exact instance.
    this.windows.set(workspaceId, entry);

    try {
      // SECURITY AUDIT: the preload exposes privileged IPC. Same-origin is insufficient for
      // file: URLs or other app pages; only this viewer's exact path/query may navigate.
      const guardNavigation = (event: Event, target: string): void => {
        try {
          const destination = new URL(target);
          destination.hash = "";
          if (destination.href === url.href) return;
        } catch {
          // Malformed targets are untrusted too.
        }
        event.preventDefault();
      };
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", guardNavigation);
      window.webContents.on("will-redirect", guardNavigation);
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      const closeFailedWindow = (): void => {
        if (this.windows.get(workspaceId) === entry) this.closeWorkspace(workspaceId);
      };
      // Manager truth must release a crashed/failed viewer so the embedded viewer can recover.
      window.webContents.on("render-process-gone", closeFailedWindow);
      window.webContents.on(
        "did-fail-load",
        (_event, errorCode, _description, _url, isMainFrame) => {
          // ERR_ABORTED also occurs when a normal reload supersedes an in-flight navigation.
          if (isMainFrame && errorCode !== -3) closeFailedWindow();
        }
      );
      window.on("closed", () => {
        if (this.windows.get(workspaceId) === entry) this.windows.delete(workspaceId);
      });
      entry.loaded = window.loadURL(url.href);
      await entry.loaded;
      this.assertCurrent(workspaceId, entry);
      return { instanceId };
    } catch (error) {
      if (this.windows.get(workspaceId) === entry) this.windows.delete(workspaceId);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  private assertCurrent(workspaceId: string, entry: DesktopWindowEntry): void {
    if (this.windows.get(workspaceId) !== entry || entry.window.isDestroyed()) {
      throw new Error(`Desktop window for ${workspaceId} was closed while opening`);
    }
  }

  getWindow(workspaceId: string): { instanceId: string } | null {
    const entry = this.windows.get(workspaceId);
    return entry && !entry.window.isDestroyed() ? { instanceId: entry.instanceId } : null;
  }

  closeWindow(workspaceId: string, instanceId: string): void {
    if (this.windows.get(workspaceId)?.instanceId === instanceId) this.closeWorkspace(workspaceId);
  }

  closeWorkspace(workspaceId: string): void {
    const entry = this.windows.get(workspaceId);
    this.windows.delete(workspaceId);
    // Teardown must not be vetoed by a renderer's beforeunload handler.
    if (entry && !entry.window.isDestroyed()) entry.window.destroy();
  }

  closeAll(): void {
    this.disposed = true;
    for (const workspaceId of this.windows.keys()) this.closeWorkspace(workspaceId);
  }
}
