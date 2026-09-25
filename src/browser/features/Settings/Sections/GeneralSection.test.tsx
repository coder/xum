// Keep this first: tests/ui/dom installs a baseline DOM on import, and GeneralSection reads
// `window` (browser vs Electron mode) when its module evaluates below.
import { installDom } from "../../../../../tests/ui/dom";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider, useExperiment } from "@/browser/contexts/ExperimentsContext";
import * as RealSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import * as RealTelemetryModule from "@/browser/hooks/useTelemetry";
import { GeneralSection } from "./GeneralSection";
import {
  EXPERIMENT_IDS,
  getExperimentKey,
  type ExperimentId,
} from "@/common/constants/experiments";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import { BASH_COLLAPSED_SUMMARY_MODE_KEY, SIDEBAR_FLAT_MODE_KEY } from "@/common/constants/storage";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";

interface MockConfig {
  coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
  worktreeArchiveBehavior: WorktreeArchiveBehavior;
  chatTranscriptFullWidth: boolean;
  llmDebugLogs: boolean;
  keepScreenAwake: boolean;
}

type ExperimentOverrides = Partial<Record<ExperimentId, boolean>>;

interface MockAPIClient {
  experiments: {
    getOverrides: () => Promise<ExperimentOverrides>;
    setOverride: (input: { experimentId: ExperimentId; enabled: boolean }) => Promise<void>;
  };
  config: {
    getConfig: () => Promise<MockConfig>;
    updateCoderPrefs: (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      worktreeArchiveBehavior: WorktreeArchiveBehavior;
    }) => Promise<void>;
    updateChatTranscriptFullWidth: (input: { enabled: boolean }) => Promise<void>;
    updateLlmDebugLogs: (input: { enabled: boolean }) => Promise<void>;
    updateKeepScreenAwake: (input: { enabled: boolean }) => Promise<void>;
    onConfigChanged: (
      input: undefined,
      options?: { signal?: AbortSignal }
    ) => Promise<AsyncIterator<void>>;
  };
  server: {
    getSshHost: () => Promise<string | null>;
    setSshHost: (input: { sshHost: string | null }) => Promise<void>;
  };
  projects: {
    getDefaultProjectDir: () => Promise<string>;
    setDefaultProjectDir: (input: { path: string }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;
const experimentOverriddenMock = mock<(experimentId: string, enabled: boolean) => void>(
  () => undefined
);

const mockSelectPrimitive = (() => {
  const SelectContext = React.createContext<{
    value?: string;
    disabled?: boolean;
    open: boolean;
    options: Map<string, React.ReactNode>;
    onValueChange?: (value: string) => void;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function collectOptions(children: React.ReactNode, options = new Map<string, React.ReactNode>()) {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
        return;
      }

      if (typeof child.props.value === "string") {
        options.set(child.props.value, child.props.children);
      }

      if (child.props.children) {
        collectOptions(child.props.children, options);
      }
    });

    return options;
  }

  function Select(props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(false);
    const options = React.useMemo(() => collectOptions(props.children), [props.children]);
    return (
      <SelectContext.Provider
        value={{
          value: props.value,
          disabled: props.disabled,
          open,
          options,
          onValueChange: props.onValueChange,
          setOpen,
        }}
      >
        {props.children}
      </SelectContext.Provider>
    );
  }

  const SelectTrigger = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
  >((props, ref) => {
    const context = React.useContext(SelectContext);
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="combobox"
        disabled={context?.disabled}
        aria-expanded={context?.open ?? false}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (!context?.disabled) {
            context?.setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
    );
  });
  SelectTrigger.displayName = "MockSelectTrigger";

  function SelectValue() {
    const context = React.useContext(SelectContext);
    return <span>{context?.options.get(context?.value ?? "") ?? context?.value ?? ""}</span>;
  }

  function SelectContent(props: { children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return context?.open ? <div>{props.children}</div> : null;
  }

  function SelectItem(props: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return (
      <button
        type="button"
        onClick={() => {
          context?.onValueChange?.(props.value);
          context?.setOpen(false);
        }}
      >
        {props.children}
      </button>
    );
  }

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
})();

// Snapshot the real exports before mocking so later suites get them back after this file.
restoreModulesAfterSuite([
  ["@/browser/components/SelectPrimitive/SelectPrimitive", { ...RealSelectPrimitiveModule }],
  ["@/browser/hooks/useTelemetry", { ...RealTelemetryModule }],
]);
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => mockSelectPrimitive);
void mock.module("@/browser/hooks/useTelemetry", () => ({
  useTelemetry: () => ({ experimentOverridden: experimentOverriddenMock }),
}));

