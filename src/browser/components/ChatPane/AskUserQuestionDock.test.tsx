import "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { APIProvider } from "@/browser/contexts/API";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { createTestApiClient } from "@/browser/testUtils";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";

import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { DisplayedMessage } from "@/common/types/message";
import type { AskUserQuestionQuestion } from "@/common/types/tools";
import { buildAskUserQuestionAnswerMessage } from "@/common/utils/tools/askUserQuestionSummary";

// The same harness as AskUserQuestionToolCall.test.tsx: the real APIProvider with a test client,
// and the WorkspaceStore overlay serving this suite's transcript.
let messages: DisplayedMessage[] = [];
// A stable snapshot per transcript: the blocking card reads it through useSyncExternalStore.
let workspaceState = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages,
};
function getWorkspaceState() {
  if (workspaceState.messages !== messages) {
    workspaceState = { ...workspaceState, messages };
  }
  return workspaceState;
}

const sendMessageData: Record<string, never> = {};
const sendMessage = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: sendMessageData })
);
const apiClient = createTestApiClient({ workspace: { sendMessage } });

const actualWorkspaceStore = { ...RealWorkspaceStoreModule };
restoreModulesAfterSuite([["@/browser/stores/WorkspaceStore", { ...actualWorkspaceStore }]]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      subscribeKey: (_workspaceId: string, _listener: () => void) => () => undefined,
      getWorkspaceState: (_workspaceId: string) => getWorkspaceState(),
    }),
}));

// Evaluating the lazy chunk publishes the tool cards, the chained form among them.
import "@/browser/features/Tools/Shared/toolCardsLoader";
import { AskUserQuestionDock } from "./AskUserQuestionDock";
import { findOpenAskUserQuestions } from "@/browser/utils/messages/openAskUserQuestions";

const STORAGE: AskUserQuestionQuestion = {
  question: "Which storage backend?",
  header: "Storage",
  options: [
    { label: "SQLite", description: "One file" },
    { label: "In memory", description: "Fastest" },
  ],
  multiSelect: false,
};
const PLATFORMS: AskUserQuestionQuestion = {
  question: "Which platforms?",
  header: "Platforms",
  options: [
    { label: "macOS", description: "Desktop" },
    { label: "Linux", description: "Servers" },
  ],
  multiSelect: true,
};

function questionRow(
  id: string,
  toolCallId: string,
  questions: AskUserQuestionQuestion[],
  answers?: Record<string, string>
): Extract<DisplayedMessage, { type: "tool" }> {
  return {
    type: "tool",
    id,
    historyId: `history-${id}`,
    toolCallId,
    toolName: "ask_user_question",
    args: { questions, answers },
    result: {
      summary: "Questions shown to the user.",
      ui_only: { ask_user_question: { questions, answers: {}, answerDelivery: "message" } },
    },
    status: "completed",
    isPartial: false,
    historySequence: 1,
  };
}

const ROW_A = questionRow("row-a", "ask-a", [STORAGE]);
const ROW_B = questionRow("row-b", "ask-b", [PLATFORMS]);

function dock(workspaceId: string) {
  return (
    <TooltipProvider>
      <AskUserQuestionDock workspaceId={workspaceId} />
    </TooltipProvider>
  );
}

function Wrapper(props: { children: ReactNode }) {
  return <APIProvider client={apiClient}>{props.children}</APIProvider>;
}

function sentInput(): { message: string; options: { muxMetadata?: unknown } } {
  expect(sendMessage).toHaveBeenCalledTimes(1);
  return (
    sendMessage.mock.calls[0] as [{ message: string; options: { muxMetadata?: unknown } }]
  )[0];
}

