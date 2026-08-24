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

  function createMockWindow(calls: OpenCall[]) {
    return {
      localStorage: { getItem: () => null },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return null;
      },
    };
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
});
