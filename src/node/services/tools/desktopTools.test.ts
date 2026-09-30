import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createDesktopTools } from "./desktopTools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

interface DesktopActionSuccessResult {
  success: true;
  message: string;
}

interface DesktopToolErrorResult {
  success: false;
  error: string;
}

interface DesktopScreenshotSuccessResult {
  type: "content";
  value: [
    {
      type: "text";
      text: string;
    },
    {
      type: "media";
      mediaType: "image/png";
      data: string;
    },
  ];
}

function createMockDesktopManager(options?: {
  screenshotImpl?: () => Promise<{
    imageBase64: string;
    mimeType: "image/png";
    width: number;
    height: number;
  }>;
  actionImpl?: (
    workspaceId: string,
    actionType: string,
    params: Record<string, unknown>
  ) => Promise<{
    success: boolean;
    error?: string;
  }>;
}): {
  desktopManager: DesktopSessionManager;
  screenshot: ReturnType<typeof mock>;
  action: ReturnType<typeof mock>;
} {
  const screenshot = mock(
    options?.screenshotImpl ??
      (() =>
        Promise.resolve({
          imageBase64: "cG5nLWRhdGE=",
          mimeType: "image/png" as const,
          width: 1280,
          height: 720,
        }))
  );
  const action = mock(options?.actionImpl ?? (() => Promise.resolve({ success: true as const })));

  return {
    desktopManager: {
      screenshot,
      action,
    } as unknown as DesktopSessionManager,
    screenshot,
    action,
  };
}

