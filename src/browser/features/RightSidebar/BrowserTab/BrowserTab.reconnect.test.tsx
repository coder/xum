// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import * as RealBrowserBridgeConnectionModule from "@/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { BrowserPageTab } from "./browserBridgeTypes";

// The live bridge opens its own socket; this suite is about the API client, so stub the bridge
// (as BrowserTab.test.tsx does) and restore the real module after the suite.
restoreModulesAfterSuite([
  [
    "@/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection",
    { ...RealBrowserBridgeConnectionModule },
  ],
]);
void mock.module("@/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection", () => ({
  useBrowserBridgeConnection: () => ({
    session: null,
    connect: () => undefined,
    disconnect: () => undefined,
    sendInput: () => undefined,
    setPendingUrl: () => undefined,
  }),
}));

import { BrowserTab } from "./BrowserTab";

/*
 * A dropped connection must not empty the browser tab: the discovered session and its page-tab
 * strip stay, a listing cut off by the drop shows no error, and the next client's listing
 * replaces them.
 */

/** What the server's listings answer; a test swaps them (or holds them) before a connect. */
let answerSessions: () => Promise<unknown>;
let answerTabs: () => Promise<unknown>;

function pageTab(tabId: string, title: string, active: boolean): BrowserPageTab {
  return { tabId, label: null, title, url: `https://${tabId}.example.com/`, active, type: "page" };
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    browser: {
      listSessions: () => answerSessions(),
      listTabs: () => answerTabs(),
    },
  } as unknown as TestApiOverrides<APIClient>;
}

let harness: ConnectionHarness;

function Wrapper(props: { children: ReactNode }) {
  const Connection = harness.Wrapper;
  return <Connection>{props.children}</Connection>;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function drop() {
  await harness.drop();
  await flush();
}

async function reconnect() {
  harness.reconnect();
  await flush();
}

/** Never answers: the listing stays in flight until a drop cuts it off. */
function pending(): Promise<unknown> {
  return new Promise(() => undefined);
}

describe.each([...GAP_MODES])("BrowserTab across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness(mode, serverOverrides);
    answerSessions = () =>
      Promise.resolve({
        sessions: [{ sessionName: "alpha", status: "attachable" }],
        otherSessions: [],
      });
    answerTabs = () =>
      Promise.resolve({
        tabs: [pageTab("t1", "First tab", true), pageTab("t2", "Second tab", false)],
        error: undefined,
      });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the page-tab strip through listings the drop cut off", async () => {
    const view = render(<BrowserTab workspaceId="ws-1" projectPath="/project" />, {
      wrapper: Wrapper,
    });
    await view.findByTestId("browser-page-tab-t2");

    await drop();
    expect(view.queryByTestId("browser-page-tab-t2")).not.toBeNull();

    // The new client's listings are still in flight when a second drop cuts them off.
    answerSessions = pending;
    answerTabs = pending;
    await reconnect();
    await drop();
    expect(view.queryByTestId("browser-page-tab-t2")).not.toBeNull();
    expect(view.queryByText(/Not connected to the Xum server/)).toBeNull();

    answerSessions = () =>
      Promise.resolve({
        sessions: [{ sessionName: "alpha", status: "attachable" }],
        otherSessions: [],
      });
    answerTabs = () =>
      Promise.resolve({
        tabs: [pageTab("t1", "First tab", true), pageTab("t3", "Third tab", false)],
        error: undefined,
      });
    await reconnect();
    await view.findByTestId("browser-page-tab-t3");
    expect(view.queryByTestId("browser-page-tab-t2")).toBeNull();
  });
});
