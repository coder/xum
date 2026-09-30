import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { installDom } from "../../../tests/ui/dom";

import type { APIClient } from "@/browser/contexts/API";
import {
  createControllableAsyncIterable,
  createTestApiClient,
  createTestConfig,
  type TestClientConfig,
} from "@/browser/testUtils";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CHAT_TRANSCRIPT_FULL_WIDTH_KEY } from "@/common/constants/storage";

import { useChatTranscriptFullWidth } from "./useChatTranscriptFullWidth";

function createConfigEventStream() {
  const returnMock = mock(() => undefined);
  // config.onConfigChanged yields void events; the hook only counts them.
  const stream = createControllableAsyncIterable<void>({ onReturn: returnMock });

  return {
    emit() {
      stream.push(undefined);
    },
    iterator: stream.iterable,
    returnMock,
  };
}

function createWrapper(client: APIClient): React.FC<{ children: React.ReactNode }> {
  return function Wrapper(props) {
    window.__ORPC_CLIENT__ = client;
    return <>{props.children}</>;
  };
}

describe("useChatTranscriptFullWidth", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    updatePersistedState<boolean | undefined>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, undefined);
    cleanupDom?.();
    cleanupDom = null;
  });

  test("uses the cached preference until backend config resolves", async () => {
    updatePersistedState<boolean>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, true);
    const stream = createConfigEventStream();
    const getConfigMock = mock(() =>
      Promise.resolve<TestClientConfig>(createTestConfig({ chatTranscriptFullWidth: true }))
    );
    const onConfigChangedMock = mock(() => Promise.resolve(stream.iterator));
    const client = createTestApiClient({
      config: {
        getConfig: getConfigMock,
        onConfigChanged: onConfigChangedMock,
      },
    });

    const { result, unmount } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(true);
    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(1);
      expect(onConfigChangedMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    await waitFor(() => {
      expect(stream.returnMock).toHaveBeenCalled();
    });
  });

  test("ignores stale config fetches after a newer subscription refresh", async () => {
    const firstFetch = Promise.withResolvers<TestClientConfig>();
    const secondFetch = Promise.withResolvers<TestClientConfig>();
    const stream = createConfigEventStream();
    const getConfigMock = mock(() => {
      if (getConfigMock.mock.calls.length === 1) {
        return firstFetch.promise;
      }

      return secondFetch.promise;
    });
    const client = createTestApiClient({
      config: {
        getConfig: getConfigMock,
        onConfigChanged: mock(() => Promise.resolve(stream.iterator)),
      },
    });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(false);
    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      stream.emit();
    });
    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      secondFetch.resolve(createTestConfig({ chatTranscriptFullWidth: true }));
      await secondFetch.promise;
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    await act(async () => {
      firstFetch.resolve(createTestConfig({ chatTranscriptFullWidth: false }));
      await firstFetch.promise;
    });

    expect(result.current).toBe(true);
  });

  test("accepts a newer backend refresh after a backend-driven cache update", async () => {
    const firstFetch = Promise.withResolvers<TestClientConfig>();
    const secondFetch = Promise.withResolvers<TestClientConfig>();
    const stream = createConfigEventStream();
    const getConfigMock = mock(() => {
      if (getConfigMock.mock.calls.length === 1) {
        return firstFetch.promise;
      }

      return secondFetch.promise;
    });
    const client = createTestApiClient({
      config: {
        getConfig: getConfigMock,
        onConfigChanged: mock(() => Promise.resolve(stream.iterator)),
      },
    });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      firstFetch.resolve(createTestConfig({ chatTranscriptFullWidth: true }));
      await firstFetch.promise;
      stream.emit();
    });
    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      secondFetch.resolve(createTestConfig({ chatTranscriptFullWidth: false }));
      await secondFetch.promise;
    });

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  test("keeps a local persisted update when an older backend fetch resolves", async () => {
    const fetch = Promise.withResolvers<TestClientConfig>();
    const client = createTestApiClient({
      config: {
        getConfig: mock(() => fetch.promise),
        onConfigChanged: mock(() => Promise.resolve(createConfigEventStream().iterator)),
      },
    });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(false);

    act(() => {
      updatePersistedState<boolean>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, true);
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    await act(async () => {
      fetch.resolve(createTestConfig({ chatTranscriptFullWidth: false }));
      await fetch.promise;
    });

    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(CHAT_TRANSCRIPT_FULL_WIDTH_KEY)).toBe(JSON.stringify(true));
  });

  test("ignores invalid cached preference values", () => {
    updatePersistedState<string>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, "false");
    const getConfig = Promise.withResolvers<TestClientConfig>();
    const client = createTestApiClient({
      config: {
        getConfig: mock(() => getConfig.promise),
        onConfigChanged: mock(() => Promise.resolve(createConfigEventStream().iterator)),
      },
    });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(false);
  });

  test("responds to persisted preference updates while mounted", async () => {
    const getConfig = Promise.withResolvers<TestClientConfig>();
    const client = createTestApiClient({
      config: {
        getConfig: mock(() => getConfig.promise),
        onConfigChanged: mock(() => Promise.resolve(createConfigEventStream().iterator)),
      },
    });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(false);

    act(() => {
      updatePersistedState<boolean>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, true);
    });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  test("caches backend config for the next mount", async () => {
    const firstFetch = Promise.withResolvers<TestClientConfig>();
    const secondFetch = Promise.withResolvers<TestClientConfig>();
    const getConfigMock = mock(() => {
      if (getConfigMock.mock.calls.length === 1) {
        return firstFetch.promise;
      }

      return secondFetch.promise;
    });
    const client = createTestApiClient({
      config: {
        getConfig: getConfigMock,
        onConfigChanged: mock(() => Promise.resolve(createConfigEventStream().iterator)),
      },
    });

    const firstRender = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(firstRender.result.current).toBe(false);
    await act(async () => {
      firstFetch.resolve(createTestConfig({ chatTranscriptFullWidth: true }));
      await firstFetch.promise;
    });
    await waitFor(() => {
      expect(firstRender.result.current).toBe(true);
    });

    firstRender.unmount();

    const secondRender = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(secondRender.result.current).toBe(true);
  });

  test("preserves the last known value while API config is unavailable", () => {
    updatePersistedState<boolean>(CHAT_TRANSCRIPT_FULL_WIDTH_KEY, true);
    const client = createTestApiClient({ config: {} });

    const { result } = renderHook(() => useChatTranscriptFullWidth(), {
      wrapper: createWrapper(client),
    });

    expect(result.current).toBe(true);
  });
});
