import "../../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { MCPServerInfo, MCPTestResult } from "@/common/types/mcp";
import {
  MCPServerIdentityBadge,
  describeConfiguredConnection,
  stripBranding,
} from "./MCPServerIdentityBadge";

// Actual one-pixel PNG (the same bytes the shared boundary test accepts).
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOcAAAAASUVORK5CYII=";
const IDENTITY = { name: "Notion MCP", version: "1.2.0" };
const CONNECTION = { key: "notion-work", transport: "http" as const };

describe("describeConfiguredConnection", () => {
  test("remote servers retain the configured mode without assuming auto negotiated HTTP", () => {
    const entry: MCPServerInfo = {
      transport: "auto",
      url: "https://mcp.example.com:8443/tenant/42/mcp?token=secret#frag",
      headers: { Authorization: { secret: "MCP_TOKEN" } },
      disabled: false,
    };
    expect(describeConfiguredConnection("work", entry)).toEqual({
      key: "work",
      transport: "auto",
      origin: "https://mcp.example.com:8443",
    });
    expect(describeConfiguredConnection("legacy", { ...entry, transport: "sse" }).transport).toBe(
      "sse"
    );
    const credentialed = describeConfiguredConnection("work", {
      ...entry,
      url: "https://alice:hunter2@mcp.example.com/mcp",
    });
    // The hostname may contain "mcp"; only userinfo and the path are private.
    expect(credentialed).toEqual({
      key: "work",
      transport: "auto",
      origin: "https://mcp.example.com",
    });
  });

  test("non-HTTPS or unparseable URLs yield no origin", () => {
    for (const url of ["http://localhost:3333/mcp", "not a url", "file:///etc/passwd"]) {
      expect(
        describeConfiguredConnection("local", { transport: "http", url, disabled: false })
      ).toEqual({ key: "local", transport: "http" });
    }
  });

  test("stdio servers never leak command, args, env or cwd", () => {
    const entry: MCPServerInfo = {
      transport: "stdio",
      command: "bun",
      args: ["run", "/home/alice/secret-server.ts", "--token", "abc"],
      env: { API_KEY: "xyz" },
      cwd: "/home/alice/private",
      disabled: false,
    };
    const connection = describeConfiguredConnection("docs", entry);
    expect(connection).toEqual({ key: "docs", transport: "stdio" });
    expect(JSON.stringify(connection)).not.toMatch(/alice|secret|abc|xyz|bun/);
  });
});

describe("stripBranding", () => {
  test("removes identity and icon from successful results and leaves everything else intact", () => {
    const branded: MCPTestResult = {
      success: true,
      tools: ["search"],
      protocolVersion: "2026-07-28",
      serverInfo: IDENTITY,
      icon: PNG,
    };
    expect(stripBranding(branded)).toEqual({
      success: true,
      tools: ["search"],
      protocolVersion: "2026-07-28",
    });
    expect(stripBranding({ success: true, tools: [], icon: PNG })).toEqual({
      success: true,
      tools: [],
    });
    const failed: MCPTestResult = { success: false, error: "boom" };
    expect(stripBranding(failed)).toBe(failed);
    const plain: MCPTestResult = { success: true, tools: [] };
    expect(stripBranding(plain)).toBe(plain);
  });
});

describe("MCPServerIdentityBadge icon", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  function trigger(icon: string | null | undefined) {
    const view = render(
      <MCPServerIdentityBadge connection={CONNECTION} identity={IDENTITY} icon={icon} />
    );
    const button = view.getByRole("button", { name: "Server information: notion-work" });
    return { view, button };
  }

  test("renders a decorative fixed-size image only for a signature-checked PNG data URL", () => {
    const { button } = trigger(PNG);
    const image = button.querySelector("img");
    if (!image) throw new Error("PNG icon not rendered");
    expect(image.getAttribute("src")).toBe(PNG);
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("width")).toBe("14");
    expect(image.getAttribute("height")).toBe("14");
    expect(button.querySelector("svg")).toBeNull();
  });

  test("falls back to the generic icon for missing, mislabeled or malformed sources", () => {
    for (const icon of [
      undefined,
      null,
      "https://mcp.notion.com/icon.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:image/png;base64,PHN2Zy8+",
      PNG.replace("iVBORw0KGgo", "iVBORw0KGGo"),
    ]) {
      const { view, button } = trigger(icon);
      expect(button.querySelector("img")).toBeNull();
      expect(button.querySelector("svg")).not.toBeNull();
      view.unmount();
    }
  });

  test("a PNG that fails to decode falls back to the generic icon until a different icon arrives", () => {
    const { view, button } = trigger(PNG);
    fireEvent.error(button.querySelector("img")!);
    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector("svg")).not.toBeNull();
    // Same broken value stays on the fallback; a new value is tried again.
    view.rerender(
      <MCPServerIdentityBadge connection={CONNECTION} identity={IDENTITY} icon={PNG} />
    );
    expect(button.querySelector("img")).toBeNull();
    // Different payload bytes, still a well-formed PNG data URL for the boundary check.
    const other = PNG.replace("AAwMCAO+", "AAwMCAO/");
    view.rerender(
      <MCPServerIdentityBadge connection={CONNECTION} identity={IDENTITY} icon={other} />
    );
    expect(button.querySelector("img")?.getAttribute("src")).toBe(other);
  });
});
