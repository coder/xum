import "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement, ReactNode } from "react";

import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

// ToolIcon renders a Radix Tooltip, which requires a TooltipProvider in the
// React tree. Wrap each render so the icon can mount without throwing. The API client is
// injected through the wrapper, which view.rerender() keeps.
function renderWithProviders(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>, { wrapper: ApiWrapper });
}

let currentWorkspaceState: {
  autoRetryStatus: { type: "auto-retry-scheduled" | "auto-retry-starting" } | null;
  isStreamStarting: boolean;
  canInterrupt: boolean;
  messages: Array<{ type: string; compactionRequest?: { parsed: unknown } }>;
} = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages: [],
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

const answerAskUserQuestion = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);

const resumeStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: { started: true } })
);

const setAutoRetryEnabled = mock((input: unknown) => {
  const enabled =
    typeof input === "object" && input !== null && "enabled" in input
      ? (input as { enabled?: boolean }).enabled === true
      : false;

  return Promise.resolve({
    success: true as const,
    data: {
      // First call (enable=true) should look like user had retry disabled.
      previousEnabled: enabled ? false : true,
      enabled,
    },
  });
});

// Inject the client through the real provider: a module mock of contexts/API is process-wide
// and leaks this partial client into later-evaluated suites.
const apiClient = {
  workspace: {
    answerAskUserQuestion,
    resumeStream,
    setAutoRetryEnabled,
  },
} as unknown as APIClient;

function ApiWrapper(props: { children: ReactNode }) {
  return <APIProvider client={apiClient}>{props.children}</APIProvider>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceStore =
  require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// The overlay also changes the store identity, so it must stay local to this suite.
restoreModulesAfterSuite([["@/browser/stores/WorkspaceStore", { ...actualWorkspaceStore }]]);

// Overlay (not replace) the raw store so modules imported while this stub is active
// retain methods such as setNavigateToWorkspace that their cleanup needs.
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      subscribeKey: (_workspaceId: string, _listener: () => void) => () => undefined,
      getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
    }),
}));

import { AskUserQuestionToolCall } from "./AskUserQuestionToolCall";

describe("AskUserQuestionToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = {
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [],
    };

    answerAskUserQuestion.mockClear();
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("rolls back temporary auto-retry enablement when component unmounts", async () => {
    const view = renderWithProviders(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-1"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(answerAskUserQuestion).toHaveBeenCalledTimes(1);
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    view.unmount();

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("restores preference when terminal update arrives without in-flight snapshots", async () => {
    const view = renderWithProviders(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-3"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(answerAskUserQuestion).toHaveBeenCalledTimes(1);
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = {
      ...currentWorkspaceState,
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [{ type: "assistant" }],
    };
    view.rerender(
      <TooltipProvider>
        <AskUserQuestionToolCall
          args={{ questions: [], answers: {} }}
          result={null}
          status="executing"
          toolCallId="ask-3"
          workspaceId="ws-ask"
        />
      </TooltipProvider>
    );

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("rolls back temporary retry enable when resume reports not started", async () => {
    resumeStream.mockImplementationOnce((_input: unknown) =>
      Promise.resolve({ success: true as const, data: { started: false } })
    );

    const view = renderWithProviders(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-busy"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("restores auto-retry even when unmounted before async resume setup finishes", async () => {
    const answerDeferred = createDeferred<{ success: true; data: undefined }>();
    const resumeDeferred = createDeferred<{ success: true; data: { started: boolean } }>();

    answerAskUserQuestion.mockImplementationOnce((_input: unknown) => answerDeferred.promise);
    resumeStream.mockImplementationOnce((_input: unknown) => resumeDeferred.promise);

    const view = renderWithProviders(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-2"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    // Simulate workspace switch/removal before async setup finishes.
    view.unmount();

    answerDeferred.resolve({ success: true, data: undefined });
    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    resumeDeferred.resolve({ success: true, data: { started: true } });
    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });
});
