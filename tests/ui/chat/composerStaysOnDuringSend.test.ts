/**
 * #6259: the composer used to turn itself off from stream-start until the send's reply settled,
 * so keys typed then were lost. Once a send has taken its draft, the textarea stays on and keeps
 * focus; only submission waits for the send to settle. The backend is real;
 * WorkspaceService.sendMessage is wrapped only to hold one reply after the backend accepted it.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor } from "@testing-library/react";

import { getDraftStore } from "@/browser/stores/DraftStore";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT = { timeout: 30_000 };

type SendMessage = AppHarness["env"]["services"]["workspaceService"]["sendMessage"];

/** The backend runs the FIRST send at once; its reply waits for `release()`. */
function holdFirstReply(app: AppHarness) {
  const workspaceService = app.env.services.workspaceService;
  const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: ReturnType<SendMessage> | undefined;
  const spy = jest
    .spyOn(workspaceService, "sendMessage")
    .mockImplementation((...args: Parameters<SendMessage>) => {
      if (first !== undefined) return realSend(...args);
      first = (async () => {
        const result = await realSend(...args);
        await gate;
        return result;
      })();
      return first;
    });
  return {
    spy,
    settle: async () => {
      release();
      await Promise.allSettled([first]);
    },
  };
}

function composer(app: AppHarness): HTMLTextAreaElement {
  const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]'
  );
  if (!textarea) throw new Error("Chat textarea not found");
  return textarea;
}

function sendButton(app: AppHarness): HTMLButtonElement {
  const button = app.view.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Send message"]'
  );
  if (!button) throw new Error("Send button not found");
  return button;
}

describe("composer during an unsettled send (#6259)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("after a send took its draft, the composer stays on and keeps what the user types", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-on-during-send" });
    const held = holdFirstReply(app);
    try {
      await app.chat.send("first message");
      // The stream has started (and even finished); only the send's reply is still pending.
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      expect(held.spy).toHaveBeenCalledTimes(1);

      await waitFor(() => expect(composer(app).disabled).toBe(false));
      expect(document.activeElement).toBe(composer(app));
      act(() => {
        getDraftStore().setText(
          { kind: "workspace", workspaceId: app.workspaceId },
          "typed meanwhile"
        );
      });
      await waitFor(() => expect(composer(app).value).toBe("typed meanwhile"));

      // Submission still waits for the first send to settle: no second send, nothing taken.
      expect(sendButton(app).disabled).toBe(true);
      fireEvent.keyDown(composer(app), { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(held.spy).toHaveBeenCalledTimes(1);

      await held.settle();
      await app.chat.expectInputValue("typed meanwhile", WAIT.timeout);
      await waitFor(() => expect(sendButton(app).disabled).toBe(false), WAIT);
    } finally {
      await held.settle();
      held.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);
});
