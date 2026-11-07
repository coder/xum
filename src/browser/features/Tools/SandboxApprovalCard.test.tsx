import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { APIContext, type APIClient } from "@/browser/contexts/API";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { createTestApiClient } from "@/browser/testUtils";
import { SandboxApprovalCard } from "./SandboxApprovalCard";

const WORKSPACE_ID = "ws-sandbox";

let cleanupDom: (() => void) | null = null;
type AnswerInput = Parameters<APIClient["workspace"]["answerSandboxApproval"]>[0];
const answerSandboxApproval = mock((_input: AnswerInput) =>
  Promise.resolve({ success: true as const, data: undefined })
);

beforeEach(() => {
  cleanupDom = installDom();
  answerSandboxApproval.mockClear();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

function renderCards(cards: Array<{ toolCallId: string; isLatest: boolean }>) {
  const api = createTestApiClient({ workspace: { answerSandboxApproval } });
  return render(
    <APIContext.Provider
      value={{
        status: "connected",
        api,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      <TooltipProvider>
        {cards.map((card) => (
          <SandboxApprovalCard
            key={card.toolCallId}
            workspaceId={WORKSPACE_ID}
            toolCallId={card.toolCallId}
            script="git push origin HEAD"
            reason="Push over SSH needs the ssh-agent socket."
            isLatest={card.isLatest}
          />
        ))}
      </TooltipProvider>
    </APIContext.Provider>
  );
}

function pressChord(code: "KeyY" | "KeyN") {
  fireEvent.keyDown(window, {
    key: code === "KeyY" ? "Y" : "N",
    code,
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
  });
}

describe("SandboxApprovalCard", () => {
  test("each button answers this call once: Deny with false, Run outside once with true", async () => {
    for (const [name, approved] of [
      [/^Deny/, false],
      [/^Run outside once/, true],
    ] as const) {
      answerSandboxApproval.mockClear();
      const view = renderCards([{ toolCallId: "call-1", isLatest: true }]);
      fireEvent.click(view.getByRole("button", { name }));
      await waitFor(() => expect(answerSandboxApproval).toHaveBeenCalledTimes(1));
      expect(answerSandboxApproval.mock.calls[0][0]).toEqual({
        workspaceId: WORKSPACE_ID,
        toolCallId: "call-1",
        approved,
      });
      cleanup();
    }
  });

  test("the shortcuts answer only the latest pending card", async () => {
    renderCards([
      { toolCallId: "call-old", isLatest: false },
      { toolCallId: "call-latest", isLatest: true },
    ]);

    pressChord("KeyN");
    await waitFor(() => expect(answerSandboxApproval).toHaveBeenCalledTimes(1));
    expect(answerSandboxApproval.mock.calls[0][0]).toEqual({
      workspaceId: WORKSPACE_ID,
      toolCallId: "call-latest",
      approved: false,
    });

    pressChord("KeyY");
    await waitFor(() => expect(answerSandboxApproval).toHaveBeenCalledTimes(2));
    expect(answerSandboxApproval.mock.calls[1][0]).toEqual({
      workspaceId: WORKSPACE_ID,
      toolCallId: "call-latest",
      approved: true,
    });
  });
});
