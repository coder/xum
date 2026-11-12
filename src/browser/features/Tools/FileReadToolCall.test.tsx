import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";

import { FileReadToolCall } from "./FileReadToolCall";

type FileReadProps = ComponentProps<typeof FileReadToolCall>;

function renderOpenedRead(props: Partial<FileReadProps>) {
  const view = render(
    <TooltipProvider>
      <FileReadToolCall args={{ path: "src/auth/session.ts" }} status="completed" {...props} />
    </TooltipProvider>
  );
  // The collapsed row is the path alone; the summary is in the opened block.
  fireEvent.click(view.getByText("src/auth/session.ts"));
  return view;
}

/** The value next to a label of the summary line ("Path:", "Offset:", "Limit:", "Read:"). */
function summaryValue(view: ReturnType<typeof render>, label: string): string | null {
  const labelNode = view.queryByText(label);
  return labelNode?.nextElementSibling?.textContent ?? null;
}

const CONTENT = "10\tconst a = 1;\n11\tconst b = 2;";

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  saveDomGlobals();
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  restoreDomGlobals();
});

describe("FileReadToolCall summary line", () => {
  test("states the path, the requested range and how much of the file was read", () => {
    const view = renderOpenedRead({
      args: { path: "src/auth/session.ts", offset: 10, limit: 2 },
      result: {
        success: true,
        content: CONTENT,
        file_size: 4096,
        modifiedTime: "2026-01-01T00:00:00.000Z",
        lines_read: 2,
      },
    });

    expect(summaryValue(view, "Path:")).toBe("src/auth/session.ts");
    expect(summaryValue(view, "Offset:")).toBe("line 10");
    expect(summaryValue(view, "Limit:")).toBe("2 lines");
    // The bytes read are those of the content, without the line-number prefixes.
    const read = summaryValue(view, "Read:");
    expect(read).toMatch(/^\S.* of \S/);
    expect(read).not.toContain("undefined");
  });

  test("leaves out the range that was not asked for, and the size a replayed result lacks", () => {
    const view = renderOpenedRead({
      result: {
        success: true,
        content: CONTENT,
        modifiedTime: "2026-01-01T00:00:00.000Z",
        lines_read: 2,
      } as unknown as FileReadProps["result"],
    });

    expect(summaryValue(view, "Offset:")).toBeNull();
    expect(summaryValue(view, "Limit:")).toBeNull();
    const read = summaryValue(view, "Read:");
    expect(read).not.toBeNull();
    expect(read).not.toContain(" of ");
  });

  test("a failed read has no size, and shows its error", () => {
    const view = renderOpenedRead({
      status: "failed",
      result: { success: false, error: "ENOENT: no such file" },
    });

    expect(summaryValue(view, "Path:")).toBe("src/auth/session.ts");
    expect(summaryValue(view, "Read:")).toBeNull();
    expect(view.getByText("ENOENT: no such file")).toBeDefined();
  });
});
