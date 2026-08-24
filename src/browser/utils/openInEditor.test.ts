import { describe, expect, mock, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { openInEditor } from "./openInEditor";
import type { RuntimeConfig } from "@/common/types/runtime";

interface GlobalWithOptionalWindow {
  window?: unknown;
}

async function withWindow<T>(windowValue: unknown, fn: () => Promise<T> | T): Promise<T> {
  const globalWithWindow = globalThis as unknown as GlobalWithOptionalWindow;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalWithWindow, "window");
  const prevWindow = globalWithWindow.window;

  try {
    globalWithWindow.window = windowValue;
    return await fn();
  } finally {
    if (!hadWindow) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = prevWindow;
    }
  }
}

describe("openInEditor", () => {
  const workspaceId = "ws-123";
  const filePath = "/home/user/project/plan.md";
  const parentDir = "/home/user/project";

  type OpenCall = [url: string, target?: string];

  // Electron-like window (`api` present via preload): deep links launch directly through
  // window.open with no placeholder. Browser-mode behavior is covered separately below.
  function createMockWindow(calls: OpenCall[]) {
    return {
      api: {},
      localStorage: { getItem: () => null },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return null;
      },
    };
  }

  // Browser-mode window (no `api`): window.open returns a placeholder that records
  // navigations and close() calls, mirroring a real popup.
  function createBrowserModeWindow(calls: OpenCall[], opts?: { popupBlocked?: boolean }) {
    const placeholder = {
      closed: false,
      navigations: [] as string[],
      location: {},
      close(): void {
        this.closed = true;
      },
    };
    Object.defineProperty(placeholder.location, "href", {
      set(value: string) {
        placeholder.navigations.push(value);
      },
    });
    const windowValue = {
      localStorage: { getItem: () => null },
      location: { hostname: "localhost" },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return opts?.popupBlocked ? null : placeholder;
      },
    };
    return { windowValue, placeholder };
  }

  // Editor opens must be recorded on the backend before any launch (archive safety), so
  // every launch-path test needs an api stub whose recording succeeds.
  function createApiStub(extra?: Record<string, unknown>): APIClient {
    return {
      general: {
        recordEditorOpen: () => Promise.resolve({ success: true }),
      },
      ...extra,
    } as unknown as APIClient;
  }

  test("opens SSH file deep link (does not fall back to parent dir)", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/xum",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: createApiStub(),
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.includes("ssh-remote+devbox")).toBe(true);
    expect(url.endsWith(`${filePath}:1:1`)).toBe(true);
  });

  test("opens devcontainer deep links with mapped container path", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "devcontainer",
      configPath: ".devcontainer/devcontainer.json",
    };

    const api = createApiStub({
      workspace: {
        getDevcontainerInfo: () =>
          Promise.resolve({
            containerName: "jovial_newton",
            containerWorkspacePath: "/workspaces/myapp",
            hostWorkspacePath: "/Users/me/projects/myapp",
          }),
      },
    });

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: "/Users/me/projects/myapp/src/app.ts",
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url).toMatch(/dev-container\+[0-9a-f]+\/workspaces\/myapp\/src$/);
  });

  test("opens Docker deep links at parent dir when targetPath is a file", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "docker",
      image: "node:20",
      containerName: "mux-workspace-123",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: createApiStub(),
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.endsWith(filePath)).toBe(false);
    expect(url.endsWith(`/${parentDir}`)).toBe(true);
  });

  test("does not record the open when a deterministic compatibility check refuses", async () => {
    const calls: OpenCall[] = [];
    const recordEditorOpen = mock(() => Promise.resolve({ success: true }));
    const api = { general: { recordEditorOpen } } as unknown as APIClient;

    // Zed + Docker is refused deterministically with no launch; recording first would leave
    // a sticky durable marker permanently refusing snapshot archives of the workspace.
    const windowWithZed = {
      api: {},
      localStorage: { getItem: () => JSON.stringify({ editor: "zed" }) },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return null;
      },
    };
    const result = await withWindow(windowWithZed, () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "docker", image: "node:20", containerName: "mux-ws" },
        isFile: true,
      })
    );

    expect(result.success).toBe(false);
    expect(recordEditorOpen).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  test("refuses to launch while disconnected (open cannot be recorded)", async () => {
    const calls: OpenCall[] = [];

    // api is null while the UI reconnects, but backend agents keep running: an unrecorded
    // launch could race a concurrent archive, so the open must fail closed.
    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: null,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/xum" },
        isFile: true,
      })
    );

    expect(result.success).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("refuses to launch when recording the open fails", async () => {
    const calls: OpenCall[] = [];

    const api = {
      general: {
        recordEditorOpen: () => Promise.reject(new Error("connection lost")),
      },
    } as unknown as APIClient;

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/xum" },
        isFile: true,
      })
    );

    expect(result.success).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("browser mode: opens a placeholder synchronously and navigates it to the deep link", async () => {
    const calls: OpenCall[] = [];
    const { windowValue, placeholder } = createBrowserModeWindow(calls);
    // Resolving this recording RPC yields the microtask queue, exactly the await that would
    // outlast the click's transient user activation if window.open ran after it.
    const recordEditorOpen = mock(() => Promise.resolve({ success: true }));
    const api = { general: { recordEditorOpen } } as unknown as APIClient;

    const result = await withWindow(windowValue, () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/xum" },
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    // The only window.open call is the synchronous placeholder; the deep link reaches the
    // already-open window via navigation, immune to popup blocking.
    expect(calls).toEqual([["about:blank", "_blank"]]);
    expect(placeholder.navigations.length).toBe(1);
    expect(placeholder.navigations[0]).toContain("ssh-remote+devbox");
    expect(placeholder.closed).toBe(false);
  });

  test("browser mode: closes the placeholder when the open is refused", async () => {
    const calls: OpenCall[] = [];
    const { windowValue, placeholder } = createBrowserModeWindow(calls);
    const api = {
      general: {
        recordEditorOpen: () => Promise.resolve({ success: false, error: "being archived" }),
      },
    } as unknown as APIClient;

    const result = await withWindow(windowValue, () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/xum" },
        isFile: true,
      })
    );

    expect(result.success).toBe(false);
    // A refused open must not leave a stray blank tab behind.
    expect(placeholder.navigations.length).toBe(0);
    expect(placeholder.closed).toBe(true);
  });

  test("browser mode: refuses before recording when the placeholder is popup-blocked", async () => {
    const calls: OpenCall[] = [];
    const { windowValue, placeholder } = createBrowserModeWindow(calls, { popupBlocked: true });
    const recordEditorOpen = mock(() => Promise.resolve({ success: true }));
    const api = { general: { recordEditorOpen } } as unknown as APIClient;

    const result = await withWindow(windowValue, () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: filePath,
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/xum" },
        isFile: true,
      })
    );

    // A blocked placeholder means the post-await launch would be silently blocked too;
    // succeeding would persist a sticky editor-open marker for an editor that never opened,
    // permanently refusing model-driven archives — so the open is refused before recording.
    expect(result.success).toBe(false);
    expect(result.error).toContain("popup");
    expect(recordEditorOpen).not.toHaveBeenCalled();
    expect(calls).toEqual([["about:blank", "_blank"]]);
    expect(placeholder.navigations.length).toBe(0);
  });
});
