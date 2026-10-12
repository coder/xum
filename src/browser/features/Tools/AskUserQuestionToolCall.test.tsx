import "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { APIProvider } from "@/browser/contexts/API";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { createTestApiClient } from "@/browser/testUtils";
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
  messages: Array<{
    type: string;
    compactionRequest?: { parsed: unknown };
    askUserQuestionAnswer?: { toolCallId: string; answers: Record<string, string> };
  }>;
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
const sendMessageData: Record<string, never> = {};
const sendMessage = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: sendMessageData })
);

const apiClient = createTestApiClient({
  workspace: {
    answerAskUserQuestion,
    sendMessage,
    resumeStream,
    setAutoRetryEnabled,
  },
});

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
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = {
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [],
    };

    answerAskUserQuestion.mockClear();
    sendMessage.mockClear();
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    restoreDomGlobals();
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

  describe("non-blocking questions", () => {
    const questions = [
      {
        header: "Choice",
        question: "Which option?",
        options: [
          { label: "First", description: "Use first" },
          { label: "Second", description: "Use second" },
        ],
        multiSelect: false,
      },
    ];
    const asyncResult = {
      summary: "Questions shown to the user.",
      ui_only: {
        ask_user_question: { questions, answers: {}, answerDelivery: "message" as const },
      },
    };

    function renderAsyncQuestion() {
      return renderWithProviders(
        <AskUserQuestionToolCall
          args={{ questions }}
          result={asyncResult}
          status="completed"
          toolCallId="ask-async"
          workspaceId="ws-ask"
        />
      );
    }

    test("sends the answers as a chat message and shows them once accepted", async () => {
      const view = renderAsyncQuestion();

      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

      // No answer row is in the transcript yet (it may be queued, or batched into another
      // queued message without its metadata): the accepted send alone answers the card.
      await waitFor(() => expect(view.getByText("User answered")).toBeTruthy());
      expect(view.queryByRole("button", { name: "Submit answers" })).toBeNull();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [input] = sendMessage.mock.calls[0] as [
        { workspaceId: string; options: { muxMetadata?: unknown } },
      ];
      expect(input.workspaceId).toBe("ws-ask");
      expect(input.options.muxMetadata).toEqual({
        type: "normal",
        askUserQuestionAnswer: { toolCallId: "ask-async", answers: { "Which option?": "First" } },
      });
      // Ordinary user input, like Codex: no blocked tool call to answer and no stream to resume.
      expect(answerAskUserQuestion).not.toHaveBeenCalled();
      expect(resumeStream).not.toHaveBeenCalled();
      expect(setAutoRetryEnabled).not.toHaveBeenCalled();
    });

    test("a retry after a lost response reuses the send id", async () => {
      sendMessage.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));
      const view = renderAsyncQuestion();

      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      await waitFor(() => expect(view.getByText("connection lost")).toBeTruthy());

      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      await waitFor(() => expect(view.getByText("User answered")).toBeTruthy());

      const sendIds = (sendMessage.mock.calls as Array<[{ options: { sendId?: string } }]>).map(
        ([input]) => input.options.sendId
      );
      expect(sendIds).toHaveLength(2);
      // The backend may have accepted the first send: the same id keeps it to one answer row.
      expect(sendIds[0]).toBeTruthy();
      expect(sendIds[1]).toBe(sendIds[0]);
    });

    test("names picked options by number, even when labels contain commas", async () => {
      const partsQuestion = {
        header: "Parts",
        question: "Which parts?",
        options: [
          { label: "Alpha", description: "a" },
          { label: "Alpha, Beta", description: "b" },
        ],
        multiSelect: true,
      };
      const view = renderWithProviders(
        <AskUserQuestionToolCall
          args={{ questions: [partsQuestion], answers: { "Which parts?": "Alpha, Beta" } }}
          result={{
            ...asyncResult,
            ui_only: {
              ask_user_question: {
                questions: [partsQuestion],
                answers: {},
                answerDelivery: "message",
              },
            },
          }}
          status="completed"
          toolCallId="ask-parts"
          workspaceId="ws-ask"
        />
      );

      // The prefill picks "Alpha" plus the Other text "Beta": flattened, that reads exactly like
      // the second label, so the message must come from the picks, not the answer string.
      expect(view.getByDisplayValue("Beta")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Next" }));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const [input] = sendMessage.mock.calls[0] as [{ message: string }];
      expect(input.message).toContain('- Question 1: option 1; other: "Beta"');
      // Labels are model-authored: none may be promoted into the user-role text.
      expect(input.message).not.toContain("Alpha");
    });

    test("shows the latest answers delivered in later user messages", () => {
      const answerRow = (answer: string) => ({
        type: "user",
        askUserQuestionAnswer: { toolCallId: "ask-async", answers: { "Which option?": answer } },
      });
      // A correction sent after the first answer supersedes it.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [answerRow("First"), answerRow("Second")],
      };

      const view = renderAsyncQuestion();
      // Answered questions follow the collapsed tool preference; expand to read the answers.
      fireEvent.click(view.getByText("ask_user_question"));

      expect(view.queryByRole("button", { name: "Submit answers" })).toBeNull();
      expect(view.getByText("Second")).toBeTruthy();
      expect(view.queryByText("First")).toBeNull();
    });
  });
});
