// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import { useWindowTitle } from "./useWindowTitle";

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe.each([...GAP_MODES])("useWindowTitle across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  let harness: ConnectionHarness;
  /** The titles each server received, one list per connect. */
  let serverTitles: string[][];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    cleanupDom = installDom();
    serverTitles = [];
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    harness = createConnectionHarness(mode, () => {
      const titles: string[] = [];
      serverTitles.push(titles);
      return {
        window: {
          setTitle: (input: { title: string }) => {
            titles.push(input.title);
            return Promise.resolve();
          },
        },
      } as unknown as TestApiOverrides<APIClient>;
    });
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // Offline, a call on the kept client fails at once. Setting the title is best-effort: the
  // failure must not surface as an unhandled rejection, and the next client sets the title.
  test("a title set while offline reaches the next server, with no unhandled rejection", async () => {
    const view = renderHook(
      (props: { title: string }) => useWindowTitle(useAPI().api, props.title),
      {
        wrapper: harness.Wrapper,
        initialProps: { title: "first" },
      }
    );
    await flush();
    expect(serverTitles).toEqual([["first"]]);

    await harness.drop();
    view.rerender({ title: "second" });
    await flush();
    expect(document.title).toBe("second");

    harness.reconnect();
    await flush();
    expect(serverTitles.at(-1)).toEqual(["second"]);
    expect(unhandled).toEqual([]);
  });
});
