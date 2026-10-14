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

/**
 * Holds every DraftStore.beginSend (the send's take of its draft) until `release()`: the window
 * from Enter until the take that #6405 is about.
 */
function holdTakes() {
  const store = getDraftStore();
  const realBeginSend = store.beginSend.bind(store);
  let gates: (() => void)[] = [];
  const spy = jest
    .spyOn(store, "beginSend")
    .mockImplementation(async (...args: Parameters<typeof store.beginSend>) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return realBeginSend(...args);
    });
  return {
    spy,
    release: () => {
      const pending = gates;
      gates = [];
      for (const open of pending) open();
    },
  };
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

  // #6405: the composer stays on from Enter. Keys typed before the send takes its draft follow the
  // sent text directly ("message 0message 1"); the take removes exactly the sent text.
  test("typing straight through 10 sends keeps every key and leaves no sent text", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-on-through-take" });
    const takes = holdTakes();
    const scope = { kind: "workspace" as const, workspaceId: app.workspaceId };
    try {
      for (let i = 0; i < 10; i++) {
        const sent = `message ${i}`;
        const typed = `message ${i + 1}`;
        await app.chat.send(sent);
        // Enter was pressed; the send has not taken its draft yet.
        await waitFor(() => expect(takes.spy).toHaveBeenCalledTimes(i + 1), WAIT);
        expect(composer(app).disabled).toBe(false);
        act(() => {
          getDraftStore().setText(scope, sent + typed);
        });
        takes.release();
        await app.chat.expectTranscriptContains(`Mock response: ${sent}`, WAIT.timeout);
        await app.chat.expectStreamComplete();
        await waitFor(() => expect(sendButton(app).disabled).toBe(false), WAIT);
        expect(composer(app).value).toBe(typed);
      }
    } finally {
      takes.release();
      takes.spy.mockRestore();
      await app.dispose();
    }
  }, 240_000);

  test("a refused second Enter before the take keeps the first send's take exact", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-second-enter" });
    const takes = holdTakes();
    const scope = { kind: "workspace" as const, workspaceId: app.workspaceId };
    try {
      await app.chat.send("first message");
      await waitFor(() => expect(takes.spy).toHaveBeenCalledTimes(1), WAIT);
      act(() => {
        getDraftStore().setText(scope, "first messagex");
      });
      // Send waits for the first send to settle: this Enter is refused.
      fireEvent.keyDown(composer(app), { key: "Enter" });
      takes.release();
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      await waitFor(() => expect(sendButton(app).disabled).toBe(false), WAIT);
      expect(composer(app).value).toBe("x");
      expect(takes.spy).toHaveBeenCalledTimes(1);
    } finally {
      takes.release();
      takes.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  // Commands clear or replace the composer text themselves, so a slash send keeps the lock until
  // it took its draft.
  test("a slash command send still locks typing until it took its draft", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-command-lock" });
    const takes = holdTakes();
    try {
      await app.chat.send("/+0 command message");
      await waitFor(() => expect(takes.spy).toHaveBeenCalledTimes(1), WAIT);
      expect(composer(app).disabled).toBe(true);
      takes.release();
      await waitFor(() => expect(composer(app).disabled).toBe(false), WAIT);
      await app.chat.expectStreamComplete();
    } finally {
      takes.release();
      takes.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);
});
