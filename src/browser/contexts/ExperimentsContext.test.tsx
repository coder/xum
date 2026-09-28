import { wrapAsyncIterator } from "@orpc/shared";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  EXPERIMENT_IDS,
  EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY,
  type ExperimentId,
  getExperimentKey,
  getLegacyPtcExclusiveExperimentKey,
} from "@/common/constants/experiments";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { APIProvider, type APIClient } from "./API";
import { ExperimentsProvider, useExperiment, useExperimentValue } from "./ExperimentsContext";

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into ProjectContext and other later context tests.
let currentClientMock: TestApiOverrides<APIClient> = {};

type ExperimentOverrides = Partial<Record<ExperimentId, boolean>>;

/** A backend double that keeps what it is sent, as the real one does. */
function createBackend(initial: ExperimentOverrides = {}) {
  const overrides: ExperimentOverrides = { ...initial };
  return {
    overrides,
    setOverride: mock(
      ({ experimentId, enabled }: Parameters<APIClient["experiments"]["setOverride"]>[0]) => {
        if (enabled == null) delete overrides[experimentId];
        else overrides[experimentId] = enabled;
        return Promise.resolve();
      }
    ),
    getOverrides: mock(() => Promise.resolve({ ...overrides })),
  };
}

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

  test.each([true, false])(
    "Design disable waits for backend acknowledgement (success=%s)",
    async (success) => {
      let backendEnabled = true;
      const updates = createAsyncMessageQueue<{ enabled: boolean; revision: number }>();
      updates.push({ enabled: true, revision: 0 });
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((resolve, fail) => {
        finish = () => {
          backendEnabled = false;
          updates.push({ enabled: false, revision: 1 });
          resolve();
        };
        reject = fail;
      });
      const setOverride = mock(() => pending);
      currentClientMock = {
        experiments: {
          onDesignChange: (_input, { signal } = {}) => {
            signal?.addEventListener("abort", updates.end, { once: true });
            return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
          },
          getOverrides: () =>
            Promise.resolve({ [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: backendEnabled }),
          setOverride,
        },
      };
      function Toggle() {
        const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP);
        return <button onClick={() => setEnabled(false)}>{String(enabled)}</button>;
      }
      const view = render(
        <APIProvider client={createTestApiClient(currentClientMock)}>
          <ExperimentsProvider>
            <Toggle />
          </ExperimentsProvider>
        </APIProvider>
      );
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
      fireEvent.click(view.getByRole("button"));
      expect(setOverride).toHaveBeenCalledTimes(1);
      expect(view.getByRole("button").textContent).toBe("true");
      expect(
        window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP))
      ).toBeNull();
      await act(async () => {
        if (success) finish();
        else reject(new Error("offline"));
        await pending.catch(() => undefined);
      });
      expect(view.getByRole("button").textContent).toBe(String(!success));
    }
  );

  test("ordered Design updates win over delayed reads, toggle acknowledgements, and old revisions", async () => {
    const updates = createAsyncMessageQueue<{ enabled: boolean; revision: number }>();
    updates.push({ enabled: true, revision: 1 });
    let acknowledge!: () => void;
    const setOverride = mock(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    let finishRead!: () => void;
    const getOverrides = mock(
      () =>
        new Promise<{ "claude-design-mcp": boolean }>((resolve) => {
          finishRead = () => resolve({ "claude-design-mcp": false });
        })
    );
    currentClientMock = {
      experiments: {
        setOverride,
        getOverrides,
        onDesignChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", updates.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
        },
      },
    };
    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP);
      return <button onClick={() => setEnabled(false)}>{String(enabled)}</button>;
    }
    const view = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
    fireEvent.click(view.getByRole("button"));
    await act(async () => {
      updates.push({ enabled: false, revision: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("false"));
    await act(async () => {
      updates.push({ enabled: true, revision: 3 });
      updates.push({ enabled: false, revision: 2 });
      finishRead();
      acknowledge();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
    expect(getOverrides).toHaveBeenCalledTimes(1);
  });

  test("stale local Design enablement is neither uploaded nor displayed on reconnect", async () => {
    window.localStorage.setItem(getExperimentKey(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP), "true");
    const setOverride = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride,
        getOverrides: () => Promise.resolve({ [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: false }),
      },
    };
    function Observer() {
      return <div>{String(useExperimentValue(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP))}</div>;
    }
    const view = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );
    await waitFor(() => expect(view.getByText("false")).toBeDefined());
    expect(setOverride).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "compaction writes stay FIFO across rapid selections and consumer remounts (failure=%s)",
    async (failFirstWrite) => {
      const continuous = EXPERIMENT_IDS.CONTINUOUS_COMPACTION;
      const budget = EXPERIMENT_IDS.TOKEN_BUDGET;
      const backend: Partial<Record<ExperimentId, boolean>> = {};
      const pending: Array<{ finish: () => void; fail: () => void }> = [];
      const setOverride = mock(
        ({ experimentId, enabled }: Parameters<APIClient["experiments"]["setOverride"]>[0]) =>
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
        experiments: { setOverride, getOverrides: () => Promise.resolve({ ...backend }) },
      };
      // Start a reconnect upload before any selection; it must not overtake later choices.
      window.localStorage.setItem(getExperimentKey(continuous), "true");
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
      await waitFor(() => expect(setOverride).toHaveBeenCalledTimes(1));
      fireEvent.click(view.getByText("budget"));
      fireEvent.click(view.getByText("continuous"));
      view.rerender(tree(false));
      view.rerender(tree(true));
      fireEvent.click(view.getByText("summarize"));
      expect(view.getByRole("status").textContent).toBe("false/false");
      expect(setOverride).toHaveBeenCalledTimes(1);

      // Unrelated flags retain their immediate dispatch even while compaction is blocked.
      fireEvent.click(view.getByText("unrelated"));
      expect(setOverride).toHaveBeenCalledTimes(2);
      await act(async () => {
        pending[1].finish();
        await Promise.resolve();
      });
      for (let index = 0; index < 7; index++) {
        const pendingIndex = index === 0 ? 0 : index + 1;
        await act(async () => {
          if (index === 0 && failFirstWrite) pending[pendingIndex].fail();
          else pending[pendingIndex].finish();
          await Promise.resolve();
        });
        expect(setOverride).toHaveBeenCalledTimes(Math.min(index + 3, 8));
      }
      expect(setOverride.mock.calls.map(([input]) => input)).toEqual([
        { experimentId: continuous, enabled: true },
        { experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES, enabled: true },
        { experimentId: budget, enabled: true },
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

  test("syncs existing local overrides to the backend on connect", async () => {
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES),
      JSON.stringify(true)
    );

    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <div />
        </ExperimentsProvider>
      </APIProvider>
    );

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
    });
  });

  test("adopts a backend override when this client has no local state, and clears nothing", async () => {
    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() =>
          Promise.resolve({ [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true })
        ),
      },
    };

    function Observer() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return <div data-testid="enabled">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );

    await waitFor(() => {
      expect(getByTestId("enabled").textContent).toBe("true");
    });

    expect(setOverrideMock).not.toHaveBeenCalled();
  });

  test("returns false for a platform-restricted experiment on unsupported platforms", () => {
    const windowApi: WindowApi = { platform: "darwin", versions: {} };
    globalThis.window.api = windowApi;
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP),
      JSON.stringify(true)
    );

    function Observer() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP);
      return <div data-testid="enabled">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("enabled").textContent).toBe("false");
  });

  test("persists backend overrides when a user toggles an experiment", async () => {
    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return (
        <button data-testid="toggle" onClick={() => setEnabled(!enabled)}>
          {String(enabled)}
        </button>
      );
    }

    const { getByTestId } = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );

    fireEvent.click(getByTestId("toggle"));

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
      expect(getByTestId("toggle").textContent).toBe("true");
    });
  });

  test("initialization stamps the legacy mirror over a stale explicit false", async () => {
    // An old renderer can leave ptc:true beside a stale legacy exclusive
    // `false`; upgrading without touching the toggle previously never rewrote
    // the mirror, and a downgraded renderer treats the stale explicit key as
    // an override that wins over the backend flag — resuming the removed
    // supplement posture (r33). Initialization reconciles it.
    const backend = createBackend();
    currentClientMock = {
      experiments: { setOverride: backend.setOverride, getOverrides: backend.getOverrides },
    };

    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      JSON.stringify(true)
    );
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(false)
    );

    function Probe() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      return <div data-testid="probe">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Probe />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("probe").textContent).toBe("true");
    await waitFor(() => {
      expect(globalThis.window.localStorage.getItem(getLegacyPtcExclusiveExperimentKey())).toBe(
        "true"
      );
    });
  });

  test("stale legacy exclusive true reads as PTC on, and toggling PTC rewrites the legacy key", async () => {
    const backend = createBackend();
    currentClientMock = {
      experiments: { setOverride: backend.setOverride, getOverrides: backend.getOverrides },
    };

    // Pre-merge state: "PTC Exclusive Mode" enabled — exactly the posture
    // merged PTC activates, so the upgrade must keep PTC on.
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(true)
    );

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      return (
        <button data-testid="toggle" onClick={() => setEnabled(!enabled)}>
          {String(enabled)}
        </button>
      );
    }

    const { getByTestId } = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("toggle").textContent).toBe("true");

    // Toggling PTC off must rewrite the legacy key too: a downgraded renderer
    // treats it as an explicit override that wins over the mirrored backend
    // value, so a stale entry would resurrect the pre-merge posture.
    fireEvent.click(getByTestId("toggle"));
    await waitFor(() => {
      expect(getByTestId("toggle").textContent).toBe("false");
    });
    expect(globalThis.window.localStorage.getItem(getLegacyPtcExclusiveExperimentKey())).toBe(
      "false"
    );
    expect(
      globalThis.window.localStorage.getItem(
        getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)
      )
    ).toBe("false");
  });
  test("uploads pre-backend local overrides once, then lets the backend win on reconnect", async () => {
    window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES),
      JSON.stringify(true)
    );
    const backend = createBackend();
    const client = () =>
      createTestApiClient({
        experiments: { setOverride: backend.setOverride, getOverrides: backend.getOverrides },
      });
    function Observer() {
      return <div>{String(useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES))}</div>;
    }
    const tree = (api: APIClient) => (
      <APIProvider client={api}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );
    const view = render(tree(client()));
    await waitFor(() => expect(backend.getOverrides).toHaveBeenCalledTimes(1));
    expect(backend.overrides).toEqual({ [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true });
    expect(window.localStorage.getItem(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY)).toBe("true");

    // Another window (or a restore) clears the override while this one keeps its mirror.
    delete backend.overrides[EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES];
    view.rerender(tree(client()));
    await waitFor(() => expect(view.getByText("false")).toBeDefined());
    expect(backend.setOverride).toHaveBeenCalledTimes(1);
    expect(
      window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES))
    ).toBeNull();
  });

  test("a renderer with stale mirrors adopts the backend's overrides on connect", async () => {
    window.localStorage.setItem(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY, "true");
    window.localStorage.setItem(getExperimentKey(EXPERIMENT_IDS.TIMELINE), JSON.stringify(false));
    window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.ADVISOR_TOOL),
      JSON.stringify(true)
    );
    const backend = createBackend({ [EXPERIMENT_IDS.TIMELINE]: true });
    currentClientMock = {
      experiments: { setOverride: backend.setOverride, getOverrides: backend.getOverrides },
    };
    function Observer() {
      const timeline = useExperimentValue(EXPERIMENT_IDS.TIMELINE);
      const advisor = useExperimentValue(EXPERIMENT_IDS.ADVISOR_TOOL);
      return <output>{`${timeline}/${advisor}`}</output>;
    }
    const view = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("true/false"));
    expect(backend.setOverride).not.toHaveBeenCalled();
    expect(backend.overrides).toEqual({ [EXPERIMENT_IDS.TIMELINE]: true });
  });

  test("retries a failed toggle on reconnect instead of adopting the stale backend value", async () => {
    window.localStorage.setItem(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY, "true");
    const backend = createBackend();
    const offline = createTestApiClient({
      experiments: {
        setOverride: mock(() => Promise.reject(new Error("offline"))),
        getOverrides: backend.getOverrides,
      },
    });
    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return <button onClick={() => setEnabled(true)}>{String(enabled)}</button>;
    }
    const tree = (api: APIClient) => (
      <APIProvider client={api}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );
    const view = render(tree(offline));
    await waitFor(() => expect(backend.getOverrides).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
      await Promise.resolve();
    });

    // The reconnect reads a backend that never saw the toggle; the choice is retried first.
    view.rerender(
      tree(
        createTestApiClient({
          experiments: { setOverride: backend.setOverride, getOverrides: backend.getOverrides },
        })
      )
    );
    await waitFor(() => expect(backend.getOverrides).toHaveBeenCalledTimes(2));
    expect(backend.setOverride).toHaveBeenCalledWith({
      experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      enabled: true,
    });
    expect(backend.overrides).toEqual({ [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true });
    expect(view.getByRole("button").textContent).toBe("true");
  });

  test("follows backend override changes live through the stream", async () => {
    window.localStorage.setItem(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY, "true");
    const updates = createAsyncMessageQueue<ExperimentOverrides>();
    updates.push({});
    const getOverrides = mock(() => Promise.resolve({}));
    currentClientMock = {
      experiments: {
        setOverride: mock(() => Promise.resolve()),
        getOverrides,
        onOverridesChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", updates.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
        },
      },
    };
    function Observer() {
      return <div>{String(useExperimentValue(EXPERIMENT_IDS.ADVISOR_TOOL))}</div>;
    }
    const view = render(
      <APIProvider client={createTestApiClient(currentClientMock)}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );
    const mirror = () => window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.ADVISOR_TOOL));
    await waitFor(() => expect(view.getByText("false")).toBeDefined());

    act(() => updates.push({ [EXPERIMENT_IDS.ADVISOR_TOOL]: true }));
    await waitFor(() => expect(view.getByText("true")).toBeDefined());
    // Mirrored, so send options carry the backend's value too.
    expect(mirror()).toBe("true");

    act(() => updates.push({}));
    await waitFor(() => expect(view.getByText("false")).toBeDefined());
    expect(mirror()).toBeNull();
    expect(getOverrides).not.toHaveBeenCalled();
  });
});
