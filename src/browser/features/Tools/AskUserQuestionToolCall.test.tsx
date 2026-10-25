import "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { APIProvider } from "@/browser/contexts/API";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { createTestApiClient } from "@/browser/testUtils";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement, ReactNode } from "react";

import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE } from "@/constants/transcriptBarrier";

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
    id?: string;
    toolName?: string;
    toolCallId?: string;
    compactionRequest?: { parsed: unknown };
    askUserQuestionAnswers?: Array<{ toolCallId: string; answers: Record<string, string> }>;
  }>;
} = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages: [],
};

let transcriptCaughtUp = true;
// False models a host that does not feed WorkspaceStore (the VS Code webview): reads throw.
let workspaceStoreFed = true;

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

// Snapshot the real exports before this file mocks the module. Do not load a second copy with
// require("...WorkspaceStore?real=1"): Bun's LCOV keeps only the last-loaded copy of a file, so a
// later second copy replaces WorkspaceStore.test.ts's coverage of WorkspaceStore.ts in the shard.
const actualWorkspaceStore = { ...RealWorkspaceStoreModule };

// The overlay also changes the store identity, so it must stay local to this suite.
restoreModulesAfterSuite([["@/browser/stores/WorkspaceStore", { ...actualWorkspaceStore }]]);

// Overlay (not replace) the raw store so modules imported while this stub is active
// retain methods such as setNavigateToWorkspace that their cleanup needs.
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      subscribeKey: (_workspaceId: string, _listener: () => void) => () => undefined,
      getWorkspaceState: (_workspaceId: string) => {
        if (!workspaceStoreFed) {
          throw new Error("Workspace not registered");
        }
        return currentWorkspaceState;
      },
    }),
}));

