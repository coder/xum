import React from "react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { MuxMessage } from "@/common/types/message";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealTooltipModule from "@/browser/components/Tooltip/Tooltip";
import { MessageWindow } from "./MessageWindow";

void mock.module("@/browser/contexts/ChatHostContext", () => ({
  useChatHostContext: () => ({
    uiSupport: { jsonRawView: "unsupported" as const },
  }),
}));

// Bun module mocks are process-wide; the null content stub must not hide
// tooltip content in later suites.
restoreModulesAfterSuite([["@/browser/components/Tooltip/Tooltip", { ...RealTooltipModule }]]);
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

function createAssistantMessage(overrides: {
  isStreaming?: boolean;
  isLastPartOfMessage?: boolean;
  isPartial?: boolean;
}): MuxMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    historySequence: 1,
    parts: [],
    metadata: { model: "test-model", partial: overrides.isPartial ? true : undefined },
    ...(overrides as object),
  } as unknown as MuxMessage;
}

function renderAssistantWindow(overrides: Parameters<typeof createAssistantMessage>[0]) {
  const message = createAssistantMessage(overrides);
  return render(
    <MessageWindow label="model" message={message} variant="assistant">
      <div>content</div>
    </MessageWindow>
  );
}

function expectAssistantMeta(container: HTMLElement, visible: boolean) {
  const block = container.querySelector("[data-message-block]");
  expect(block).not.toBeNull();
  expect(block?.querySelector("[data-message-meta]") !== null).toBe(visible);
  expect(/\bmb-4\b/.test(block?.className ?? "")).toBe(visible);
}

describe("MessageWindow meta-row stability", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("hides assistant meta while the stream-start part is still active", () => {
    // Stream-start rows are often already marked as the last part; wait for the
    // part to settle so the meta row does not flash in and then tear out.
    const { container } = renderAssistantWindow({
      isStreaming: true,
      isLastPartOfMessage: true,
      isPartial: false,
    });

    expectAssistantMeta(container, false);
  });

  test("hides assistant meta when another part displaces the current part", () => {
    const { container } = renderAssistantWindow({
      isStreaming: false,
      isLastPartOfMessage: false,
      isPartial: false,
    });

    expectAssistantMeta(container, false);
  });

  test("shows assistant meta only when the last part has settled", () => {
    const { container } = renderAssistantWindow({
      isStreaming: false,
      isLastPartOfMessage: true,
      isPartial: false,
    });

    expectAssistantMeta(container, true);
  });

  test("treats interrupted parts as not-settled even with isLastPartOfMessage", () => {
    const { container } = renderAssistantWindow({
      isStreaming: false,
      isLastPartOfMessage: true,
      isPartial: true,
    });

    expectAssistantMeta(container, false);
  });

  test("user messages keep the meta row regardless of part flags", () => {
    // The meta row on user messages carries edit affordances and should stay
    // visible; the new gate explicitly preserves variant === "user" behavior.
    const userMessage = {
      id: "user-1",
      role: "user",
      historySequence: 1,
      parts: [],
      metadata: {},
    } as unknown as MuxMessage;

    const { container } = render(
      <MessageWindow label={null} message={userMessage} variant="user">
        <div>hello</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block?.querySelector("[data-message-meta]")).not.toBeNull();
  });
});
