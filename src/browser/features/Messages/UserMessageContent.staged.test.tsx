import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type { StagedChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import { installDom } from "../../../../tests/ui/dom";
import { UserMessageContent } from "./UserMessageContent";

const STAGED_ATTACHMENT: StagedChatAttachment = {
  kind: "staged",
  id: "md-1",
  filename: "notes.md",
  mediaType: "text/markdown",
  sizeBytes: 12_345,
  stagedPath: ".mux/user-attachments/id/notes.md",
};

describe("UserMessageContent staged attachment rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("hides the model-only staged attachment notice and renders a download chip", () => {
    const downloads: unknown[] = [];
    const content = appendStagedAttachmentNotice("Inspect these notes.", [STAGED_ATTACHMENT]);

    const view = render(
      <UserMessageContent
        content={content}
        variant="sent"
        onDownloadStagedAttachment={(attachment) => downloads.push(attachment)}
      />
    );

    expect(view.queryByText(/<attached-files>/)).toBeNull();
    expect(view.queryByText(/workspace filesystem/)).toBeNull();
    expect(view.getByText("Inspect these notes.")).toBeTruthy();

    const chip = view.getByRole("button", { name: /download notes\.md/i });
    expect(chip.textContent).toContain("notes.md");
    expect(chip.textContent).toContain("12.1 KB");

    fireEvent.click(chip);
    expect(downloads).toEqual([
      {
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeLabel: "12.1 KB",
        sizeBytes: 12_390,
        stagedPath: ".mux/user-attachments/id/notes.md",
      },
    ]);
  });
});
