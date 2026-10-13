// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { BackgroundBashOutputDialog } from "@/browser/components/BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import { ProjectMCPOverview } from "@/browser/components/ProjectMCPOverview/ProjectMCPOverview";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import type { TestApiOverrides } from "@/browser/testUtils";

/*
 * Panes keep what they show while Xum reconnects. That must not hide failures:
 * - a server cancel on a live socket (a plain AbortError) is an error like any other, not a lost
 *   connection, since no new client will come to retry it.
 */

let answerServers: () => Promise<unknown>;
let answerOutput: () => Promise<unknown>;

/** A server cancel on a live socket: an abort that is not a lost connection. */
function serverCancel(): Promise<never> {
  return Promise.reject(new DOMException("cancelled by the server", "AbortError"));
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    mcp: { list: () => answerServers() },
    workspace: { backgroundBashes: { getOutput: () => answerOutput() } },
  } as unknown as TestApiOverrides<APIClient>;
}

let harness: ConnectionHarness;

function Wrapper(props: { children: ReactNode }) {
  const Connection = harness.Wrapper;
  return (
    <Connection>
      <RouterProvider>
        <SettingsProvider>{props.children}</SettingsProvider>
      </RouterProvider>
    </Connection>
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function noop() {
  return undefined;
}

describe.each([...GAP_MODES])("panes kept across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a server cancel on a live socket shows the MCP load error and ends its spinner", async () => {
    answerServers = serverCancel;
    const view = render(<ProjectMCPOverview projectPath="/projects/cancel" />, {
      wrapper: Wrapper,
    });
    await flush();

    expect(view.queryByText("cancelled by the server")).not.toBeNull();
    expect(view.container.querySelector(".animate-spin")).toBeNull();
  });

  test("a server cancel on a live socket shows the process output error instead of loading", async () => {
    answerOutput = serverCancel;
    const view = render(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p1" />,
      { wrapper: Wrapper }
    );
    await flush();

    expect(view.queryByText("cancelled by the server")).not.toBeNull();
    expect(view.queryByText("Loading…")).toBeNull();
  });
});