function TestProviders(props: { children: React.ReactNode }) {
  return (
    <APIProvider client={mockApi as APIClient}>
      <ExperimentsProvider>
        <ThemeProvider forcedTheme="dark">{props.children}</ThemeProvider>
      </ExperimentsProvider>
    </APIProvider>
  );
}

interface RenderGeneralSectionOptions {
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;
  chatTranscriptFullWidth?: boolean;
  keepScreenAwake?: boolean;
  localOverrides?: ExperimentOverrides;
  backendOverrides?: ExperimentOverrides;
  children?: React.ReactNode;
}

interface MockAPISetup {
  api: MockAPIClient;
  backendOverrides: ExperimentOverrides;
  setOverrideMock: ReturnType<typeof mock<MockAPIClient["experiments"]["setOverride"]>>;
  getOverridesMock: ReturnType<typeof mock<MockAPIClient["experiments"]["getOverrides"]>>;
  getConfigMock: ReturnType<typeof mock<() => Promise<MockConfig>>>;
  updateCoderPrefsMock: ReturnType<
    typeof mock<
      (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior: WorktreeArchiveBehavior;
      }) => Promise<void>
    >
  >;
  updateChatTranscriptFullWidthMock: ReturnType<
    typeof mock<(input: { enabled: boolean }) => Promise<void>>
  >;
  updateKeepScreenAwakeMock: ReturnType<
    typeof mock<(input: { enabled: boolean }) => Promise<void>>
  >;
  /** Mutable backing config, so tests can simulate edits made outside this section. */
  config: MockConfig;
  /** Notifies every live `config.onConfigChanged` subscriber, like the backend does. */
  emitConfigChanged: () => void;
}

