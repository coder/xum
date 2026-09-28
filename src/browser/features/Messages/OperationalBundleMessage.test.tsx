import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { computeOperationalBundleInfos } from "@/browser/utils/messages/transcriptRenderProjection";
import { OperationalBundleMessage } from "./OperationalBundleMessage";

function tool(id: string): DisplayedMessage & { type: "tool" } {
  return {
    type: "tool",
    id,
    historyId: `history-${id}`,
    toolCallId: `call-${id}`,
    toolName: "file_read",
    args: {},
    status: "completed",
    isPartial: false,
    historySequence: 1,
  };
}

const noop = () => undefined;

describe("OperationalBundleMessage", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders summary and toggles expansion", () => {
    const item = computeOperationalBundleInfos([tool("read-1"), tool("read-2")], {
      isTurnActive: false,
    })[0]!;

    let expanded = false;
    const onToggle = () => {
      expanded = !expanded;
    };
    const view = render(
      <OperationalBundleMessage item={item} expanded={expanded} onToggle={onToggle} />
    );

    expect(view.getByRole("button", { expanded: false })).toBeDefined();
    expect(view.getByText("Ran 2 operations")).toBeDefined();

    fireEvent.click(view.getByRole("button"));
    view.rerender(<OperationalBundleMessage item={item} expanded={expanded} onToggle={onToggle} />);

    expect(view.getByRole("button", { expanded: true })).toBeDefined();
  });

  test("renders active bundle state", () => {
    const item = computeOperationalBundleInfos([{ ...tool("read-1"), status: "executing" }], {
      isTurnActive: true,
    })[0]!;

    const view = render(<OperationalBundleMessage item={item} expanded onToggle={noop} />);

    expect(view.getByText("Running 1 operation")).toBeDefined();
  });

  test("suppresses redundant singleton details", () => {
    const item = computeOperationalBundleInfos([tool("read-1")], { isTurnActive: false })[0]!;

    const view = render(<OperationalBundleMessage item={item} expanded={false} onToggle={noop} />);

    expect(view.getByRole("button").textContent).toBe("▶Read 1 file");
  });
});
