// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
// Pushes one project-config change event to the open onConfigChanged subscriptions.
let pushConfigChanged: () => void = () => undefined;
// Backend calls the renderer made, and the signals of its config subscriptions.
let listCalls = 0;
let listFailures = 0;
let subscribeFailures = 0;
let subscriptions: AbortSignal[] = [];

function api(): APIClient {
  const overrides: TestApiOverrides<APIClient> = {
    config: {
      onConfigChanged: (_input: void, options?: { signal?: AbortSignal }) => {
        if (subscribeFailures > 0) {
          subscribeFailures--;
          return Promise.reject(new Error("transient IPC failure"));
        }
        if (options?.signal) subscriptions.push(options.signal);
        const waiting: Array<() => void> = [];
        // Every open subscription sees the event (the app's config store has one too).
        const pushOthers = pushConfigChanged;
        pushConfigChanged = () => {
          pushOthers();
          waiting.splice(0).forEach((resolve) => resolve());
        };
        async function* changes() {
          while (!options?.signal?.aborted) {
            await new Promise<void>((resolve) => waiting.push(resolve));
            yield undefined;
          }
        }
        return Promise.resolve(changes());
      },
    },
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
      listViewDomains: () => {
        listCalls++;
        if (listFailures > 0) {
          listFailures--;
          return Promise.reject(new Error("transient IPC failure"));
        }
        return Promise.resolve(stored);
      },
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

let client: APIClient;
function renderWith(children: React.ReactNode) {
  client = api();
  return render(
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={client}>{children}</APIProvider>
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
    pushConfigChanged = () => undefined;
    listCalls = 0;
    listFailures = 0;
    subscribeFailures = 0;
    subscriptions = [];
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

  test("a revoke from another session reloads a mounted view too", async () => {
    const view = renderWith(<McpAppFrame workspaceId="ws" view={VIEW} />);
    expect(await frameCsp(view)).toContain(`connect-src ${API_ORIGIN}`);
    stored = [];
    await act(async () => {
      pushConfigChanged();
      await Promise.resolve();
    });
    await waitFor(async () => expect(await frameCsp(view)).not.toContain(API_ORIGIN));
  });

  test("a revoke between the view's fetch and its subscription still reloads it", async () => {
    // getView still reports the approval, but it is gone by the time the view follows changes,
    // and no further config event comes.
    stored = [];
    const view = renderWith(<McpAppFrame workspaceId="ws" view={VIEW} />);
    await waitFor(async () => expect(await frameCsp(view)).not.toContain(API_ORIGIN));
  });

  test("mounted views share one subscription and one read per config change", async () => {
    const settled = async () => {
      for (let i = 0; i < 5; i++) await act(() => Promise.resolve());
    };
    const live = () => subscriptions.filter((signal) => !signal.aborted).length;
    const frames = (count: number) => (
      <>
        {Array.from({ length: count }, (_, i) => (
          <McpAppFrame key={i} workspaceId="ws" view={VIEW} variant={i ? "inline" : "panel"} />
        ))}
      </>
    );
    const view = renderWith(frames(1));
    await waitFor(() => expect(listCalls).toBeGreaterThan(0));
    await settled();
    const withOne = live();
    // A second view of the server opens no subscription of its own.
    view.rerender(
      <ThemeProvider forcedTheme="dark">
        <APIProvider client={client}>{frames(2)}</APIProvider>
      </ThemeProvider>
    );
    await waitFor(() => expect(view.getAllByTestId("mcp-app-frame")).toHaveLength(2));
    await settled();
    expect(live()).toBe(withOne);
    const before = listCalls;
    await act(async () => {
      pushConfigChanged();
      await Promise.resolve();
    });
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
    await settled();
    expect(listCalls - before).toBe(1);
    // The shared subscription closes with the last view.
    cleanup();
    expect(live()).toBe(0);
  });

  test("a failed reconciliation read does not stop later revocations from applying", async () => {
    listFailures = 1;
    const view = renderWith(<McpAppFrame workspaceId="ws" view={VIEW} />);
    expect(await frameCsp(view)).toContain(`connect-src ${API_ORIGIN}`);
    // The first read (when the listener starts) fails.
    await waitFor(() => expect(listCalls).toBeGreaterThan(0));
    stored = [];
    await act(async () => {
      pushConfigChanged();
      await Promise.resolve();
    });
    await waitFor(async () => expect(await frameCsp(view)).not.toContain(API_ORIGIN));
  });

  test("a lost subscription is started again by the next view that mounts", async () => {
    const frame = (count: number) => (
      <ThemeProvider forcedTheme="dark">
        <APIProvider client={client}>
          {Array.from({ length: count }, (_, i) => (
            <McpAppFrame key={i} workspaceId="ws" view={VIEW} variant={i ? "inline" : "panel"} />
          ))}
        </APIProvider>
      </ThemeProvider>
    );
    const view = renderWith(<></>);
    await act(() => Promise.resolve());
    // The views' shared subscription (opened after the app's own) fails once.
    subscribeFailures = 1;
    view.rerender(frame(1));
    expect(await frameCsp(view)).toContain(`connect-src ${API_ORIGIN}`);
    await waitFor(() => expect(subscribeFailures).toBe(0));
    view.rerender(frame(2));
    await waitFor(() => expect(view.getAllByTestId("mcp-app-frame")).toHaveLength(2));
    for (let i = 0; i < 5; i++) await act(() => Promise.resolve());
    stored = [];
    await act(async () => {
      pushConfigChanged();
      await Promise.resolve();
    });
    await waitFor(async () => {
      for (const element of view.getAllByTestId("mcp-app-frame")) {
        expect(element.getAttribute("srcdoc")).not.toContain(API_ORIGIN);
      }
    });
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
