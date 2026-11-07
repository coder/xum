import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type { DisplayStagedAttachment } from "@/browser/features/ChatInput/stagedAttachments";
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

  // buildStagedAttachmentNotice embeds the filename in the message the model receives, so a payload
  // spelled in tag characters there is provider-visible while the chip draws nothing. The chip reveals
  // it without the download ever seeing the mark: the mark is not a file name.
  test("reveals a tag payload in an attachment's drawn name and still hands the raw one to download", () => {
    const tagRun = (ascii: string) =>
      [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");
    const attachment: StagedChatAttachment = {
      ...STAGED_ATTACHMENT,
      filename: `notes${tagRun("ab")}.md`,
    };
    const downloads: DisplayStagedAttachment[] = [];

    const view = render(
      <UserMessageContent
        content={appendStagedAttachmentNotice("Inspect these notes.", [attachment])}
        variant="sent"
        onDownloadStagedAttachment={(item) => downloads.push(item)}
      />
    );

    const chip = view.getByRole("button", { name: /download notes/i });
    expect(chip.textContent).toContain("notes<U+E0061><U+E0062>.md");
    expect(view.container.textContent).not.toContain(tagRun("ab"));

    fireEvent.click(chip);
    expect(downloads[0]?.filename).toBe(attachment.filename);
  });

  // A filePart's name is model-visible the same way, and the download name on desktop is read from
  // part.filename, so only the drawn label may carry the mark.
  test("reveals a tag payload in a filePart's drawn name", () => {
    const tagRun = (ascii: string) =>
      [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

    const view = render(
      <UserMessageContent
        content="See the report."
        variant="sent"
        fileParts={[
          {
            url: "data:application/pdf;base64,AAAA",
            mediaType: "application/pdf",
            filename: `report${tagRun("cd")}.pdf`,
          },
        ]}
      />
    );

    expect(view.getByRole("link").textContent).toContain("report<U+E0063><U+E0064>.pdf");
    expect(view.container.textContent).not.toContain(tagRun("cd"));
  });
});
