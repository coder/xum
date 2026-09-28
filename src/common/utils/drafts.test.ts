import { describe, expect, test } from "bun:test";
import { sanitizeDraftAttachments } from "./drafts";

// Draft files and legacy localStorage values are untrusted input (hand-edited, truncated, or
// written by an older build): each malformed attachment is dropped on its own so the rest of the
// draft still loads.
describe("sanitizeDraftAttachments", () => {
  const staged = {
    kind: "staged" as const,
    id: "zip-1",
    mediaType: "application/zip",
    filename: "archive.zip",
    sizeBytes: 123,
    stagedPath: ".mux/user-attachments/id/archive.zip",
  };
  const pendingFile = {
    kind: "pending-file" as const,
    id: "pending-1",
    mediaType: "text/markdown",
    filename: "notes.md",
    sizeBytes: 8,
    dataBase64: "bWFya2Rvd24=",
  };

  test("reads legacy provider entries without a kind as provider attachments", () => {
    expect(
      sanitizeDraftAttachments([
        { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ])
    ).toEqual({
      attachments: [
        { kind: "provider", id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ],
      droppedEntries: 0,
    });
  });

  test("keeps well-formed staged and pending-file records", () => {
    expect(sanitizeDraftAttachments([staged, pendingFile])).toEqual({
      attachments: [staged, pendingFile],
      droppedEntries: 0,
    });
  });

  test("drops only the malformed staged and pending-file records", () => {
    expect(
      sanitizeDraftAttachments([
        { ...staged, sizeBytes: "123" },
        { ...pendingFile, dataBase64: 42 },
        pendingFile,
      ])
    ).toEqual({ attachments: [pendingFile], droppedEntries: 2 });
  });

  test("a non-array value is one dropped entry; a missing value is none", () => {
    expect(sanitizeDraftAttachments({})).toEqual({ attachments: [], droppedEntries: 1 });
    expect(sanitizeDraftAttachments(undefined)).toEqual({ attachments: [], droppedEntries: 0 });
  });
});
