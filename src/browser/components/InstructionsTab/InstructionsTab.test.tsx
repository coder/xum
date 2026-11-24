// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createTestApiClient } from "@/browser/testUtils";
import type { InstructionFile, WorkspaceInstructions } from "@/common/types/instructions";
import { InstructionsTab } from "./InstructionsTab";

const AGENTS_MD =
  "---\ndescription: repo rules\n---\n# Repo rules\n\n- run the tests\n- keep diffs small\n";

function instructions(file: InstructionFile): WorkspaceInstructions {
  return {
    workspaceId: "ws-1",
    model: null,
    additionalSystemContext: { content: "", enabled: true },
    sources: {
      global: [],
      context: [
        { scope: "workspace", directory: "/repo", files: [file], combinedContent: file.content },
      ],
    },
    files: [file],
    totalTokens: null,
  };
}

function renderTab() {
  const file: InstructionFile = {
    path: "/repo/AGENTS.md",
    filename: "AGENTS.md",
    isLocal: false,
    xumOnly: false,
    scope: "workspace",
    content: AGENTS_MD,
    bytes: AGENTS_MD.length,
  };
  const client = createTestApiClient({
    workspace: {
      getInstructions: () => Promise.resolve(instructions(file)),
      getAdditionalSystemContext: () => Promise.resolve({ content: "", enabled: true }),
    },
  });
  return render(
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={client}>
        <TooltipProvider>
          <InstructionsTab workspaceId="ws-1" />
        </TooltipProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

describe("InstructionsTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("an expanded file renders as Markdown while the collapsed preview stays plain text", async () => {
    const { findByRole, queryByRole, container } = renderTab();

    const row = await findByRole("button", { expanded: false });
    expect(queryByRole("heading", { name: "Repo rules" })).toBeNull();
    expect(container.textContent).toContain("description: repo rules");

    fireEvent.click(row);
    expect((await findByRole("heading", { name: "Repo rules" })).tagName).toBe("H1");
    await waitFor(() => {
      expect(container.querySelector('[data-code-language="yaml"]')?.textContent).toContain(
        "description: repo rules"
      );
    });
    expect(container.querySelector("h2")).toBeNull();
  });
});
