import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { createMuxMessage, type DisplayedMessage } from "@/common/types/message";
import type { EditingMessageState } from "@/browser/utils/chatEditing";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";

import * as RealChatHostContextModule from "@/browser/contexts/ChatHostContext";
import * as RealTooltipModule from "@/browser/components/Tooltip/Tooltip";
import { UserMessage } from "./UserMessage";

// Bun module mocks are process-wide; restore the real exports for later suites.
restoreModulesAfterSuite([
  ["@/browser/contexts/ChatHostContext", { ...RealChatHostContextModule }],
  ["@/browser/components/Tooltip/Tooltip", { ...RealTooltipModule }],
]);
void mock.module("@/browser/contexts/ChatHostContext", () => ({
  useChatHostContext: () => ({ uiSupport: { jsonRawView: "unsupported" as const } }),
}));
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

/**
 * Unicode TAG characters (U+E0020-U+E007F) paint nothing yet map onto ASCII, so the transcript
 * reveals them as `<U+XXXX>` marks — but only for reading. The mark is irreversible, so the earlier
 * design, which revealed the row's `content`, corrupted the two things that consume it: Copy put 8
 * ASCII characters in the clipboard per invisible character, and Edit put the marks in the composer,
 * which then replaced the user's message in history with them.
 */
const tags = (ascii: string) =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

function userMessage(content: string): DisplayedMessage & { type: "user" } {
  // Built the way the transcript builds it, so the row under test is the projection's output rather
  // than a fixture: the shipped defect lived in the projection, and a hand-written row passes there.
  const rows = buildDisplayedMessagesForMessage({
    message: createMuxMessage("u1", "user", "", undefined, [{ type: "text", text: content }]),
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  const row = rows[0];
  if (row?.type !== "user") throw new Error(`Expected a user row, got ${row?.type}`);
  return row;
}

function renderUserMessage(
  content: string,
  handlers: {
    onCopy: (text: string) => void;
    onEdit: (state: EditingMessageState) => void;
  }
) {
  return render(
    <UserMessage
      message={userMessage(content)}
      clipboardWriteText={async (text) => void handlers.onCopy(text)}
      onEdit={handlers.onEdit}
    />
  );
}

function clickButton(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`No ${label} button rendered`);
  fireEvent.click(button);
}

describe("UserMessage invisible-tag handling", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("shows the hidden payload the user cannot otherwise see", () => {
    const view = renderUserMessage(`continue${tags("XY")}`, {
      onCopy: () => undefined,
      onEdit: () => undefined,
    });

    expect(view.container.textContent).toContain("continue<U+E0058><U+E0059>");
  });

  test("Copy hands over the bytes the user typed, not the marks on screen", () => {
    const original = `continue${tags("XY")}`;
    const copies: string[] = [];
    const view = renderUserMessage(original, {
      onCopy: (text) => copies.push(text),
      onEdit: () => undefined,
    });

    clickButton(view.container, "Copy");

    // The revealed form is 8 ASCII characters per tag: length is what the bug shipped with.
    expect(copies).toEqual([original]);
    expect(copies[0]?.length).toBe(original.length);
    expect(copies[0]).not.toContain("<U+");
  });

  test("Edit drafts the original text, which is what the next request and history receive", () => {
    const original = `continue${tags("XY")}`;
    const drafts: string[] = [];
    const view = renderUserMessage(original, {
      onCopy: () => undefined,
      onEdit: (state) => drafts.push(state.pending.content),
    });

    clickButton(view.container, "Edit");

    expect(drafts).toEqual([original]);
  });

  test("leaves a subdivision-flag emoji rendered as the flag, not as marks", () => {
    // An RGI subdivision flag's tags ARE the emoji, so revealing them would replace a drawn flag
    // with text while still leaving the copy byte-identical.
    const flag = `\u{1F3F4}${tags("gbeng")}\u{E007F}`;
    const copies: string[] = [];
    const view = renderUserMessage(`ship ${flag}`, {
      onCopy: (text) => copies.push(text),
      onEdit: () => undefined,
    });

    expect(view.container.textContent).toContain(`ship ${flag}`);
    expect(view.container.textContent).not.toContain("<U+");

    clickButton(view.container, "Copy");
    expect(copies).toEqual([`ship ${flag}`]);
  });
});
