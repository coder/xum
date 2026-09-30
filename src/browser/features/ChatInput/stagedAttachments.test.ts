import { describe, expect, test } from "bun:test";

import {
  appendStagedAttachmentNotice,
  buildStagedAttachmentNotice,
  parseStagedAttachmentNotice,
} from "./stagedAttachments";

describe("stagedAttachments", () => {
  test("round-trips markdown and CSV staged attachments through the notice", () => {
    const notice = buildStagedAttachmentNotice([
      {
        kind: "staged",
        id: "md-1",
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 12,
        stagedPath: ".mux/user-attachments/id/notes.md",
      },
      {
        kind: "staged",
        id: "csv-1",
        filename: "data.csv",
        mediaType: "text/csv",
        sizeBytes: 34,
        stagedPath: ".mux/user-attachments/id/data.csv",
      },
    ]);

    expect(parseStagedAttachmentNotice(notice)).toEqual({
      text: "",
      attachments: [
        {
          filename: "notes.md",
          mediaType: "text/markdown",
          sizeLabel: "12 B",
          sizeBytes: 12,
          stagedPath: ".mux/user-attachments/id/notes.md",
        },
        {
          filename: "data.csv",
          mediaType: "text/csv",
          sizeLabel: "34 B",
          sizeBytes: 34,
          stagedPath: ".mux/user-attachments/id/data.csv",
        },
      ],
    });
  });

  test("allows file-only sends by returning the notice as message text", () => {
    const message = appendStagedAttachmentNotice("", [
      {
        kind: "staged",
        id: "zip-1",
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: 1,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);

    expect(message.trim()).toStartWith("<attached-files>");
  });

  test("parses staged notices into display attachments and visible text", () => {
    const message = appendStagedAttachmentNotice("Inspect this archive.", [
      {
        kind: "staged",
        id: "zip-1",
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: 12_345,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);

    expect(parseStagedAttachmentNotice(message)).toEqual({
      text: "Inspect this archive.",
      attachments: [
        {
          filename: "archive.zip",
          mediaType: "application/zip",
          sizeLabel: "12.1 KB",
          sizeBytes: 12_390,
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ],
    });
  });

  test("preserves user-authored attached-files XML that is not a staged notice", () => {
    const userText = "Please edit this XML:\n<attached-files><file>keep me</file></attached-files>";

    expect(parseStagedAttachmentNotice(userText)).toEqual({
      text: userText,
      attachments: [],
    });
  });
});
