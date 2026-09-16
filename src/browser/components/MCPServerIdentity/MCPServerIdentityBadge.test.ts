import { describe, expect, test } from "bun:test";
import type { MCPServerInfo, MCPTestResult } from "@/common/types/mcp";
import { describeConfiguredConnection, stripServerInfo } from "./MCPServerIdentityBadge";

describe("describeConfiguredConnection", () => {
  test("remote servers expose only key, transport family and the HTTPS origin", () => {
    const entry: MCPServerInfo = {
      transport: "auto",
      url: "https://mcp.example.com:8443/tenant/42/mcp?token=secret#frag",
      headers: { Authorization: { secret: "MCP_TOKEN" } },
      disabled: false,
    };
    expect(describeConfiguredConnection("work", entry)).toEqual({
      key: "work",
      transport: "http",
      origin: "https://mcp.example.com:8443",
    });
    expect(describeConfiguredConnection("legacy", { ...entry, transport: "sse" }).transport).toBe(
      "sse"
    );
    // Whether or not a credentialed URL keeps its origin, credentials never leave.
    const credentialed = describeConfiguredConnection("work", {
      ...entry,
      url: "https://alice:hunter2@mcp.example.com/mcp",
    });
    expect(JSON.stringify(credentialed)).not.toMatch(/alice|hunter2|\/mcp/);
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

describe("stripServerInfo", () => {
  test("removes identity from successful results and leaves everything else intact", () => {
    const branded: MCPTestResult = {
      success: true,
      tools: ["search"],
      protocolVersion: "2026-07-28",
      serverInfo: { name: "Notion MCP", version: "1.2.0" },
    };
    expect(stripServerInfo(branded)).toEqual({
      success: true,
      tools: ["search"],
      protocolVersion: "2026-07-28",
    });
    const failed: MCPTestResult = { success: false, error: "boom" };
    expect(stripServerInfo(failed)).toBe(failed);
    const plain: MCPTestResult = { success: true, tools: [] };
    expect(stripServerInfo(plain)).toBe(plain);
  });
});
