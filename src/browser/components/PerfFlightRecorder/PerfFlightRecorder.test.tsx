import { wrapAsyncIterator } from "@orpc/shared";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import type { FlightRecorderStatus } from "@/common/orpc/schemas/perfFlightRecorder";
import { PerfFlightRecorder } from "./PerfFlightRecorder";
import { FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS } from "@/constants/perfFlightRecorder";

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into ProjectContext and other later context tests.
let currentClientMock: TestApiOverrides<APIClient> = {};

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalLocalStorage: typeof globalThis.localStorage;
let originalLocation: typeof globalThis.location;
let originalStorageEvent: typeof globalThis.StorageEvent;
let originalCustomEvent: typeof globalThis.CustomEvent;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

describe("PerfFlightRecorder", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;
    originalStorageEvent = globalThis.StorageEvent;
    originalCustomEvent = globalThis.CustomEvent;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;

    const dom = new GlobalWindow({ url: "https://example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;

    // Broader browser runs can leave bare globals, event constructors, and timer functions pointed
    // at stale or fake implementations from earlier suites. Rebind the globals
    // PerfFlightRecorder reaches through indirectly so each case runs against the fresh
    // happy-dom window installed for it.
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;
    globalThis.StorageEvent = dom.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = dom.CustomEvent as unknown as typeof CustomEvent;
    globalThis.setTimeout = dom.setTimeout.bind(dom) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = dom.clearTimeout.bind(
      dom
    ) as unknown as typeof globalThis.clearTimeout;
    globalThis.setInterval = dom.setInterval.bind(dom) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = dom.clearInterval.bind(
      dom
    ) as unknown as typeof globalThis.clearInterval;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
    globalThis.StorageEvent = originalStorageEvent;
    globalThis.CustomEvent = originalCustomEvent;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    currentClientMock = {};
  });

  test("renderer flight recording follows the backend status stream", async () => {
    // A CLI toggle or reload must not leave this page diverged from the backend.
    // happy-dom has no long-animation-frame support: record what the renderer observes.
    const observers: Array<{ init: unknown; connected: boolean }> = [];
    class FakePerformanceObserver {
      static readonly supportedEntryTypes = ["long-animation-frame", "event"];
      private readonly record = { init: undefined as unknown, connected: false };
      constructor() {
        observers.push(this.record);
      }
      observe(init: unknown) {
        this.record.init = init;
        this.record.connected = true;
      }
      disconnect() {
        this.record.connected = false;
      }
    }
    const originalPerformanceObserver = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    const connectedCount = () => observers.filter((observer) => observer.connected).length;
    const statuses = createAsyncMessageQueue<FlightRecorderStatus>();
    statuses.push({ enabled: true, state: "collecting" });
    currentClientMock = {
      experiments: {
        onPerfFlightRecorderChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", statuses.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(statuses.iterate(), {}));
        },
      },
    };
    try {
      render(
        <APIProvider client={createTestApiClient(currentClientMock)}>
          <PerfFlightRecorder />
        </APIProvider>
      );
      // Only new entries: no `buffered` import of frames recorded while the experiment was off.
      await waitFor(() => expect(connectedCount()).toBe(2));
      expect(observers.map((observer) => observer.init)).toEqual([
        { type: "long-animation-frame" },
        { type: "event", durationThreshold: FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS },
      ]);

      await act(async () => {
        statuses.push({ enabled: false, state: "off" });
        await Promise.resolve();
      });
      await waitFor(() => expect(connectedCount()).toBe(0));

      // A failed backend recorder stays enabled but stops renderer collection.
      await act(async () => {
        statuses.push({ enabled: true, state: "failed" });
        await Promise.resolve();
      });
      await act(() => Promise.resolve());
      expect(observers).toHaveLength(2);

      // A dropped status stream (e.g. backend restart) stops collection until it reconnects.
      await act(async () => {
        statuses.push({ enabled: true, state: "collecting" });
        await Promise.resolve();
      });
      await waitFor(() => expect(connectedCount()).toBe(2));
      await act(async () => {
        statuses.end();
        await Promise.resolve();
      });
      await waitFor(() => expect(connectedCount()).toBe(0));
    } finally {
      globalThis.PerformanceObserver = originalPerformanceObserver;
    }
  });
});
