import "../../../../../tests/ui/dom";

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { createTestApiClient, createTestConfig, type TestApiOverrides } from "@/browser/testUtils";
import { HEARTBEAT_DEFAULT_MESSAGE_BODY } from "@/constants/heartbeat";
import { installDom } from "../../../../../tests/ui/dom";

interface MockConfig {
  heartbeatDefaultPrompt?: string;
  heartbeatDefaultIntervalMs?: number;
  agentHeartbeatsEnabled?: boolean;
}

interface MockOptions {
  getConfigError?: Error;
}

let mockApi: TestApiOverrides<APIClient>;

// Inject the current client through the real provider; mocking the API module leaks across
// files. The wrapper reads mockApi on every render, so rerenders pick up swapped clients.
function ApiWrapper(props: { children: ReactNode }) {
  return (
    <APIProvider client={createTestApiClient(mockApi)}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </APIProvider>
  );
}

import { HeartbeatSection } from "./HeartbeatSection";

function createMockAPI(configOverrides: Partial<MockConfig> = {}, options: MockOptions = {}) {
  const config: MockConfig = {
    ...configOverrides,
  };

  const updateHeartbeatDefaultPromptMock = mock(
    ({ defaultPrompt }: { defaultPrompt?: string | null }) => {
      config.heartbeatDefaultPrompt = defaultPrompt?.trim() ? defaultPrompt.trim() : undefined;
      return Promise.resolve();
    }
  );
  const updateHeartbeatDefaultIntervalMsMock = mock(
    ({ intervalMs }: { intervalMs?: number | null }) => {
      config.heartbeatDefaultIntervalMs = intervalMs ?? undefined;
      return Promise.resolve();
    }
  );

  const updateAgentHeartbeatsEnabledMock = mock(({ enabled }: { enabled: boolean }) => {
    config.agentHeartbeatsEnabled = enabled;
    return Promise.resolve();
  });

  return {
    api: {
      config: {
        getConfig: mock(() =>
          options.getConfigError
            ? Promise.reject(options.getConfigError)
            : Promise.resolve(createTestConfig({ ...config }))
        ),
        updateHeartbeatDefaultPrompt: updateHeartbeatDefaultPromptMock,
        updateHeartbeatDefaultIntervalMs: updateHeartbeatDefaultIntervalMsMock,
        updateAgentHeartbeatsEnabled: updateAgentHeartbeatsEnabledMock,
      },
    } satisfies TestApiOverrides<APIClient>,
    updateHeartbeatDefaultPromptMock,
    updateHeartbeatDefaultIntervalMsMock,
    updateAgentHeartbeatsEnabledMock,
  };
}

function renderHeartbeatSection(
  configOverrides: Partial<MockConfig> = {},
  options: MockOptions = {}
) {
  const {
    api,
    updateHeartbeatDefaultPromptMock,
    updateHeartbeatDefaultIntervalMsMock,
    updateAgentHeartbeatsEnabledMock,
  } = createMockAPI(configOverrides, options);
  mockApi = api;

  const view = render(
    <ThemeProvider forcedTheme="dark">
      <HeartbeatSection />
    </ThemeProvider>,
    { wrapper: ApiWrapper }
  );

  return {
    view,
    updateHeartbeatDefaultPromptMock,
    updateHeartbeatDefaultIntervalMsMock,
    updateAgentHeartbeatsEnabledMock,
  };
}