describe("desktop tools", () => {
  it("creates all desktop tools", () => {
    using tempDir = new TestTempDir("desktop-tools-create");
    const config = createTestToolConfig(tempDir.path);
    const { desktopManager } = createMockDesktopManager();

    const tools = createDesktopTools(config, desktopManager);

    expect(Object.keys(tools).sort()).toEqual([
      "desktop_click",
      "desktop_double_click",
      "desktop_drag",
      "desktop_key_press",
      "desktop_move_mouse",
      "desktop_screenshot",
      "desktop_scroll",
      "desktop_type",
    ]);
  });

  it("desktop_screenshot returns content with PNG media payload", async () => {
    using tempDir = new TestTempDir("desktop-tools-screenshot-success");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, screenshot } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    const result = (await tools.desktop_screenshot.execute!(
      { scaledWidth: 640, scaledHeight: 360 },
      mockToolCallOptions
    )) as DesktopScreenshotSuccessResult | DesktopToolErrorResult;

    expect(result).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "Desktop screenshot captured: 1280x720",
        },
        {
          type: "media",
          mediaType: "image/png",
          data: "cG5nLWRhdGE=",
        },
      ],
    });
    expect(screenshot).toHaveBeenCalledWith("workspace-123");
  });

  it("desktop_screenshot converts manager failures into structured errors", async () => {
    using tempDir = new TestTempDir("desktop-tools-screenshot-error");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager } = createMockDesktopManager({
      screenshotImpl: () => Promise.reject(new Error("capture failed")),
    });
    const tools = createDesktopTools(config, desktopManager);

    const result = (await tools.desktop_screenshot.execute!(
      {},
      mockToolCallOptions
    )) as DesktopToolErrorResult;

    expect(result).toEqual({
      success: false,
      error: "capture failed",
    });
  });

  it("delegates action tools with the correct action types and params", async () => {
    using tempDir = new TestTempDir("desktop-tools-actions");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, action } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    await tools.desktop_move_mouse.execute!({ x: 10, y: 20 }, mockToolCallOptions);
    await tools.desktop_drag.execute!(
      { startX: 1, startY: 2, endX: 3, endY: 4 },
      mockToolCallOptions
    );
    await tools.desktop_scroll.execute!(
      { x: 40, y: 50, deltaX: 6, deltaY: -7 },
      mockToolCallOptions
    );
    await tools.desktop_type.execute!({ text: "hello" }, mockToolCallOptions);
    await tools.desktop_key_press.execute!({ key: "ctrl+c" }, mockToolCallOptions);

    expect(action.mock.calls).toEqual([
      ["workspace-123", "move_mouse", { x: 10, y: 20 }],
      ["workspace-123", "drag", { startX: 1, startY: 2, endX: 3, endY: 4 }],
      ["workspace-123", "scroll", { x: 40, y: 50, deltaY: -7, deltaX: 6 }],
      ["workspace-123", "type_text", { text: "hello" }],
      ["workspace-123", "key_press", { key: "ctrl+c" }],
    ]);
  });

  it("maps desktop_click buttons to supported manager actions", async () => {
    using tempDir = new TestTempDir("desktop-tools-click-buttons");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, action } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    const defaultResult = (await tools.desktop_click.execute!(
      { x: 10, y: 20 },
      mockToolCallOptions
    )) as DesktopActionSuccessResult;
    const leftResult = (await tools.desktop_click.execute!(
      { x: 11, y: 21, button: "left" },
      mockToolCallOptions
    )) as DesktopActionSuccessResult;
    const rightResult = (await tools.desktop_click.execute!(
      { x: 12, y: 22, button: "right" },
      mockToolCallOptions
    )) as DesktopActionSuccessResult;

    expect(defaultResult).toEqual({
      success: true,
      message: "Clicked at (10, 20)",
    });
    expect(leftResult).toEqual({
      success: true,
      message: "Clicked at (11, 21)",
    });
    expect(rightResult).toEqual({
      success: true,
      message: "right-clicked at (12, 22)",
    });
    expect(action.mock.calls).toEqual([
      ["workspace-123", "click", { x: 10, y: 20 }],
      ["workspace-123", "click", { x: 11, y: 21 }],
      ["workspace-123", "right_click", { x: 12, y: 22 }],
    ]);
  });

  it("maps desktop_double_click buttons to supported manager actions", async () => {
    using tempDir = new TestTempDir("desktop-tools-double-click-buttons");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, action } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    const defaultResult = (await tools.desktop_double_click.execute!(
      { x: 10, y: 20 },
      mockToolCallOptions
    )) as DesktopActionSuccessResult;
    const leftResult = (await tools.desktop_double_click.execute!(
      { x: 11, y: 21, button: "left" },
      mockToolCallOptions
    )) as DesktopActionSuccessResult;

    expect(defaultResult).toEqual({
      success: true,
      message: "Double-clicked at (10, 20)",
    });
    expect(leftResult).toEqual({
      success: true,
      message: "Double-clicked at (11, 21)",
    });
    expect(action.mock.calls).toEqual([
      ["workspace-123", "double_click", { x: 10, y: 20 }],
      ["workspace-123", "double_click", { x: 11, y: 21 }],
    ]);
  });

  it("omits nullish optional args when delegating", async () => {
    using tempDir = new TestTempDir("desktop-tools-nullish");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, action } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    await tools.desktop_scroll.execute!(
      { x: 50, y: 60, deltaX: null, deltaY: 7 },
      mockToolCallOptions
    );

    expect(action).toHaveBeenCalledWith("workspace-123", "scroll", { x: 50, y: 60, deltaY: 7 });
  });

  it("returns structured errors when a desktop action fails", async () => {
    using tempDir = new TestTempDir("desktop-tools-action-error");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager } = createMockDesktopManager({
      actionImpl: () => Promise.reject(new Error("action failed")),
    });
    const tools = createDesktopTools(config, desktopManager);

    const result = (await tools.desktop_type.execute!(
      { text: "hello" },
      mockToolCallOptions
    )) as DesktopToolErrorResult;

    expect(result).toEqual({
      success: false,
      error: "action failed",
    });
  });

  it("accepts screenshot scaling hints as no-op inputs", async () => {
    using tempDir = new TestTempDir("desktop-tools-screenshot-scaling");
    const config = createTestToolConfig(tempDir.path, { workspaceId: "workspace-123" });
    const { desktopManager, screenshot } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    await tools.desktop_screenshot.execute!(
      { scaledWidth: 800, scaledHeight: 600 },
      mockToolCallOptions
    );

    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledWith("workspace-123");
  });

  it("returns structured errors when workspaceId is missing", async () => {
    using tempDir = new TestTempDir("desktop-tools-missing-workspace");
    const config = {
      ...createTestToolConfig(tempDir.path),
      workspaceId: undefined,
    };
    const { desktopManager, screenshot, action } = createMockDesktopManager();
    const tools = createDesktopTools(config, desktopManager);

    const screenshotResult = (await tools.desktop_screenshot.execute!(
      {},
      mockToolCallOptions
    )) as DesktopToolErrorResult;
    const clickResult = (await tools.desktop_click.execute!(
      { x: 1, y: 2 },
      mockToolCallOptions
    )) as DesktopToolErrorResult;

    expect(screenshotResult).toEqual({
      success: false,
      error: "desktop_screenshot requires workspaceId",
    });
    expect(clickResult).toEqual({
      success: false,
      error: "desktop_click requires workspaceId",
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
