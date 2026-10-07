import { wrapAsyncIterator } from "@orpc/shared";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  EXPERIMENT_IDS,
  type ExperimentId,
  getExperimentKey,
  LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID,
} from "@/common/constants/experiments";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { APIProvider, type APIClient } from "./API";
import {
  ExperimentsProvider,
  useExperiment,
  usePerfFlightRecorderCollecting,
} from "./ExperimentsContext";
import type { FlightRecorderStatus } from "@/common/orpc/schemas/perfFlightRecorder";
import { PerfFlightRecorder } from "@/browser/components/PerfFlightRecorder/PerfFlightRecorder";
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

describe("ExperimentsProvider", () => {
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
    // ExperimentsProvider reaches through indirectly so each case runs against the fresh
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

  test("renderer flight recording follows the backend status stream, not stale storage", async () => {
    // A CLI toggle or reload must not leave this page diverged from the backend.
    const perf = EXPERIMENT_IDS.PERF_FLIGHT_RECORDER;
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
    window.localStorage.setItem(getExperimentKey(perf), "false");
    const statuses = createAsyncMessageQueue<FlightRecorderStatus>();
    statuses.push({ enabled: true, state: "collecting" });
    const set = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        set,
        getOverrides: () => Promise.resolve({ [perf]: false }),
        onPerfFlightRecorderChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", statuses.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(statuses.iterate(), {}));
        },
      },
    };
    function Toggle() {
      const [enabled, setEnabled] = useExperiment(perf);
      const collecting = usePerfFlightRecorderCollecting();
      return (
        <button
          onClick={() => setEnabled(false)}
        >{`${String(enabled)}/${String(collecting)}`}</button>
      );
    }
    try {
      const view = render(
        <APIProvider client={createTestApiClient(currentClientMock)}>
          <ExperimentsProvider>
            <Toggle />
            <PerfFlightRecorder />
          </ExperimentsProvider>
        </APIProvider>
      );
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("true/true"));
      expect(set).not.toHaveBeenCalled();
      // Only new entries: no `buffered` import of frames recorded while the experiment was off.
      await waitFor(() => expect(connectedCount()).toBe(2));
      expect(observers.map((observer) => observer.init)).toEqual([
        { type: "long-animation-frame" },
        { type: "event", durationThreshold: FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS },
      ]);

      // A Settings toggle requests the change; the streamed status publishes it.
      fireEvent.click(view.getByRole("button"));
      expect(set).toHaveBeenCalledWith({ experimentId: perf, enabled: false });
      expect(view.getByRole("button").textContent).toBe("true/true");
      await act(async () => {
        statuses.push({ enabled: false, state: "off" });
        await Promise.resolve();
      });
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("false/false"));
      expect(connectedCount()).toBe(0);

      // A failed backend recorder stays enabled but stops renderer collection.
      await act(async () => {
        statuses.push({ enabled: true, state: "failed" });
        await Promise.resolve();
      });
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("true/false"));
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
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("true/false"));
      expect(connectedCount()).toBe(0);
    } finally {
      globalThis.PerformanceObserver = originalPerformanceObserver;
    }
  });

  test.each([false, true])(
    "compaction writes stay FIFO across rapid selections and consumer remounts (failure=%s)",
    async (failFirstWrite) => {
      const continuous = EXPERIMENT_IDS.CONTINUOUS_COMPACTION;
      const budget = EXPERIMENT_IDS.TOKEN_BUDGET;
      const backend: Partial<Record<ExperimentId, boolean>> = {};
      const pending: Array<{ finish: () => void; fail: () => void }> = [];
      const set = mock(
        ({ experimentId, enabled }: Parameters<APIClient["experiments"]["set"]>[0]) =>
          new Promise<void>((resolve, reject) => {
            if (typeof enabled !== "boolean") throw new Error("Expected an explicit override");
            pending.push({
              finish: () => {
                backend[experimentId] = enabled;
                resolve();
              },
              fail: () => reject(new Error("offline")),
            });
          })
      );
      currentClientMock = {
        experiments: { set, getOverrides: () => Promise.resolve({ ...backend }) },
      };
      function Settings() {
        const [continuousEnabled, setContinuous] = useExperiment(continuous);
        const [budgetEnabled, setBudget] = useExperiment(budget);
        const [, setUnrelated] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
        return (
          <>
            <output>{`${continuousEnabled}/${budgetEnabled}`}</output>
            <button
              onClick={() => {
                setBudget(true);
                setContinuous(false);
              }}
            >
              budget
            </button>
            <button
              onClick={() => {
                setContinuous(true);
                setBudget(false);
              }}
            >
              continuous
            </button>
            <button
              onClick={() => {
                setBudget(false);
                setContinuous(false);
              }}
            >
              summarize
            </button>
            <button onClick={() => setUnrelated(true)}>unrelated</button>
          </>
        );
      }
      const tree = (showSettings: boolean) => (
        <APIProvider client={createTestApiClient(currentClientMock)}>
          <ExperimentsProvider>{showSettings && <Settings />}</ExperimentsProvider>
        </APIProvider>
      );
      const view = render(tree(true));
      fireEvent.click(view.getByText("budget"));
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
      fireEvent.click(view.getByText("continuous"));
      view.rerender(tree(false));
      view.rerender(tree(true));
      fireEvent.click(view.getByText("summarize"));
      expect(view.getByRole("status").textContent).toBe("false/false");
      expect(set).toHaveBeenCalledTimes(1);

      // Unrelated flags retain their immediate dispatch even while compaction is blocked.
      fireEvent.click(view.getByText("unrelated"));
      expect(set).toHaveBeenCalledTimes(2);
      await act(async () => {
        pending[1].finish();
        await Promise.resolve();
      });
      for (let index = 0; index < 6; index++) {
        const pendingIndex = index === 0 ? 0 : index + 1;
        await act(async () => {
          if (index === 0 && failFirstWrite) pending[pendingIndex].fail();
          else pending[pendingIndex].finish();
          await Promise.resolve();
        });
        expect(set).toHaveBeenCalledTimes(Math.min(index + 3, 7));
      }
      expect(set.mock.calls.map(([input]) => input)).toEqual([
        { experimentId: budget, enabled: true },
        { experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES, enabled: true },
        { experimentId: continuous, enabled: false },
        { experimentId: continuous, enabled: true },
        { experimentId: budget, enabled: false },
        { experimentId: budget, enabled: false },
        { experimentId: continuous, enabled: false },
      ]);
      expect(backend).toEqual({
        [continuous]: false,
        [budget]: false,
        [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true,
      });
      expect(view.getByRole("status").textContent).toBe("false/false");
    }
  );

  test("stale local PTC keys are not written to the backend on connect or reconnect", async () => {
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      JSON.stringify(true)
    );
    globalThis.window.localStorage.setItem(
      `experiment:${LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID}`,
      JSON.stringify(true)
    );
    const set = mock(() => Promise.resolve());
    const getOverrides = mock(() => Promise.resolve({}));
    const tree = () => (
      <APIProvider client={createTestApiClient({ experiments: { set, getOverrides } })}>
        <ExperimentsProvider>
          <div />
        </ExperimentsProvider>
      </APIProvider>
    );

    const view = render(tree());
    await waitFor(() => expect(getOverrides).toHaveBeenCalledTimes(1));
    // A new client is what a reconnect hands the provider.
    view.rerender(tree());
    await waitFor(() => expect(getOverrides).toHaveBeenCalledTimes(2));
    expect(set).not.toHaveBeenCalled();
  });

  test("a failed toggle write keeps showing the backend value", async () => {
    const setMock = mock(() => Promise.reject(new Error("write failed")));
    const client = createTestApiClient({
      experiments: { set: setMock, getOverrides: mock(() => Promise.resolve({})) },
    });

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return <button onClick={() => setEnabled(!enabled)}>{String(enabled)}</button>;
    }

    const view = render(
      <APIProvider client={client}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );
    fireEvent.click(view.getByRole("button"));
    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());

    expect(view.getByRole("button").textContent).toBe("false");
  });
});
