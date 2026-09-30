import { describe, expect, test } from "bun:test";

import {
  getSupportedAttachmentMediaType,
  getSupportedStagedAttachmentMediaType,
} from "./supportedAttachmentMediaTypes";

describe("supportedAttachmentMediaTypes", () => {
  test("keeps images and PDFs as provider attachments", () => {
    expect(getSupportedAttachmentMediaType({ mediaType: "image/png", filename: "photo.png" })).toBe(
      "image/png"
    );
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "document.pdf" })).toBe(
      "application/pdf"
    );
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "notes.md" })).toBeNull();
  });

  test("infers common staged attachment media types from extensions", () => {
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "notes.md" })).toBe(
      "text/markdown"
    );
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "notes.txt" })).toBe(
      "text/plain"
    );
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "data.csv" })).toBe(
      "text/csv"
    );
  });

  test("falls back to application/octet-stream for unknown files", () => {
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "data.bin" })).toBe(
      "application/octet-stream"
    );
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "README" })).toBe(
      "application/octet-stream"
    );
  });

  test("normalizes provided media types and canonicalizes zip aliases", () => {
    expect(
      getSupportedStagedAttachmentMediaType({
        mediaType: " Text/Plain; Charset=UTF-8 ",
        filename: "x",
      })
    ).toBe("text/plain");
    expect(
      getSupportedStagedAttachmentMediaType({
        mediaType: "application/x-zip-compressed",
        filename: "archive",
      })
    ).toBe("application/zip");
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "archive.zip" })).toBeNull();
  });

  test("replaces unsafe media types with application/octet-stream", () => {
    expect(
      getSupportedStagedAttachmentMediaType({ mediaType: "text/`plain", filename: "notes.md" })
    ).toBe("application/octet-stream");
    expect(
      getSupportedStagedAttachmentMediaType({ mediaType: "text/(plain)", filename: "notes.md" })
    ).toBe("application/octet-stream");
    expect(
      getSupportedStagedAttachmentMediaType({ mediaType: `text/${"a".repeat(100)}`, filename: "x" })
    ).toBe("application/octet-stream");
  });
});
