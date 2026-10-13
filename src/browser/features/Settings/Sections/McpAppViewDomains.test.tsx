// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { McpAppFrame } from "@/browser/features/RightSidebar/ArtifactsTab/McpAppFrame";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { McpAppViewDomains } from "@/common/orpc/schemas/mcpApps";
import {
  McpAppViewDomainsSection,
  unlistedMcpAppViewDomains,
  useMcpAppViewDomains,
} from "./McpAppViewDomains";

const API_ORIGIN = "https://api.example.com";
const VIEW = {
  toolCallId: "call-1",
  serverName: "charts",
  resourceUri: "ui://charts/view",
  toolName: "charts_show_chart",
  label: "Show chart",
  arguments: {},
  cancelled: false,
  failed: false,
};

let stored: McpAppViewDomains[] = [];
let revokeFails: Error | null = null;
let revoked: Array<{ projectPath: string; serverName: string }> = [];

function api(): APIClient {
  const overrides: TestApiOverrides<APIClient> = {
    mcpApps: {
      getView: () =>
        Promise.resolve({
          success: true as const,
          data: {
            html: "<p>view</p>",
            csp: { connectDomains: [API_ORIGIN] },
            prefersBorder: null,
            resultAvailable: true,
            result: { content: [] },
            invocation: { serverName: "charts", toolName: "show_chart", arguments: {} },
            approvedDomains: [API_ORIGIN],
            approvalProjectPath: "/repo",
          },
        }),
      listViewDomains: () => Promise.resolve(stored),
      revokeViewDomains: (input: { projectPath: string; serverName: string }) => {
        if (revokeFails) return Promise.reject(revokeFails);
        revoked.push(input);
        stored = stored.filter(
          (e) => e.projectPath !== input.projectPath || e.serverName !== input.serverName
        );
        return Promise.resolve();
      },
    },
  };
  return createTestApiClient(overrides);
}

/** The Settings block for every stored approval, as MCPSettingsSection renders it. */
function Approvals() {
  const viewDomains = useMcpAppViewDomains();
  return (
    <McpAppViewDomainsSection
      entries={viewDomains.entries}
      onRevoke={(entry) => void viewDomains.revoke(entry)}
      error={viewDomains.revokeError}
    />
  );
}

function renderWith(children: React.ReactNode) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={api()}>{children}</APIProvider>
    </ThemeProvider>
  );
}

async function frameCsp(view: ReturnType<typeof render>) {
  return (await view.findByTestId("mcp-app-frame")).getAttribute("srcdoc") ?? "";
}

describe("MCP Apps allowed view domains", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
    stored = [{ projectPath: "/repo", serverName: "charts", origins: [API_ORIGIN] }];
    revokeFails = null;
    revoked = [];
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a revoke reloads a mounted view of that server under the base policy at once", async () => {
    const view = renderWith(
      <>
        <McpAppFrame workspaceId="ws" view={VIEW} />
        <Approvals />
      </>
    );
    expect(await frameCsp(view)).toContain(`connect-src ${API_ORIGIN}`);
    fireEvent.click(await view.findByRole("button", { name: "Revoke" }));
    await waitFor(async () => expect(await frameCsp(view)).not.toContain(API_ORIGIN));
    // The view asks again.
    expect(view.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(revoked).toEqual([{ projectPath: "/repo", serverName: "charts" }]);
  });

  test("a failed revoke shows its error next to the entry and keeps it", async () => {
    revokeFails = new Error("config write failed");
    const view = renderWith(<Approvals />);
    fireEvent.click(await view.findByRole("button", { name: "Revoke" }));
    await view.findByText(/Could not revoke: config write failed/);
    expect(view.getByText(/api\.example\.com/)).toBeTruthy();
  });

  test("a malformed stored origin renders as text instead of crashing Settings", async () => {
    stored = [{ projectPath: "/repo", serverName: "charts", origins: ["not a url", API_ORIGIN] }];
    const view = renderWith(<Approvals />);
    await view.findByText(/not a url, api\.example\.com/);
  });

  test("approvals of servers without a row in the list are kept for their own block", () => {
    const entries = [
      { projectPath: "/repo", serverName: "charts", origins: [API_ORIGIN] },
      { projectPath: "/repo", serverName: "repo-only", origins: [API_ORIGIN] },
      { projectPath: "/repo", serverName: "constructor", origins: [API_ORIGIN] },
    ];
    expect(unlistedMcpAppViewDomains(entries, { charts: {} }).map((e) => e.serverName)).toEqual([
      "repo-only",
      "constructor",
    ]);
  });
});