describe("AskUserQuestionDock", () => {
  // Accepted answers, drafts and the active tab outlive the dock, so each test has its own workspace.
  let workspaceId = "";
  let workspaceCount = 0;

  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    workspaceCount += 1;
    workspaceId = `ws-ask-dock-${workspaceCount}`;
    messages = [];
    spyOn(actualWorkspaceStore.workspaceStore, "isWorkspaceTranscriptCaughtUp").mockImplementation(
      () => true
    );
    sendMessage.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    restoreDomGlobals();
  });

  test("open question sets share one form and one answer message", async () => {
    messages = [ROW_A, ROW_B];
    const view = render(dock(workspaceId), { wrapper: Wrapper });

    expect(view.getAllByRole("button", { name: "Next" })).toHaveLength(1);
    expect(view.getByRole("button", { name: "Storage" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Platforms" })).toBeTruthy();

    // A single-select pick advances across the call boundary.
    fireEvent.click(view.getByText("SQLite"));
    expect(view.getByText(PLATFORMS.question)).toBeTruthy();
    fireEvent.click(view.getByText("Linux"));
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const input = sentInput();
    expect(input.message).toContain("Tool call ask-a:\n- Question 1: option 1\n");
    expect(input.message).toContain("Tool call ask-b:\n- Question 1: option 2\n");
    expect(input.options.muxMetadata).toEqual({
      type: "normal",
      askUserQuestionAnswer: [
        { toolCallId: "ask-a", answers: { [STORAGE.question]: "SQLite" } },
        { toolCallId: "ask-b", answers: { [PLATFORMS.question]: "Linux" } },
      ],
    });
    // Both rows closed, so the dock drops the form once the send settled.
    expect(findOpenAskUserQuestions(workspaceId, messages)).toEqual([]);
    await waitFor(() =>
      expect(view.container.querySelector('[data-component="AskUserQuestionDock"]')).toBeNull()
    );
  });

  test("one open question set sends the single card's message", async () => {
    messages = [ROW_A];
    const view = render(dock(workspaceId), { wrapper: Wrapper });

    fireEvent.click(view.getByText("SQLite"));
    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const input = sentInput();
    expect(input.message).toBe(
      buildAskUserQuestionAnswerMessage("ask-a", [{ optionNumbers: [1], otherText: "" }])
    );
    // The object shape: the only one older builds read.
    expect(input.options.muxMetadata).toEqual({
      type: "normal",
      askUserQuestionAnswer: { toolCallId: "ask-a", answers: { [STORAGE.question]: "SQLite" } },
    });
  });

  test("refuses the whole message when one question set closed right before sending", async () => {
    messages = [ROW_A, ROW_B];
    const view = render(dock(workspaceId), { wrapper: Wrapper });
    fireEvent.click(view.getByRole("button", { name: "Summary" }));
    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));
    // A later call reuses ask-b's id while the preferences flush: an answer would go to it.
    messages = [...messages, questionRow("row-b2", "ask-b", [PLATFORMS])];

    await waitFor(() => expect(view.getByText(/later question replaced/)).toBeTruthy());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a blocking question keeps its own card after the chained form", () => {
    // Plan mode: the call still executes and waits for its answer, so it has no result yet.
    const blocking: DisplayedMessage = {
      ...questionRow("row-plan", "ask-plan", [PLATFORMS]),
      result: undefined,
      status: "executing",
    };
    messages = [blocking, ROW_A];
    const view = render(dock(workspaceId), { wrapper: Wrapper });

    // Two forms: the chain (first, despite the blocking row coming first) and the blocking card.
    const nextButtons = view.getAllByRole("button", { name: "Next" });
    expect(nextButtons).toHaveLength(2);
    const storage = view.getByText(STORAGE.question);
    const platforms = view.getByText(PLATFORMS.question);
    expect(
      storage.compareDocumentPosition(platforms) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test("drafts and the active tab survive a remount", () => {
    messages = [ROW_A, ROW_B];
    const first = render(dock(workspaceId), { wrapper: Wrapper });
    fireEvent.click(first.getByText("SQLite"));
    first.unmount();

    const second = render(dock(workspaceId), { wrapper: Wrapper });
    expect(second.getByText(PLATFORMS.question)).toBeTruthy();
    expect(second.getByText("1/2 answered")).toBeTruthy();
  });

  test("drafts and the active tab survive the call returning without waiting", () => {
    // While the call still executes it has no result, so it renders as its own card.
    messages = [
      {
        ...questionRow("row-x", "ask-x", [STORAGE, PLATFORMS]),
        result: undefined,
        status: "executing",
      },
    ];
    const view = render(dock(workspaceId), { wrapper: Wrapper });
    fireEvent.click(view.getByText("SQLite"));
    expect(view.getByText(PLATFORMS.question)).toBeTruthy();

    // It returned without waiting: the row moves into the chained form.
    messages = [questionRow("row-x", "ask-x", [STORAGE, PLATFORMS])];
    view.rerender(dock(workspaceId));

    expect(view.getByText(PLATFORMS.question)).toBeTruthy();
    expect(view.getByText("1/2 answered")).toBeTruthy();
  });

  test("a question set that arrives while answering joins the mounted form", () => {
    // Prefilled Other text (typing does not reach React state in this happy-dom setup).
    messages = [questionRow("row-a", "ask-a", [STORAGE], { [STORAGE.question]: "use redis" })];
    const view = render(dock(workspaceId), { wrapper: Wrapper });
    const textarea = view.getByPlaceholderText("Type your answer");
    textarea.focus();

    messages = [...messages, ROW_B];
    view.rerender(dock(workspaceId));

    // Same node: the form did not remount, so the typed text and focus stay.
    expect(view.getByPlaceholderText("Type your answer")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveProperty("value", "use redis");
    expect(view.getByRole("button", { name: "Platforms" })).toBeTruthy();
    expect(view.getByText("1/2 answered")).toBeTruthy();
  });

  test("a question set that arrives after the user collapsed the form re-opens it", () => {
    messages = [ROW_A];
    const view = render(dock(workspaceId), { wrapper: Wrapper });
    fireEvent.click(view.getByText("ask_user_question"));
    expect(view.queryByText(STORAGE.question)).toBeNull();

    messages = [ROW_A, ROW_B];
    view.rerender(dock(workspaceId));

    expect(view.getByRole("button", { name: "Platforms" })).toBeTruthy();
  });

  test("the active question stays put when an earlier question set closes", () => {
    messages = [ROW_A, ROW_B];
    const view = render(dock(workspaceId), { wrapper: Wrapper });
    fireEvent.click(view.getByRole("button", { name: "Platforms" }));

    // Another client answered ask-a: its tabs leave, and ask-b's question moves to the front.
    messages = [
      ROW_A,
      ROW_B,
      {
        type: "user",
        id: "answer-a",
        historyId: "history-answer-a",
        content: "answers",
        historySequence: 2,
        askUserQuestionAnswers: [{ toolCallId: "ask-a", answers: { [STORAGE.question]: "" } }],
      },
    ];
    view.rerender(dock(workspaceId));

    expect(view.queryByRole("button", { name: "Storage" })).toBeNull();
    expect(view.getByText(PLATFORMS.question)).toBeTruthy();
  });
});