import { AskUserQuestionToolCall, PlacedAskUserQuestionToolCall } from "./AskUserQuestionToolCall";
import { AskUserQuestionPlacementProvider } from "./AskUserQuestion/askUserQuestionPlacement";
import { findOpenAskUserQuestions } from "@/browser/utils/messages/openAskUserQuestions";

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

    transcriptCaughtUp = true;
    workspaceStoreFed = true;
    spyOn(actualWorkspaceStore.workspaceStore, "isWorkspaceTranscriptCaughtUp").mockImplementation(
      () => transcriptCaughtUp
    );

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

    // Accepted answers outlive the card (app session), so each test asks in its own workspace.
    let asyncWorkspaceId = "";
    let asyncWorkspaceCount = 0;
    beforeEach(() => {
      asyncWorkspaceCount += 1;
      asyncWorkspaceId = `ws-ask-async-${asyncWorkspaceCount}`;
    });

    function renderAsyncQuestion(rowId?: string) {
      return renderWithProviders(
        <AskUserQuestionToolCall
          args={{ questions }}
          result={asyncResult}
          status="completed"
          toolCallId="ask-async"
          workspaceId={asyncWorkspaceId}
          rowId={rowId}
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
      expect(input.workspaceId).toBe(asyncWorkspaceId);
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
          workspaceId={asyncWorkspaceId}
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
        askUserQuestionAnswers: [{ toolCallId: "ask-async", answers: { "Which option?": answer } }],
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

    test("a later answer row overrides this card's own accepted answer", async () => {
      const view = renderAsyncQuestion();
      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      await waitFor(() => expect(view.getByText("User answered")).toBeTruthy());

      // Another client sent a correction.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          {
            type: "user",
            askUserQuestionAnswers: [
              { toolCallId: "ask-async", answers: { "Which option?": "Second" } },
            ],
          },
        ],
      };
      view.rerender(
        <TooltipProvider>
          <AskUserQuestionToolCall
            args={{ questions }}
            result={asyncResult}
            status="completed"
            toolCallId="ask-async"
            workspaceId={asyncWorkspaceId}
          />
        </TooltipProvider>
      );

      expect(view.getByText("Second")).toBeTruthy();
      expect(view.queryByText("First")).toBeNull();
    });

    test("does not send while the transcript is still replaying", async () => {
      transcriptCaughtUp = false;
      const view = renderAsyncQuestion();

      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

      await waitFor(() =>
        expect(view.getByRole("button", { name: "Submit answers" })).toHaveProperty(
          "disabled",
          false
        )
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(view.queryByText("User answered")).toBeNull();
    });

    test("closes unanswered questions that left the agent's context", () => {
      // A compaction (or Start Here, reset) after the question removed it from the model's
      // context; numbered answers would mean nothing to the model.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          { type: "tool", toolName: "ask_user_question", toolCallId: "ask-async" },
          { type: "compaction-boundary" },
        ],
      };

      const view = renderAsyncQuestion();
      fireEvent.click(view.getByText("ask_user_question"));

      expect(view.queryByRole("button", { name: "Submit answers" })).toBeNull();
      expect(view.getByText(/no longer in the agent/)).toBeTruthy();
    });

    test("a later question that reuses the tool call id takes over its answers", () => {
      // Providers may reuse ids (call_0 every turn); the answer message names the call by id, so
      // the agent reads an answer to it as meant for its latest call.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          { type: "tool", id: "row-1", toolName: "ask_user_question", toolCallId: "ask-async" },
          { type: "tool", id: "row-2", toolName: "ask_user_question", toolCallId: "ask-async" },
          {
            type: "user",
            askUserQuestionAnswers: [
              { toolCallId: "ask-async", answers: { "Which option?": "Second" } },
            ],
          },
        ],
      };
      const renderRow = (rowId: string) =>
        renderWithProviders(
          <AskUserQuestionToolCall
            args={{ questions }}
            result={asyncResult}
            status="completed"
            toolCallId="ask-async"
            workspaceId="ws-ask"
            rowId={rowId}
          />
        );

      const earlier = renderRow("row-1");
      fireEvent.click(earlier.getByText("ask_user_question"));
      expect(earlier.getByText(/later question replaced/)).toBeTruthy();
      expect(earlier.queryByText("User answered")).toBeNull();
      earlier.unmount();

      const later = renderRow("row-2");
      fireEvent.click(later.getByText("ask_user_question"));
      expect(later.getByText("User answered")).toBeTruthy();
    });

    test("rechecks for a question that reused the tool call id right before sending", async () => {
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          { type: "tool", id: "row-1", toolName: "ask_user_question", toolCallId: "ask-async" },
        ],
      };
      const view = renderWithProviders(
        <AskUserQuestionToolCall
          args={{ questions }}
          result={asyncResult}
          status="completed"
          toolCallId="ask-async"
          workspaceId="ws-ask"
          rowId="row-1"
        />
      );
      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      // The later call lands while preferences flush: sending would answer it instead.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          ...currentWorkspaceState.messages,
          { type: "tool", id: "row-2", toolName: "ask_user_question", toolCallId: "ask-async" },
        ],
      };

      await waitFor(() => expect(view.getByText(/later question replaced/)).toBeTruthy());
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("rechecks the agent's context right before sending", async () => {
      const view = renderAsyncQuestion();
      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      // A compaction lands after the click but before dispatch (while preferences flush): the
      // rendered card is still open, so only a dispatch-time re-read can catch it.
      currentWorkspaceState = {
        ...currentWorkspaceState,
        messages: [
          { type: "tool", toolName: "ask_user_question", toolCallId: "ask-async" },
          { type: "compaction-boundary" },
        ],
      };

      await waitFor(() =>
        expect(view.queryByRole("button", { name: "Submit answers" })).toBeNull()
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("an accepted answer without an answer row stays answered for the dock and a remount", async () => {
      const row = {
        type: "tool",
        id: "row-ask-async",
        historyId: "history-ask-async",
        toolCallId: "ask-async",
        toolName: "ask_user_question",
        args: { questions },
        result: asyncResult,
        status: "completed",
        isPartial: false,
        historySequence: 1,
      } as const;
      expect(findOpenAskUserQuestions(asyncWorkspaceId, [row])).toHaveLength(1);

      const view = renderAsyncQuestion("row-ask-async");
      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      await waitFor(() => expect(view.getByText("User answered")).toBeTruthy());

      // Batched into a queued message, the answer may never land as a row.
      expect(findOpenAskUserQuestions(asyncWorkspaceId, [row])).toEqual([]);
      view.unmount();
      const remounted = renderAsyncQuestion("row-ask-async");
      // Closed, so it follows the collapsed tool preference: open it to read the answers.
      fireEvent.click(remounted.getByText("ask_user_question"));
      expect(remounted.getByText("User answered")).toBeTruthy();
      expect(remounted.queryByRole("button", { name: "Submit answers" })).toBeNull();
    });

    test("sends from a host that does not feed WorkspaceStore", async () => {
      // The VS Code webview renders this card without registering the workspace in the store.
      workspaceStoreFed = false;
      const view = renderAsyncQuestion();

      fireEvent.click(view.getByText("First"));
      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

      await waitFor(() => expect(view.getByText("User answered")).toBeTruthy());
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  test("does not answer a blocking question while the transcript is still replaying", async () => {
    // The dock shows open questions before a replay catches up; a stale copy must not resume.
    transcriptCaughtUp = false;
    const view = renderWithProviders(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-replaying"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => expect(view.getByText(TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE)).toBeTruthy());
    expect(answerAskUserQuestion).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
  });

  describe("docked above the chat input", () => {
    function renderInTranscript(transcriptWorkspaceId: string) {
      return renderWithProviders(
        <AskUserQuestionPlacementProvider
          value={{
            kind: "transcript",
            workspaceId: transcriptWorkspaceId,
            dockedRowIds: new Set(["row-docked"]),
          }}
        >
          <PlacedAskUserQuestionToolCall
            args={{ questions: [], answers: {} }}
            result={null}
            status="executing"
            toolCallId="ask-docked"
            workspaceId="ws-ask"
            rowId="row-docked"
          />
        </AskUserQuestionPlacementProvider>
      );
    }

    test("the transcript row leaves the form to the dock", () => {
      const view = renderInTranscript("ws-ask");
      expect(view.queryByRole("button", { name: "Submit answers" })).toBeNull();
    });

    test("another workspace's dock does not take this transcript's form", () => {
      // A nested transcript (e.g. a sub-agent dialog) inherits the parent's placement.
      const view = renderInTranscript("ws-parent");
      expect(view.getByRole("button", { name: "Submit answers" })).toBeTruthy();
    });

    test("a docked card renders nothing once answered and releases itself after the rollback", async () => {
      const release = mock((_toolCallId: string) => undefined);
      const renderDocked = (status: "executing" | "completed") => (
        <TooltipProvider>
          <AskUserQuestionPlacementProvider value={{ kind: "dock", release }}>
            <PlacedAskUserQuestionToolCall
              args={{ questions: [], answers: {} }}
              result={null}
              status={status}
              toolCallId="ask-docked"
              workspaceId="ws-ask"
              rowId="row-docked"
            />
          </AskUserQuestionPlacementProvider>
        </TooltipProvider>
      );
      const view = render(renderDocked("executing"), { wrapper: ApiWrapper });

      fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
      await waitFor(() => expect(resumeStream).toHaveBeenCalledTimes(1));

      view.rerender(renderDocked("completed"));
      expect(view.container.textContent).toBe("");
      // Still mounted: the temporary auto-retry stays on until the resumed stream settles.
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      // The resumed stream runs, then ends: the rollback runs and the card lets the dock drop it.
      currentWorkspaceState = { ...currentWorkspaceState, canInterrupt: true };
      view.rerender(renderDocked("completed"));
      currentWorkspaceState = { ...currentWorkspaceState, canInterrupt: false };
      view.rerender(renderDocked("completed"));

      await waitFor(() => expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2));
      expect(release).toHaveBeenCalledWith("row-docked");
    });
  });
});
