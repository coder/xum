import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { installDom } from "../../../tests/ui/dom";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import { TerminalRouterProvider, useTerminalRouter } from "./TerminalRouterContext";
import type { TerminalSessionRouter } from "./TerminalSessionRouter";

/** One entry per connect: the attach calls that connection's server saw. */
let attachesPerConnection: number[] = [];

function serverOverrides() {
  const index = attachesPerConnection.length;
  attachesPerConnection.push(0);
  return {
    terminal: {
      attach: () => {
        attachesPerConnection[index] += 1;
        return Promise.resolve(
          (async function* () {
            yield { type: "screenState" as const, data: `screen-${index}` };
            await new Promise(() => undefined); // stays open until aborted
          })()
        );
      },
      // An exit stream that never yields: the process keeps running.
      onExit: () =>
        Promise.resolve(
          (async function* () {
            await new Promise(() => undefined);
            yield 0;
          })()
        ),
      resize: () => Promise.resolve(),
    },
  };
}

let routers: Array<TerminalSessionRouter | null> = [];
let subscribes = 0;
let screens: Array<{ state: string; replace: boolean }> = [];

/** Subscribes once per router, as TerminalView does. */
function TerminalProbe() {
  const router = useTerminalRouter();
  routers.push(router);
  useEffect(() => {
    if (router == null) return;
    subscribes += 1;
    return router.subscribe("t1", {
      onOutput: () => undefined,
      onScreenState: (state, options) =>
        screens.push({ state, replace: options?.replace === true }),
      onExit: () => undefined,
    });
  }, [router]);
  return null;
}

describe.each([...GAP_MODES])("TerminalRouterProvider across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
    attachesPerConnection = [];
    routers = [];
    subscribes = 0;
    screens = [];
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the terminal keeps its router and subscription, and reattaches on the new client", async () => {
    const harness = createConnectionHarness(mode, serverOverrides);
    render(
      <TerminalRouterProvider>
        <TerminalProbe />
      </TerminalRouterProvider>,
      { wrapper: harness.Wrapper }
    );
    await waitFor(() => expect(screens).toEqual([{ state: "screen-0", replace: false }]));
    const router = routers.at(-1) ?? null;
    expect(router).not.toBeNull();

    await harness.drop();
    harness.reconnect();
    await waitFor(() => expect(attachesPerConnection).toEqual([1, 1]));
    await waitFor(() => expect(screens.at(-1)).toEqual({ state: "screen-1", replace: true }));

    // A new router (or a null one in the gap) made the view subscribe again and clear itself.
    const distinct: unknown[] = [...new Set(routers.filter((r) => r != null))];
    expect(distinct).toEqual([router]);
    expect(routers.slice(routers.indexOf(router))).not.toContain(null);
    expect(subscribes).toBe(1);
  });
});