describe("HeartbeatSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders the default heartbeat controls", async () => {
    const { view } = renderHeartbeatSection();

    const thresholdInput = (await waitFor(() =>
      view.getByLabelText("Default heartbeat threshold in minutes")
    )) as HTMLInputElement;

    expect(thresholdInput.value).toBe("30");
    const promptField = view.getByLabelText("Default heartbeat prompt") as HTMLTextAreaElement;
    expect(promptField.placeholder).toBe(HEARTBEAT_DEFAULT_MESSAGE_BODY);
  });

  test("loads and saves the agent heartbeats opt-in", async () => {
    const { view, updateAgentHeartbeatsEnabledMock } = renderHeartbeatSection({
      agentHeartbeatsEnabled: true,
    });

    const toggle = view.getByRole("switch", { name: "Let agents set up their own heartbeats" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(updateAgentHeartbeatsEnabledMock).toHaveBeenCalledWith({ enabled: false })
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("loads and saves the default heartbeat prompt", async () => {
    const initialPrompt = "Review pending work before acting.";
    const { view, updateHeartbeatDefaultPromptMock } = renderHeartbeatSection({
      heartbeatDefaultPrompt: initialPrompt,
    });

    const promptField = (await waitFor(() =>
      view.getByLabelText("Default heartbeat prompt")
    )) as HTMLTextAreaElement;

    expect(promptField.value).toBe(initialPrompt);

    fireEvent.blur(promptField);

    await waitFor(() => {
      expect(updateHeartbeatDefaultPromptMock.mock.calls[0]?.[0]).toEqual({
        defaultPrompt: initialPrompt,
      });
    });
  });

  test("skips saving a stale prompt after config reload fails until the user edits", async () => {
    const initialPrompt = "Review pending work before acting.";
    const { view } = renderHeartbeatSection({
      heartbeatDefaultPrompt: initialPrompt,
    });

    const promptField = (await waitFor(() =>
      view.getByLabelText("Default heartbeat prompt")
    )) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(promptField.value).toBe(initialPrompt);
    });

    const failedReload = createMockAPI({}, { getConfigError: new Error("load failed") });
    mockApi = failedReload.api;
    view.rerender(
      <ThemeProvider forcedTheme="dark">
        <HeartbeatSection />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(promptField.value).toBe(initialPrompt);
    });

    const failedReloadPromptField = view.getByLabelText(
      "Default heartbeat prompt"
    ) as HTMLTextAreaElement;

    fireEvent.blur(failedReloadPromptField);
    await Promise.resolve();
    await Promise.resolve();
    expect(failedReload.updateHeartbeatDefaultPromptMock).not.toHaveBeenCalled();
  });

  test("loads and saves the default heartbeat threshold", async () => {
    const initialIntervalMs = 45 * 60_000;
    const { view, updateHeartbeatDefaultIntervalMsMock } = renderHeartbeatSection({
      heartbeatDefaultIntervalMs: initialIntervalMs,
    });

    const thresholdInput = (await waitFor(() =>
      view.getByLabelText("Default heartbeat threshold in minutes")
    )) as HTMLInputElement;

    expect(thresholdInput.value).toBe("45");

    fireEvent.blur(thresholdInput);

    await waitFor(() => {
      expect(updateHeartbeatDefaultIntervalMsMock.mock.calls[0]?.[0]).toEqual({
        intervalMs: initialIntervalMs,
      });
    });
  });
});

// happy-dom does not deliver React's synthetic onChange for controlled fields, so call the
// field's React onChange prop directly (same workaround as InstructionsSection.test.tsx).
function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (textarea as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as {
    onChange?: (event: { target: { value: string } }) => void;
  } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the textarea to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

// A reconnect reloads the config through the new client. A prompt the user typed and did not
// save yet stays in the field (the reload must not overwrite it), and the field stays enabled.
describe.each([...GAP_MODES])("HeartbeatSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps a typed, unsaved prompt when the reload answers", async () => {
    mockApi = createMockAPI({ heartbeatDefaultPrompt: "Saved prompt" }).api;
    const harness = createConnectionHarness(mode, () => mockApi);
    const view = render(
      <harness.Wrapper>
        <TooltipProvider>
          <ThemeProvider forcedTheme="dark">
            <HeartbeatSection />
          </ThemeProvider>
        </TooltipProvider>
      </harness.Wrapper>
    );
    const promptField = (await waitFor(() =>
      view.getByLabelText("Default heartbeat prompt")
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(promptField.value).toBe("Saved prompt"));

    typeIntoTextarea(promptField, "Typed, not saved");
    mockApi = createMockAPI({ heartbeatDefaultPrompt: "Prompt from the server" }).api;
    await harness.drop();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(promptField.value).toBe("Typed, not saved");
    expect(promptField.disabled).toBe(false);
  });
});
