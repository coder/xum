import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { HEARTBEAT_DEFAULT_MESSAGE_BODY } from "@/constants/heartbeat";
import { installDom } from "../../../../../tests/ui/dom";

interface MockConfig {
  heartbeatDefaultPrompt?: string;
  heartbeatDefaultIntervalMs?: number;
}

interface MockOptions {
  getConfigError?: Error;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    updateHeartbeatDefaultPrompt: (input: { defaultPrompt?: string | null }) => Promise<void>;
    updateHeartbeatDefaultIntervalMs: (input: { intervalMs?: number | null }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;

// Inject the current client through the real provider; mocking the API module leaks across
// files. The wrapper reads mockApi on every render, so rerenders pick up swapped clients.
function ApiWrapper(props: { children: ReactNode }) {
  return <APIProvider client={mockApi as unknown as APIClient}>{props.children}</APIProvider>;
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

  return {
    api: {
      config: {
        getConfig: mock(() =>
          options.getConfigError
            ? Promise.reject(options.getConfigError)
            : Promise.resolve({ ...config })
        ),
        updateHeartbeatDefaultPrompt: updateHeartbeatDefaultPromptMock,
        updateHeartbeatDefaultIntervalMs: updateHeartbeatDefaultIntervalMsMock,
      },
    },
    updateHeartbeatDefaultPromptMock,
    updateHeartbeatDefaultIntervalMsMock,
  };
}

function renderHeartbeatSection(
  configOverrides: Partial<MockConfig> = {},
  options: MockOptions = {}
) {
  const { api, updateHeartbeatDefaultPromptMock, updateHeartbeatDefaultIntervalMsMock } =
    createMockAPI(configOverrides, options);
  mockApi = api;

  const view = render(
    <ThemeProvider forcedTheme="dark">
      <HeartbeatSection />
    </ThemeProvider>,
    { wrapper: ApiWrapper }
  );

  return { view, updateHeartbeatDefaultPromptMock, updateHeartbeatDefaultIntervalMsMock };
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