function createMockAPI(
  configOverrides: Partial<MockConfig> = {},
  experimentOverrides: ExperimentOverrides = {}
): MockAPISetup {
  const backendOverrides = { ...experimentOverrides };
  const getOverridesMock = mock(() => Promise.resolve({ ...backendOverrides }));
  const setOverrideMock = mock(
    ({ experimentId, enabled }: { experimentId: ExperimentId; enabled: boolean }) => {
      backendOverrides[experimentId] = enabled;
      return Promise.resolve();
    }
  );
  const config: MockConfig = {
    coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    chatTranscriptFullWidth: false,
    llmDebugLogs: false,
    keepScreenAwake: false,
    ...configOverrides,
  };

  const getConfigMock = mock(() => Promise.resolve({ ...config }));
  const updateCoderPrefsMock = mock(
    (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      worktreeArchiveBehavior: WorktreeArchiveBehavior;
    }) => {
      config.coderWorkspaceArchiveBehavior = input.coderWorkspaceArchiveBehavior;
      config.worktreeArchiveBehavior = input.worktreeArchiveBehavior;

      return Promise.resolve();
    }
  );

  const updateChatTranscriptFullWidthMock = mock(({ enabled }: { enabled: boolean }) => {
    config.chatTranscriptFullWidth = enabled;

    return Promise.resolve();
  });

  const updateKeepScreenAwakeMock = mock(({ enabled }: { enabled: boolean }) => {
    config.keepScreenAwake = enabled;

    return Promise.resolve();
  });

  // Minimal stand-in for the backend's config-change event stream: each subscriber
  // counts its own pending notifications.
  const configChangeNotifiers = new Set<() => void>();
  const emitConfigChanged = () => {
    for (const notify of Array.from(configChangeNotifiers)) notify();
  };
  const onConfigChanged = (_input: undefined, options?: { signal?: AbortSignal }) => {
    let pending = 0;
    let wake: (() => void) | null = null;
    const notify = () => {
      pending += 1;
      wake?.();
    };
    configChangeNotifiers.add(notify);
    const done = () => {
      configChangeNotifiers.delete(notify);
      wake?.();
    };
    options?.signal?.addEventListener("abort", done, { once: true });
    const iterator: AsyncIterator<void> = {
      next: async () => {
        while (pending === 0 && !options?.signal?.aborted) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
        if (options?.signal?.aborted) return { done: true, value: undefined };
        pending -= 1;
        return { done: false, value: undefined };
      },
      return: () => {
        done();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return Promise.resolve(iterator);
  };

  return {
    api: {
      experiments: { getOverrides: getOverridesMock, setOverride: setOverrideMock },
      config: {
        getConfig: getConfigMock,
        updateCoderPrefs: updateCoderPrefsMock,
        updateChatTranscriptFullWidth: updateChatTranscriptFullWidthMock,
        updateLlmDebugLogs: mock(({ enabled }: { enabled: boolean }) => {
          config.llmDebugLogs = enabled;

          return Promise.resolve();
        }),
        updateKeepScreenAwake: updateKeepScreenAwakeMock,
        onConfigChanged,
      },
      server: {
        getSshHost: mock(() => Promise.resolve(null)),
        setSshHost: mock((_input: { sshHost: string | null }) => Promise.resolve()),
      },
      projects: {
        getDefaultProjectDir: mock(() => Promise.resolve("")),
        setDefaultProjectDir: mock((_input: { path: string }) => Promise.resolve()),
      },
    },
    backendOverrides,
    setOverrideMock,
    getOverridesMock,
    getConfigMock,
    updateCoderPrefsMock,
    updateChatTranscriptFullWidthMock,
    updateKeepScreenAwakeMock,
    config,
    emitConfigChanged,
  };
}

describe("GeneralSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    experimentOverriddenMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderGeneralSection(options: RenderGeneralSectionOptions = {}) {
    for (const [id, enabled] of Object.entries(options.localOverrides ?? {})) {
      window.localStorage.setItem(getExperimentKey(id as ExperimentId), JSON.stringify(enabled));
    }
    const setup = createMockAPI(
      {
        chatTranscriptFullWidth: options.chatTranscriptFullWidth,
        keepScreenAwake: options.keepScreenAwake,
        coderWorkspaceArchiveBehavior: options.coderWorkspaceArchiveBehavior,
        worktreeArchiveBehavior: options.worktreeArchiveBehavior,
      },
      options.backendOverrides
    );
    mockApi = setup.api;

    const view = render(
      <TestProviders>
        <GeneralSection />
        {options.children}
      </TestProviders>
    );

    return { ...setup, view };
  }

  function getSelectTrigger(view: ReturnType<typeof render>, label: string): HTMLElement {
    const labelElement = view.getByText(label);
    let container: HTMLElement | null = labelElement.parentElement;

    while (container && !container.querySelector('[role="combobox"]')) {
      container = container.parentElement;
    }

    const trigger = container?.querySelector('[role="combobox"]');
    if (!(trigger instanceof window.HTMLElement)) {
      throw new Error(`Could not find select trigger for ${label}`);
    }
    return trigger;
  }

  async function chooseSelectOption(
    view: ReturnType<typeof render>,
    label: string,
    optionText: string
  ): Promise<void> {
    const trigger = getSelectTrigger(view, label);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const portalRoot = view.baseElement.ownerDocument.body;
    const option = await waitFor(() => {
      const button = within(portalRoot)
        .getAllByText(optionText)
        .find(
          (element): element is HTMLButtonElement => element instanceof window.HTMLButtonElement
        );
      if (!button) {
        throw new Error(`Could not find select option ${optionText}`);
      }
      return button;
    });
    fireEvent.click(option);
    await waitFor(() => {
      expect(trigger.textContent).toContain(optionText);
    });
  }

  const legacyStrategies = [
    { continuous: false, budget: false, label: "Summarize" },
    { continuous: true, budget: false, label: "Continuous" },
    { continuous: false, budget: true, label: "Token Budget" },
    { continuous: true, budget: true, label: "Continuous" },
  ];

  async function hydrateExperiments(setup: MockAPISetup) {
    await act(async () => {
      await waitFor(() => expect(setup.getOverridesMock).toHaveBeenCalledTimes(1));
    });
  }

  for (const source of ["localOverrides", "backendOverrides"] as const) {
    test.each(legacyStrategies)(
      `displays ${source} continuous=$continuous budget=$budget without normalizing on mount`,
      async ({ continuous, budget, label }) => {
        const overrides = {
          [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: continuous,
          [EXPERIMENT_IDS.TOKEN_BUDGET]: budget,
        };
        const setup = renderGeneralSection({ [source]: overrides });
        await hydrateExperiments(setup);
        expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
          label
        );
        expect(setup.backendOverrides).toEqual(overrides);
        expect(experimentOverriddenMock).not.toHaveBeenCalled();
        // The provider uploads explicit local values; mounting the dropdown must add no writes.
        if (source === "localOverrides") {
          for (const [experimentId, enabled] of Object.entries(overrides)) {
            expect(setup.setOverrideMock).toHaveBeenCalledWith({ experimentId, enabled });
          }
        }
        expect(setup.setOverrideMock).toHaveBeenCalledTimes(source === "localOverrides" ? 2 : 0);
        for (const [id, enabled] of Object.entries(overrides)) {
          expect(window.localStorage.getItem(getExperimentKey(id as ExperimentId))).toBe(
            source === "localOverrides" ? JSON.stringify(enabled) : null
          );
        }
      }
    );
  }

  test("defaults to Summarize without persisting an implicit choice", async () => {
    const setup = renderGeneralSection();
    await hydrateExperiments(setup);
    expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
      "Summarize"
    );
    expect(setup.setOverrideMock).not.toHaveBeenCalled();
    expect(setup.backendOverrides).toEqual({});
    expect(
      window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION))
    ).toBeNull();
    expect(window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET))).toBeNull();
  });

  test.each([
    {
      local: { [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: false },
      backend: {
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: true,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: true,
      },
      label: "Token Budget",
    },
    {
      local: { [EXPERIMENT_IDS.TOKEN_BUDGET]: false },
      backend: { [EXPERIMENT_IDS.TOKEN_BUDGET]: true },
      label: "Summarize",
    },
    {
      local: { [EXPERIMENT_IDS.TOKEN_BUDGET]: true },
      backend: { [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: true },
      label: "Continuous",
    },
  ])(
    "resolves local overrides before backend values and defaults ($label)",
    async ({ local, backend, label }) => {
      const setup = renderGeneralSection({ localOverrides: local, backendOverrides: backend });
      await hydrateExperiments(setup);
      expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
        label
      );
      expect(setup.backendOverrides).toEqual({ ...backend, ...local });
      expect(setup.setOverrideMock).toHaveBeenCalledTimes(Object.keys(local).length);
    }
  );

  for (const initial of legacyStrategies) {
    test.each(legacyStrategies.slice(0, 3).filter((next) => next.label !== initial.label))(
      `selecting $label from continuous=${initial.continuous} budget=${initial.budget} persists both flags only`,
      async ({ continuous, budget, label }) => {
        const unrelated = {
          [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
          [EXPERIMENT_IDS.RLM]: true,
          [EXPERIMENT_IDS.MEMORY]: true,
        };
        const setup = renderGeneralSection({
          backendOverrides: {
            ...unrelated,
            [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: initial.continuous,
            [EXPERIMENT_IDS.TOKEN_BUDGET]: initial.budget,
          },
        });
        await hydrateExperiments(setup);
        await chooseSelectOption(setup.view, "Compaction strategy", label);
        await waitFor(() =>
          expect(setup.backendOverrides).toEqual({
            ...unrelated,
            [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: continuous,
            [EXPERIMENT_IDS.TOKEN_BUDGET]: budget,
          })
        );
        expect(setup.setOverrideMock).toHaveBeenCalledTimes(2);
        expect(experimentOverriddenMock).toHaveBeenCalledTimes(2);
        expect(experimentOverriddenMock).toHaveBeenCalledWith(
          EXPERIMENT_IDS.CONTINUOUS_COMPACTION,
          continuous
        );
        expect(experimentOverriddenMock).toHaveBeenCalledWith(EXPERIMENT_IDS.TOKEN_BUDGET, budget);
        expect(
          window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION))
        ).toBe(JSON.stringify(continuous));
        expect(window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET))).toBe(
          JSON.stringify(budget)
        );
        expect(Boolean(setup.view.queryByRole("status"))).toBe(label === "Token Budget");
      }
    );
  }

  test("keeps Token Budget selectable and tracks live PTC/RLM conflicts without changing the strategy", async () => {
    function ConflictToggles() {
      const [ptc, setPtc] = useExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      const [rlm, setRlm] = useExperiment(EXPERIMENT_IDS.RLM);
      return (
        <>
          <button onClick={() => setPtc(!ptc)}>Toggle PTC fixture</button>
          <button onClick={() => setRlm(!rlm)}>Toggle RLM fixture</button>
        </>
      );
    }
    const setup = renderGeneralSection({ children: <ConflictToggles /> });
    await hydrateExperiments(setup);
    await chooseSelectOption(setup.view, "Compaction strategy", "Token Budget");
    const trigger = setup.view.getByRole("combobox", { name: "Compaction strategy" });
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle PTC fixture" }));
    const warning = setup.view.getByRole("status");
    expect(trigger.getAttribute("aria-describedby")).toBe(warning.id);
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.getByRole("status")).toBeTruthy();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle PTC fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    expect(trigger.textContent).toBe("Token Budget");
    await waitFor(() =>
      expect(setup.backendOverrides).toEqual({
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: false,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: true,
        [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: false,
        [EXPERIMENT_IDS.RLM]: true,
      })
    );
  });

  test("persists flat chat list mode from the Sidebar group", () => {
    const { view } = renderGeneralSection();
    const sidebarHeading = view.getByRole("heading", { name: "Sidebar" });
    const sidebarGroup = sidebarHeading.parentElement;
    expect(sidebarGroup).not.toBeNull();
    const toggle = within(sidebarGroup!).getByLabelText("Toggle flat chat list");

    fireEvent.click(toggle);

    expect(window.localStorage.getItem(SIDEBAR_FLAT_MODE_KEY)).toBe("true");
  });

  test("persists the collapsed bash summaries display mode", async () => {
    const { view } = renderGeneralSection();

    await waitFor(() => {
      expect(getSelectTrigger(view, "Collapsed bash summaries").textContent).toContain(
        "Intent and command"
      );
    });

    await chooseSelectOption(view, "Collapsed bash summaries", "Intent");

    expect(window.localStorage.getItem(BASH_COLLAPSED_SUMMARY_MODE_KEY)).toBe(
      JSON.stringify("intent")
    );
  });

  test("loads the SSH host setting in browser mode", async () => {
    // GeneralSection decides browser mode (no window.api) when its module evaluates, so this
    // only passes if the DOM bootstrap import above ran before GeneralSection was loaded.
    const { api, view } = renderGeneralSection();

    await waitFor(() => {
      expect(view.getByText("SSH Host")).toBeTruthy();
    });
    expect(api.server.getSshHost).toHaveBeenCalled();
  });

  test("loads and persists the full-width chat transcript toggle", async () => {
    const { updateChatTranscriptFullWidthMock, view } = renderGeneralSection({
      chatTranscriptFullWidth: true,
    });

    const toggle = view.getByRole("switch", { name: "Toggle full-width chat transcript" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(updateChatTranscriptFullWidthMock).toHaveBeenCalledWith({ enabled: false });
    });
  });

  test("loads and persists the keep screen awake toggle", async () => {
    const { updateKeepScreenAwakeMock, view } = renderGeneralSection({
      keepScreenAwake: true,
    });

    const toggle = view.getByRole("switch", {
      name: "Toggle keep screen awake while agents are working",
    });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(updateKeepScreenAwakeMock).toHaveBeenCalledWith({ enabled: false });
    });
  });

  test.each([true, false])("reverts a rejected keep-awake save from %s", async (saved) => {
    const { updateKeepScreenAwakeMock, view } = renderGeneralSection({ keepScreenAwake: saved });
    const toggle = view.getByRole("switch", {
      name: "Toggle keep screen awake while agents are working",
    });
    await act(() => Promise.resolve());
    expect(toggle.getAttribute("aria-checked")).toBe(String(saved));
    updateKeepScreenAwakeMock.mockRejectedValueOnce(new Error("config write failed"));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe(String(!saved));
    await waitFor(() => {
      expect(updateKeepScreenAwakeMock).toHaveBeenCalledWith({ enabled: !saved });
      expect(toggle.getAttribute("aria-checked")).toBe(String(saved));
    });
  });

  test.each([true, false])(
    "rolls rapid keep-awake toggles back to the confirmed value (first save succeeds: %s)",
    async (firstSucceeds) => {
      const { updateKeepScreenAwakeMock, view } = renderGeneralSection({ keepScreenAwake: true });
      const toggle = view.getByRole("switch", {
        name: "Toggle keep screen awake while agents are working",
      });
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
      const writes: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
      updateKeepScreenAwakeMock.mockImplementation(
        () => new Promise<void>((resolve, reject) => writes.push({ resolve, reject }))
      );

      fireEvent.click(toggle);
      await waitFor(() => expect(writes).toHaveLength(1));
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(writes).toHaveLength(1);

      act(() => {
        if (firstSucceeds) writes[0].resolve();
        else writes[0].reject(new Error("first save failed"));
      });
      await waitFor(() => expect(writes).toHaveLength(2));
      // A stale failure must not replace the newer selection, even before its write starts.
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      act(() => writes[1].reject(new Error("second save failed")));
      await waitFor(() => expect(writes).toHaveLength(3));
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      act(() => writes[2].reject(new Error("last save failed")));
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe(String(!firstSucceeds)));
    }
  );

  test("follows keep-awake changes made outside the mounted section", async () => {
    // e.g. the "Toggle Keep Screen Awake" palette command runs while Settings is open.
    const { config, emitConfigChanged, view } = renderGeneralSection({ keepScreenAwake: false });
    const toggle = view.getByRole("switch", {
      name: "Toggle keep screen awake while agents are working",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    config.keepScreenAwake = true;
    act(() => emitConfigChanged());
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    config.keepScreenAwake = false;
    act(() => emitConfigChanged());
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  test("an external config change does not override an in-flight keep-awake save", async () => {
    const { config, emitConfigChanged, updateKeepScreenAwakeMock, view } = renderGeneralSection({
      keepScreenAwake: false,
    });
    const toggle = view.getByRole("switch", {
      name: "Toggle keep screen awake while agents are working",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    let finishWrite: (() => void) | null = null;
    updateKeepScreenAwakeMock.mockImplementation(({ enabled }) => {
      return new Promise<void>((resolve) => {
        finishWrite = () => {
          config.keepScreenAwake = enabled;
          resolve();
        };
      });
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(finishWrite).not.toBeNull());
    // An unrelated config edit lands while our write is still pending (disk still says false).
    act(() => emitConfigChanged());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    act(() => finishWrite?.());
    act(() => emitConfigChanged());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("replays an external keep-awake change that landed during a local save", async () => {
    const { config, emitConfigChanged, updateKeepScreenAwakeMock, view } = renderGeneralSection({
      keepScreenAwake: false,
    });
    const toggle = view.getByRole("switch", {
      name: "Toggle keep screen awake while agents are working",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    let resolveWrite: (() => void) | null = null;
    updateKeepScreenAwakeMock.mockImplementation(({ enabled }) => {
      // The backend applies our write right away, but its response is still in flight.
      config.keepScreenAwake = enabled;
      return new Promise<void>((resolve) => (resolveWrite = resolve));
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(resolveWrite).not.toBeNull());
    // The palette command then turns it back off before our response arrives.
    config.keepScreenAwake = false;
    act(() => emitConfigChanged());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    act(() => resolveWrite?.());
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  test("renders the worktree archive behavior copy and loads the saved value", async () => {
    const { view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: "delete",
    });

    expect(view.getByText("Worktree archive behavior")).toBeTruthy();
    expect(view.getByText(/snapshotted so they can be restored on unarchive/i)).toBeTruthy();

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Delete checkout"
      );
    });
  });

  test("persists the selected worktree archive behavior with the current coder behavior", async () => {
    const { updateCoderPrefsMock, view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Keep checkout"
      );
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Snapshot and delete");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: "delete",
        worktreeArchiveBehavior: "snapshot",
      });
    });
  });

  test("serializes rapid worktree archive behavior writes so only the latest value is persisted", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI();
    let resolveFirstUpdate: (() => void) | undefined;
    let resolveSecondUpdate: (() => void) | undefined;

    api.config.updateCoderPrefs = updateCoderPrefsMock.mockImplementation(
      ({
        coderWorkspaceArchiveBehavior: _coderWorkspaceArchiveBehavior,
        worktreeArchiveBehavior: _worktreeArchiveBehavior,
      }: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior: WorktreeArchiveBehavior;
      }) =>
        new Promise<void>((resolve) => {
          if (!resolveFirstUpdate) {
            resolveFirstUpdate = resolve;
            return;
          }

          resolveSecondUpdate = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Keep checkout"
      );
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Delete checkout");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(1, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "delete",
      });
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Snapshot and delete");
    expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);

    resolveFirstUpdate?.();

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(2);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(2, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "snapshot",
      });
    });

    resolveSecondUpdate?.();
  });

  test("re-enables archive settings with defaults after config load errors", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI({
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });
    let rejectGetConfig: ((error?: unknown) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((_resolve, reject) => {
          rejectGetConfig = reject;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(rejectGetConfig).toBeDefined();
    });

    const trigger = getSelectTrigger(view, "Worktree archive behavior");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    rejectGetConfig?.(new Error("config read failed"));

    await waitFor(() => {
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Delete checkout");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "delete",
      });
    });
  });

  test("disables archive settings until config finishes loading", async () => {
    const { api, getConfigMock, updateCoderPrefsMock } = createMockAPI({
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });
    const loadedConfig = await getConfigMock();
    let resolveGetConfig: ((value: MockConfig) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((resolve) => {
          resolveGetConfig = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(resolveGetConfig).toBeDefined();
    });

    const trigger = getSelectTrigger(view, "Worktree archive behavior");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    fireEvent.mouseDown(trigger);
    expect(updateCoderPrefsMock).not.toHaveBeenCalled();

    resolveGetConfig?.({
      ...loadedConfig,
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });

    await waitFor(() => {
      expect(updateCoderPrefsMock).not.toHaveBeenCalled();
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });
  });
});
