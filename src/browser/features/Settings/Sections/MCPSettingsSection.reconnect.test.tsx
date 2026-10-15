import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { CONNECTION_LOST_MESSAGE } from "@/browser/contexts/connectionLink";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { MCPServerInfo } from "@/common/types/mcp";
import { MCPSettingsSection } from "./MCPSettingsSection";

type ServerList = Record<string, MCPServerInfo>;

/** What the next server's `mcp.list` answers, or a promise of it. */
let serverList: ServerList | Promise<ServerList>;

function serverOverrides(): TestApiOverrides<APIClient> {
  const list = serverList;
  // The story mock covers the section's other reads; only the list is under test.
  const client = createMockORPCClient();
  return { ...client, mcp: { ...client.mcp, list: () => Promise.resolve(list) } };
}

function stdio(command: string): MCPServerInfo {
  return { transport: "stdio", command, disabled: false };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

// A reconnect reloads the list through the new client. The rows stay on screen until the reload
// answers (no "Loading servers…" in their place), and a load cut off by the drop is no failure.
describe.each([...GAP_MODES])("MCPSettingsSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  let harness: ConnectionHarness;

  beforeEach(() => {
    cleanupDom = installDom();
    serverList = { alpha: stdio("alpha-mcp") };
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderSection() {
    return render(
      <TooltipProvider>
        <harness.Wrapper>
          <MCPSettingsSection />
        </harness.Wrapper>
      </TooltipProvider>
    );
  }

  test("keeps the shown list until the reload answers", async () => {
    const view = renderSection();
    await waitFor(() => expect(view.queryByText("alpha-mcp")).not.toBeNull());

    let answer: ((list: ServerList) => void) | null = null;
    serverList = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    harness.reconnect();
    await settle();
    expect(view.queryByText("alpha-mcp")).not.toBeNull();
    expect(view.queryByText("Loading servers…")).toBeNull();

    act(() => answer?.({ beta: stdio("beta-mcp") }));
    await waitFor(() => expect(view.queryByText("beta-mcp")).not.toBeNull());
    expect(view.queryByText("alpha-mcp")).toBeNull();
  });

  // An edit begun on a stale row would overwrite the configuration the reload brings.
  test("locks the kept rows until the reload answers", async () => {
    const view = renderSection();
    const edit = await waitFor(() => view.getByRole("button", { name: "Edit server" }));
    // happy-dom does not apply a disabled fieldset to `disabled`: read the fieldset.
    const isLocked = () => edit.closest("fieldset")?.disabled === true;
    expect(isLocked()).toBe(false);

    let answer: ((list: ServerList) => void) | null = null;
    serverList = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    harness.reconnect();
    await settle();
    expect(isLocked()).toBe(true);

    act(() => answer?.({ alpha: stdio("alpha-mcp") }));
    await waitFor(() => expect(isLocked()).toBe(false));
  });

  // A first load cut off by the drop never read the list: it must not claim "no servers".
  test("keeps the loading placeholder when the first load is cut off", async () => {
    serverList = new Promise(() => undefined);
    harness = createConnectionHarness(mode, serverOverrides);
    const view = renderSection();
    await settle();

    serverList = { alpha: stdio("alpha-mcp") };
    await harness.drop();
    await settle();
    expect(view.queryByText("No MCP servers configured yet.")).toBeNull();
    expect(view.queryByText("Loading servers…")).not.toBeNull();

    harness.reconnect();
    await waitFor(() => expect(view.queryByText("alpha-mcp")).not.toBeNull());
  });

  test("shows no load failure for a reload the drop cut off", async () => {
    const view = renderSection();
    await waitFor(() => expect(view.queryByText("alpha-mcp")).not.toBeNull());

    // The reload after a first reconnect is still in flight when the connection drops again.
    serverList = new Promise(() => undefined);
    await harness.drop();
    harness.reconnect();
    await settle();
    serverList = { beta: stdio("beta-mcp") };
    await harness.drop();
    await settle();
    expect(view.queryByText(CONNECTION_LOST_MESSAGE)).toBeNull();
    expect(view.queryByText("alpha-mcp")).not.toBeNull();

    harness.reconnect();
    await waitFor(() => expect(view.queryByText("beta-mcp")).not.toBeNull());
  });
});
