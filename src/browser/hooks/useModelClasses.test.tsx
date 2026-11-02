import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";
import { installDom } from "../../../tests/ui/dom";

import { APIContext, type UseAPIResult } from "@/browser/contexts/API";

import { useModelClasses } from "./useModelClasses";

/** A config subscription that stays open without ever notifying. */
function silentSubscription(): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => new Promise<IteratorResult<unknown>>(() => undefined),
    return: () => Promise.resolve({ done: true as const, value: undefined }),
  };
}

function makeWrapper(
  updateModelClass: (args: { className: string; model: string | null }) => Promise<void>
) {
  const api = {
    config: {
      getConfig: () => Promise.resolve({ modelClasses: {} }),
      onConfigChanged: () => Promise.resolve(silentSubscription()),
      updateModelClass,
    },
  };
  const value = {
    status: "connected",
    api,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  } as unknown as UseAPIResult;
  return function Wrapper(props: { children: React.ReactNode }) {
    return <APIContext.Provider value={value}>{props.children}</APIContext.Provider>;
  };
}

describe("useModelClasses write errors", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a later successful save clears the error an earlier failed write left, and a newer failure shows again", async () => {
    // Two rows edited while the first write is pending: both clear the message
    // at dispatch, the first RPC fails and the second succeeds — Settings must
    // not keep reporting a failure for an entry whose newest write landed.
    const settlers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const updateModelClass = mock(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ resolve, reject });
        })
    );
    const { result } = renderHook(() => useModelClasses(), {
      wrapper: makeWrapper(updateModelClass),
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      result.current.setModelClass("small", "haiku+0");
      result.current.setModelClass("medium", "sonnet+0");
    });
    await waitFor(() => expect(updateModelClass).toHaveBeenCalledTimes(1));
    await act(async () => {
      settlers[0].reject(new Error("config.json is read-only"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.writeError).toBe("config.json is read-only"));

    // The serialized chain issues the second write after the first settled.
    await waitFor(() => expect(updateModelClass).toHaveBeenCalledTimes(2));
    await act(async () => {
      settlers[1].resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.writeError).toBeNull());
    await waitFor(() => expect(result.current.pendingWrites).toEqual({}));

    // A failure AFTER that success is the newest verdict and shows again.
    act(() => {
      result.current.setModelClass("large", "opus+0");
    });
    await waitFor(() => expect(updateModelClass).toHaveBeenCalledTimes(3));
    await act(async () => {
      settlers[2].reject(new Error("disk full"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.writeError).toBe("disk full"));
    await waitFor(() => expect(result.current.pendingWrites).toEqual({}));
    expect(result.current.writeError).toBe("disk full");
  });
});
