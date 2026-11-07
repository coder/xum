import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { ChatAttachments, type ChatAttachment } from "./ChatAttachments";

const tagRun = (ascii: string) =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

describe("ChatAttachments", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // The chip shows the same name buildStagedAttachmentNotice embeds in the message for the model, so
  // a tag payload in it is provider-visible while the chip draws nothing at all.
  test("reveals a tag payload in a staged attachment's chip", () => {
    const attachment: ChatAttachment = {
      kind: "staged",
      id: "a-1",
      mediaType: "text/markdown",
      filename: `notes${tagRun("ab")}.md`,
      sizeBytes: 2048,
      stagedPath: ".mux/user-attachments/id/notes.md",
    };

    const view = render(<ChatAttachments attachments={[attachment]} />);

    expect(view.container.textContent).toContain("notes<U+E0061><U+E0062>.md");
    expect(view.container.textContent).not.toContain(tagRun("ab"));
  });
});
