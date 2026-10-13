// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import { getDefaultRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import {
  useDesktopAvailable,
  useLlmDebugLogsEnabled,
  useTerminalSessionSync,
} from "./RightSidebar";

/*
 * The sidebar drops its Debug and Desktop tabs when the setting (or capability) reads false.
 * A dropped connection is not such an answer: the last known value stays, so the tabs stay,
 * until the next client reads it again.
 */

/** What the server answers; a test swaps it (or holds it) before a connect. */
let answerConfig: () => Promise<unknown>;
let answerCapability: () => Promise<unknown>;
let answerSessions: () => Promise<unknown> = () => Promise.resolve([]);

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    config: { getConfig: () => answerConfig() },
    desktop: { getCapability: () => answerCapability() },
    terminal: { listSessions: () => answerSessions() },
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

/** Never answers: the read stays in flight until a drop cuts it off. */
function pending(): Promise<unknown> {
  return new Promise(() => undefined);
}

describe.each([...GAP_MODES])("sidebar tab gates across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the debug-logs setting keeps its value through a read the drop cut off", async () => {
    answerConfig = () => Promise.resolve({ llmDebugLogs: true });
    const view = renderHook(() => useLlmDebugLogsEnabled(useAPI().api), { wrapper: Wrapper });
    await flush();
    expect(view.result.current).toBe(true);

    await drop();
    expect(view.result.current).toBe(true);

    answerConfig = pending;
    await reconnect();
    await drop();
    expect(view.result.current).toBe(true);

    answerConfig = () => Promise.resolve({ llmDebugLogs: false });
    await reconnect();
    expect(view.result.current).toBe(false);
  });

  // The kept client's call fails at once while offline: that must not be an unhandled rejection.
  test("the terminal session sync handles a list the drop cut off", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      answerSessions = pending;
      const layout = getDefaultRightSidebarLayoutState();
      renderHook(() => useTerminalSessionSync(useAPI().api, "ws-1", layout, () => undefined), {
        wrapper: Wrapper,
      });
      await flush();
      await drop();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("the desktop capability keeps its value through a read the drop cut off", async () => {
    answerCapability = () => Promise.resolve({ available: true });
    const view = renderHook(() => useDesktopAvailable(useAPI().api, true, "ws-1"), {
      wrapper: Wrapper,
    });
    await flush();
    expect(view.result.current).toBe(true);

    await drop();
    expect(view.result.current).toBe(true);

    answerCapability = pending;
    await reconnect();
    await drop();
    expect(view.result.current).toBe(true);

    answerCapability = () => Promise.resolve({ available: false });
    await reconnect();
    expect(view.result.current).toBe(false);
  });
});
