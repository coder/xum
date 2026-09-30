import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { MCPSettingsSection } from "@/browser/features/Settings/Sections/MCPSettingsSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { MCPServerInfo } from "@/common/types/mcp";

// Global MCP servers list. Two data sources drive this section:
//   1) api.mcp.list() — supplies the configured servers (via the mock client).
//   2) the global MCP test-result cache in localStorage (key "mcpTestResults:__global__")
//      — supplies the per-server "N tools" badge + tool-allowlist row.
// The story pre-caches tool results into that localStorage key; we replicate it
// directly so the populated state renders without clicking "Test" (mirrors the
// story's ProjectSettingsWithServers).
const SERVERS: Record<string, MCPServerInfo> = {
  mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
  posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
  filesystem: {
    transport: "stdio",
    command: "npx -y @anthropics/filesystem-server /tmp",
    disabled: false,
  },
};

const TEST_RESULTS: Record<string, string[]> = {
  mux: ["file_read", "file_write", "bash", "web_search", "web_fetch", "todo_write"],
  posthog: ["dashboard-create", "dashboard-get", "docs-search", "list-errors"],
  filesystem: ["read_file", "write_file", "list_directory"],
};

function seedMcpTestCache() {
  if (typeof localStorage === "undefined") return;
  const cached: Record<string, { result: { success: true; tools: string[] }; testedAt: number }> =
    {};
  for (const [serverName, tools] of Object.entries(TEST_RESULTS)) {
    cached[serverName] = { result: { success: true, tools }, testedAt: Date.now() };
  }
  // Matches getMCPTestResultsKey("__global__") = "mcpTestResults:<project>".
  localStorage.setItem("mcpTestResults:__global__", JSON.stringify(cached));
}

export const ProjectSettingsWithServers = () => {
  seedMcpTestCache();
  return (
    <MuxPreviewShell client={createMockORPCClient({ globalMcpServers: SERVERS })}>
      <div className="p-6 max-w-2xl">
        <MCPSettingsSection />
      </div>
    </MuxPreviewShell>
  );
};
