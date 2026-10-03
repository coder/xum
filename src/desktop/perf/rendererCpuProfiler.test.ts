/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, expect, test } from "bun:test";
import {
  createRendererCpuProfiler,
  RendererTargetRegistry,
  type ProfilableDebugger,
  type ProfilableWebContents,
} from "./rendererCpuProfiler";

class FakeDebugger implements ProfilableDebugger {
  attachedBy: "us" | "other" | null = null;
  detaches = 0;
  readonly commands: string[] = [];
  private readonly detachListeners = new Set<() => void>();
  isAttached(): boolean {
    return this.attachedBy !== null;
  }
  attach(): void {
    if (this.attachedBy !== null) throw new Error("already attached");
    this.attachedBy = "us";
  }
  detach(): void {
    this.detaches += 1;
    this.attachedBy = null;
  }
  /** Commands that never answer, like a hung renderer. */
  readonly hang = new Set<string>();
  sendCommand(method: string): Promise<unknown> {
    this.commands.push(method);
    if (this.hang.has(method)) return new Promise(() => undefined);
    return Promise.resolve(method === "Profiler.stop" ? { profile: { nodes: [1] } } : {});
  }
  on(_event: "detach", listener: () => void): void {
    this.detachListeners.add(listener);
  }
  removeListener(_event: "detach", listener: () => void): void {
    this.detachListeners.delete(listener);
  }
  /** Chromium detached the session (renderer crash, DevTools took over). */
  emitDetach(): void {
    this.attachedBy = null;
    for (const listener of [...this.detachListeners]) listener();
  }
}

class FakeWebContents implements ProfilableWebContents {
  readonly debugger = new FakeDebugger();
  destroyed = false;
  devToolsOpen = false;
  private readonly destroyedListeners: Array<() => void> = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isDevToolsOpened(): boolean {
    return this.devToolsOpen;
  }
  once(_event: "destroyed", listener: () => void): void {
    this.destroyedListeners.push(listener);
  }
  destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners.splice(0)) listener();
  }
}

function setup() {
  const registry = new RendererTargetRegistry();
  const page = new FakeWebContents();
  const mainWindow = new FakeWebContents();
  registry.announce("r-page", page);
  const profiler = createRendererCpuProfiler({
    registry,
    getMainWebContents: () => mainWindow,
    commandTimeoutMs: 20,
  });
  return { registry, page, mainWindow, profiler };
}

describe("createRendererCpuProfiler", () => {
  test("profiles exactly the page that announced the rendererId and detaches its own session", async () => {
    const { page, mainWindow, profiler } = setup();
    const started = await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" });
    if (!started.ok) throw new Error(started.skippedReason);
    expect(page.debugger.attachedBy).toBe("us");
    expect(mainWindow.debugger.commands).toEqual([]);
    expect(await started.run.stop()).toEqual({ nodes: [1] });
    await started.run.cancel();
    expect(page.debugger.detaches).toBe(1);
  });

  test("skips unannounced, destroyed, debugged and DevTools pages without attaching", async () => {
    const { registry, page, mainWindow, profiler } = setup();
    // Browser tabs connected to this backend never announce: no webContents to profile.
    expect(await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-tab" })).toEqual({
      ok: false,
      skippedReason: "renderer-unknown",
    });

    mainWindow.devToolsOpen = true;
    expect(await profiler.start({ samplingIntervalUs: 1000 })).toEqual({
      ok: false,
      skippedReason: "devtools-open",
    });

    page.debugger.attachedBy = "other";
    expect(await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" })).toEqual({
      ok: false,
      skippedReason: "debugger-attached",
    });
    expect(page.debugger.attachedBy).toBe("other");
    expect(page.debugger.detaches).toBe(0);

    page.destroy();
    expect(registry.get("r-page")).toBeUndefined();
    expect(await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" })).toEqual({
      ok: false,
      skippedReason: "renderer-unknown",
    });
  });

  test("a session detached mid-capture fails the stop and is never detached by us", async () => {
    const { page, profiler } = setup();
    const started = await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" });
    if (!started.ok) throw new Error(started.skippedReason);
    page.debugger.emitDetach();
    // Someone else (e.g. DevTools) attaches afterwards; our cleanup must leave it alone.
    page.debugger.attachedBy = "other";
    await expect(started.run.stop()).rejects.toThrow("detached");
    await started.run.cancel();
    expect(page.debugger.detaches).toBe(0);
    expect(page.debugger.attachedBy).toBe("other");
  });

  test("a reloaded page's old rendererId no longer resolves to the replacement document", () => {
    const { registry, page } = setup();
    // Same webContents, new document: the reloaded page announces a fresh ID.
    registry.announce("r-page-reloaded", page);
    expect(registry.get("r-page")).toBeUndefined();
    expect(registry.get("r-page-reloaded")).toBe(page);
  });

  test("a renderer that never answers a command releases our session instead of holding it", async () => {
    const { page, profiler } = setup();
    page.debugger.hang.add("Profiler.start");
    await expect(
      profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" })
    ).rejects.toThrow("timed out");
    expect(page.debugger.detaches).toBe(1);

    page.debugger.hang.clear();
    page.debugger.hang.add("Profiler.stop");
    const started = await profiler.start({ samplingIntervalUs: 1000, rendererId: "r-page" });
    if (!started.ok) throw new Error(started.skippedReason);
    await expect(started.run.stop()).rejects.toThrow("timed out");
    expect(page.debugger.detaches).toBe(2);
    expect(page.debugger.isAttached()).toBe(false);
  });
});
