import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { createMuxMessage, type DisplayedMessage } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";
import { createTestApiClient } from "@/browser/testUtils";

import * as RealChatHostContextModule from "@/browser/contexts/ChatHostContext";
import * as RealTooltipModule from "@/browser/components/Tooltip/Tooltip";
import * as RealApiModule from "@/browser/contexts/API";
import { AssistantMessage } from "./AssistantMessage";

restoreModulesAfterSuite([
  ["@/browser/contexts/ChatHostContext", { ...RealChatHostContextModule }],
  ["@/browser/components/Tooltip/Tooltip", { ...RealTooltipModule }],
  ["@/browser/contexts/API", { ...RealApiModule }],
]);
void mock.module("@/browser/contexts/ChatHostContext", () => ({
  useChatHostContext: () => ({ uiSupport: { jsonRawView: "unsupported" as const } }),
}));
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
// Offline: Start Here and Fork stay inert, so the only writes this test can cause are clipboard ones.
void mock.module("@/browser/contexts/API", () => ({
  ...RealApiModule,
  useAPI: () => ({ api: createTestApiClient(), status: "offline" as const }),
  useLiveAPI: () => null,
}));

const tags = (ascii: string) =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

function assistantMessage(content: string): DisplayedMessage & { type: "assistant" } {
  const rows = buildDisplayedMessagesForMessage({
    message: createMuxMessage("a1", "assistant", "", undefined, [{ type: "text", text: content }]),
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  const row = rows[0];
  if (row?.type !== "assistant") throw new Error(`Expected an assistant row, got ${row?.type}`);
  return row;
}

describe("AssistantMessage invisible-tag handling", () => {
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

  test("reveals the payload in the row and copies the bytes behind it", () => {
    const original = `shipping now${tags("XY")}`;
    const copies: string[] = [];
    const view = render(
      <AssistantMessage
        message={assistantMessage(original)}
        workspaceId="ws-1"
        clipboardWriteText={async (text) => void copies.push(text)}
      />
    );

    expect(view.container.textContent).toContain("shipping now<U+E0058><U+E0059>");

    const copy = view.container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]');
    if (!copy) throw new Error("No Copy button rendered");
    fireEvent.click(copy);

    expect(copies).toEqual([original]);
    expect(copies[0]).not.toContain("<U+");
  });
});
