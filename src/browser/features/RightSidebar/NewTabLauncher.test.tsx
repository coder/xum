import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import { NewTabLauncher } from "./NewTabLauncher";

const board = (type: McpAppEntrypoint["type"]): McpAppEntrypoint => ({
  serverName: "cad",
  serverLabel: "cad",
  toolName: "cad.board",
  title: "Board",
  resourceUri: "ui://cad/board",
  type,
  viewKey: `entrypoint:cad:cad.board:${type}`,
});

function renderLauncher(
  entrypoints: readonly McpAppEntrypoint[],
  onOpenEntrypoint: (
    entrypoint: McpAppEntrypoint,
    isCurrent: () => boolean
  ) => Promise<string | null>
) {
  return render(
    <TooltipProvider>
      <NewTabLauncher
        tools={[]}
        onOpenTool={() => undefined}
        onOpenTerminal={() => undefined}
        creatingSideChat={false}
        autoFocus={false}
        onAutoFocusConsumed={() => undefined}
        entrypoints={entrypoints}
        onOpenEntrypoint={onOpenEntrypoint}
      />
    </TooltipProvider>
  );
}

describe("NewTabLauncher plugin views", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a pending open goes stale once another row is picked or the launcher goes away", () => {
    const pending: Array<() => boolean> = [];
    const open = (_entrypoint: McpAppEntrypoint, isCurrent: () => boolean) => {
      pending.push(isCurrent);
      return new Promise<string | null>(() => undefined);
    };
    const first = renderLauncher([board("global")], open);
    fireEvent.click(first.getByRole("button", { name: "Board" }));
    expect(pending[0]()).toBe(true);
    // Other rows stay usable while the open runs; picking one supersedes it.
    const terminal = first.getByRole("button", { name: "Terminal" });
    expect(terminal.hasAttribute("disabled")).toBe(false);
    fireEvent.click(terminal);
    expect(pending[0]()).toBe(false);
    first.unmount();

    const second = renderLauncher([board("global")], open);
    fireEvent.click(second.getByRole("button", { name: "Board" }));
    expect(pending[1]()).toBe(true);
    act(() => second.unmount());
    expect(pending[1]()).toBe(false);
  });

  test("a tool's global and thread entry points read differently", () => {
    const view = renderLauncher([board("global"), board("thread")], () => Promise.resolve(null));
    // The row's accessible description (aria-describedby); its name is the title for both.
    const descriptions = view
      .getAllByRole("button", { name: "Board" })
      .map(
        (row) => document.getElementById(row.getAttribute("aria-describedby") ?? "")?.textContent
      );
    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).not.toBe(descriptions[1]);
    // The server label leads, so it is what a narrow row keeps before the ellipsis.
    expect(descriptions.every((text) => text?.startsWith("cad"))).toBe(true);
  });
});
