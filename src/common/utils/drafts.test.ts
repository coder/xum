import { describe, expect, test } from "bun:test";
import { draftJsonBytes, sanitizeDraftAttachments } from "./drafts";

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

describe("draftJsonBytes", () => {
  // The limit protects byte-counting transports (the 50 MB HTTP body cap), so size is UTF-8 bytes.
  test("counts UTF-8 bytes of the JSON, including multi-byte text and surrogate pairs", () => {
    const draft = { text: "ascii é € 😀 \ud800 end", attachments: [] };
    expect(draftJsonBytes(draft)).toBe(
      Buffer.byteLength(JSON.stringify({ text: draft.text, attachments: draft.attachments }))
    );
  });

  test("counts large text exactly across chunk boundaries, surrogate pairs included", () => {
    const draft = { text: `${"é".repeat(70_000)}${"😀".repeat(70_000)}x`, attachments: [] };
    expect(draftJsonBytes(draft)).toBe(
      Buffer.byteLength(JSON.stringify({ text: draft.text, attachments: draft.attachments }))
    );
  });
});
