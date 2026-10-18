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

import { getUserPreferences, updateUserPreferences } from "@/browser/stores/AppConfigStore";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
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

/** The composer suggestion row that shows `label`, if any. */
function suggestionOption(app: AppHarness, label: string): Element | null {
  return (
    [...app.view.container.ownerDocument.querySelectorAll('[role="option"]')].find((option) =>
      (option.textContent ?? "").includes(label)
    ) ?? null
  );
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

/**
 * One user edit through the textarea, as a browser runs it: `beforeinput` with the selection the
 * edit replaces (default: the caret at the end), then the input event React turns into onChange.
 */
function editTextarea(
  app: AppHarness,
  edit: { inputType: string; value: string; data?: string; selection?: [number, number] }
) {
  const textarea = composer(app);
  const [start, end] = edit.selection ?? [textarea.value.length, textarea.value.length];
  textarea.setSelectionRange(start, end);
  // The test DOM's window has InputEvent; the jest global does not.
  const view = textarea.ownerDocument.defaultView as unknown as typeof globalThis;
  act(() => {
    textarea.dispatchEvent(
      new view.InputEvent("beforeinput", {
        inputType: edit.inputType,
        data: edit.data ?? null,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  if (edit.value !== textarea.value) fireEvent.input(textarea, { target: { value: edit.value } });
}

/** Vim keys through VimTextArea's key handler, with no wait in between. */
function pressVimKeys(app: AppHarness, keys: string[]) {
  for (const key of keys) fireEvent.keyDown(composer(app), { key });
}

/** Types `text` one key at a time at the end of the textarea. */
function typeIntoTextarea(app: AppHarness, text: string) {
  for (const key of text) {
    editTextarea(app, { inputType: "insertText", data: key, value: composer(app).value + key });
  }
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

  // #6866: VimTextArea moves the DOM caret after a key in a timeout. A key that comes first (a
  // busy page, a fast typist) is still a Vim command, not typed text.
  test("a Vim command right after Escape is a command, not text", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-vim-fast-keys" });
    try {
      act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
      await app.chat.typeWithoutSending("yes");
      pressVimKeys(app, ["Escape", "c", "c"]);
      expect(composer(app).value).toBe("");
    } finally {
      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
      await app.dispose();
    }
  }, 120_000);

  // #6866 item 1: in Vim mode the interrupt key is Ctrl+C, so Escape in the composer during a
  // stream switches to normal mode and leaves the stream running. The non-Vim composer opts in to
  // Escape interrupts (data-escape-interrupts-stream), checked as the control.
  test("Escape during a stream switches Vim to normal mode and does not interrupt", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-vim-escape-stream" });
    const workspaceService = app.env.services.workspaceService;
    const interrupt = jest.spyOn(workspaceService, "interruptStream");
    try {
      act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
      await app.chat.send("[mock:long-stream] keep going");
      await waitFor(
        () =>
          expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).canInterrupt).toBe(true),
        WAIT
      );
      await waitFor(() => expect(composer(app).disabled).toBe(false), WAIT);
      composer(app).focus();
      fireEvent.keyDown(composer(app), { key: "Escape" });
      fireEvent.keyDown(composer(app), { key: "i" });
      typeIntoTextarea(app, "x");
      expect(composer(app).value).toBe("x");
      expect(interrupt).not.toHaveBeenCalled();

      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(false), WAIT);
      fireEvent.keyDown(composer(app), { key: "Escape" });
      await waitFor(() => expect(interrupt).toHaveBeenCalled(), WAIT);
    } finally {
      interrupt.mockRestore();
      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
      await app.dispose();
    }
  }, 120_000);

  // Keys typed in insert mode move the real caret: an Escape that comes before the deferred move
  // starts from the typed position, not from the Vim cursor before the typing.
  test("Vim keys after fast typing start from the typed caret", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-vim-typed-caret" });
    try {
      act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
      await app.chat.typeWithoutSending("abc");
      pressVimKeys(app, ["Escape", "A"]);
      typeIntoTextarea(app, "d");
      // Escape puts the cursor on "d"; `x` deletes it.
      pressVimKeys(app, ["Escape", "x"]);
      expect(composer(app).value).toBe("abc");
    } finally {
      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
      await app.dispose();
    }
  }, 120_000);

  // A caret the browser moves itself (Home, arrows, a click) is the cursor for the next Vim key.
  test("a Vim key after a native caret move starts from that caret", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-vim-native-caret" });
    try {
      act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
      await app.chat.typeWithoutSending("abc");
      pressVimKeys(app, ["Escape", "i"]);
      // Home in insert mode: the browser moves the caret to the start of the line.
      composer(app).setSelectionRange(0, 0);
      pressVimKeys(app, ["Escape", "x"]);
      expect(composer(app).value).toBe("bc");
    } finally {
      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
      await app.dispose();
    }
  }, 120_000);

  // Each key moves the DOM caret before the next one: a fast `h` then `x` deletes "b".
  test("fast Vim keys each start from the previous key's cursor", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-vim-caret-order" });
    try {
      act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
      await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
      await app.chat.typeWithoutSending("abc");
      pressVimKeys(app, ["Escape", "h", "x"]);
      expect(composer(app).value).toBe("ac");
    } finally {
      act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
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

  // #6585: the same flows through real textarea events (beforeinput + input), not DraftStore.
  describe("textarea edits between Enter and the take (#6585)", () => {
    /** Sends `sent`, runs `edit` while the take is held, and returns the composer text after. */
    async function editBeforeTake(
      sent: string,
      edit: (app: AppHarness) => void | Promise<void>,
      options?: { vim: boolean }
    ) {
      const app = await createAppHarness({ branchPrefix: "composer-textarea-take" });
      const takes = holdTakes();
      try {
        // After the harness: preference writes need its backend connection.
        if (options?.vim) {
          act(() => updateUserPreferences({ appearance: { vimEnabled: true } }));
          await waitFor(() => expect(getUserPreferences().appearance?.vimEnabled).toBe(true), WAIT);
        }
        await app.chat.send(sent);
        await waitFor(() => expect(takes.spy).toHaveBeenCalledTimes(1), WAIT);
        await edit(app);
        takes.release();
        await app.chat.expectTranscriptContains(`Mock response: ${sent}`, WAIT.timeout);
        await app.chat.expectStreamComplete();
        await waitFor(() => expect(sendButton(app).disabled).toBe(false), WAIT);
        return composer(app).value;
      } finally {
        if (options?.vim) act(() => updateUserPreferences({ appearance: { vimEnabled: false } }));
        takes.release();
        takes.spy.mockRestore();
        await app.dispose();
      }
    }

    test("keys typed into the textarea after Enter stay, without the sent text", async () => {
      expect(await editBeforeTake("first message", (app) => typeIntoTextarea(app, "  next"))).toBe(
        "  next"
      );
    }, 120_000);

    test("a select-all paste over the sent text keeps the whole pasted text", async () => {
      const pasted = "Fix the bug in parser.ts";
      const value = await editBeforeTake("Fix the bug", (app) =>
        editTextarea(app, { inputType: "insertFromPaste", value: pasted, selection: [0, 11] })
      );
      expect(value).toBe(pasted);
    }, 120_000);

    // #6729: Vim normal-mode commands edit through VimTextArea's key handler, with no
    // beforeinput. `cc` clears the line; the user then types the new text in insert mode.
    test("a Vim cc and a retyped text keep what was typed", async () => {
      const value = await editBeforeTake(
        "yes",
        (app) => {
          // #6866: no wait between keys. The page is busy right after Enter, so the next key
          // arrives before VimTextArea's deferred caret move.
          pressVimKeys(app, ["Escape", "c", "c"]);
          expect(composer(app).value).toBe("");
          typeIntoTextarea(app, "yes please");
        },
        { vim: true }
      );
      expect(value).toBe("yes please");
    }, 120_000);

    // #6866: an append is typing, also from Vim: the sent text goes and the appended text stays.
    test("a Vim o or p at the end counts as typing after the sent text", async () => {
      const opened = await editBeforeTake(
        "yes",
        (app) => {
          pressVimKeys(app, ["Escape", "o"]);
          typeIntoTextarea(app, "more");
        },
        { vim: true }
      );
      expect(opened).toBe("\nmore");
      const pasted = await editBeforeTake(
        "yes",
        (app) => pressVimKeys(app, ["Escape", "y", "y", "p"]),
        { vim: true }
      );
      // `yy` yanks "yes" and `p` pastes it after the cursor, at the end: "yesyes".
      expect(pasted).toBe("yes");
    }, 120_000);

    // #6866: code-driven edits fire no beforeinput. A replace (analytics drill-down, Compact &
    // retry, Run /init) is not typing, even when its text starts with the sent text.
    test("a replace of the composer text keeps the whole new text", async () => {
      const value = await editBeforeTake("yes", () => {
        act(() => {
          window.dispatchEvent(
            createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
              text: "yes please",
              mode: "replace",
            })
          );
        });
      });
      expect(value).toBe("yes please");
    }, 120_000);

    // A replace with files (Compact & retry passes the source's file parts) takes another path.
    test("a replace with a file keeps the whole new text", async () => {
      const value = await editBeforeTake("yes", () => {
        act(() => {
          window.dispatchEvent(
            createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
              text: "yes please",
              mode: "replace",
              fileParts: [{ url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" }],
            })
          );
        });
      });
      expect(value).toBe("yes please");
    }, 120_000);

    // Appends (a quote, a palette insert, dictation) and an accepted suggestion at the end are
    // typing after the sent text: the sent text goes, the added text stays.
    test("an append and an accepted suggestion keep the added text", async () => {
      const appended = await editBeforeTake("yes", () => {
        act(() => {
          window.dispatchEvent(
            createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, { text: "> quoted", mode: "append" })
          );
        });
      });
      expect(appended).toBe("\n\n> quoted");
      const accepted = await editBeforeTake("yes", async (app) => {
        typeIntoTextarea(app, " @READ");
        await waitFor(() => expect(suggestionOption(app, "README.md")).not.toBeNull(), WAIT);
        fireEvent.keyDown(composer(app), { key: "Tab" });
        await waitFor(() => expect(composer(app).value).toBe("yes @README.md "), WAIT);
      });
      expect(accepted).toBe(" @README.md ");
    }, 120_000);

    // History recall (ArrowUp) works only from an empty composer, which the window after Enter
    // never shows without an edit first: no edit opens, and the take stays exact.
    test("ArrowUp after Enter opens no edit and the take is exact", async () => {
      const value = await editBeforeTake("yes", (app) => {
        fireEvent.keyDown(composer(app), { key: "ArrowUp" });
        expect(composer(app).getAttribute("aria-label")).toBe("Message");
        typeIntoTextarea(app, "x");
      });
      expect(value).toBe("x");
    }, 120_000);

    test("deleting the sent text and typing it again keeps what was typed", async () => {
      const value = await editBeforeTake("yes", (app) => {
        editTextarea(app, { inputType: "deleteContentBackward", value: "", selection: [0, 3] });
        typeIntoTextarea(app, "yes please");
      });
      expect(value).toBe("yes please");
    }, 120_000);
  });
});
