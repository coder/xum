import { MAX_SVG_TEXT_CHARS } from "@/common/constants/imageAttachments";
import { MAX_STAGED_ATTACHMENT_SIZE_BYTES } from "@/common/constants/stagedAttachments";
import { afterAll, describe, expect, test } from "@jest/globals";

import {
  generateAttachmentId,
  fileToChatAttachment,
  extractAttachmentsFromClipboard,
  extractAttachmentsFromDrop,
  processAttachmentFiles,
  chatAttachmentsToFileParts,
} from "./attachmentsHandling";

// Mock FileReader for Node.js environment
class MockFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    // Simulate async read with setTimeout
    setTimeout(() => {
      // Create a fake base64 data URL based on the blob type
      const fakeDataUrl = `data:${blob.type};base64,ZmFrZWRhdGE=`;
      if (this.onload) {
        this.onload({ target: { result: fakeDataUrl } });
      }
    }, 0);
  }
}

// Mock Image for resizeImageIfNeeded — small dimensions mean no resize occurs.
class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;

  set src(_value: string) {
    // Fire onload asynchronously to simulate real Image loading behavior.
    setTimeout(() => {
      this.onload?.();
    }, 0);
  }
}

const originalImage = globalThis.Image;

global.FileReader = MockFileReader as unknown as typeof FileReader;
Object.defineProperty(globalThis, "Image", {
  value: MockImage,
  configurable: true,
  writable: true,
});

afterAll(() => {
  if (originalImage) {
    Object.defineProperty(globalThis, "Image", {
      value: originalImage,
      configurable: true,
      writable: true,
    });
    return;
  }

  delete (globalThis as { Image?: typeof Image }).Image;
});

describe("attachmentsHandling", () => {
  describe("generateAttachmentId", () => {
    test("generates unique IDs", () => {
      const id1 = generateAttachmentId();
      const id2 = generateAttachmentId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe("fileToChatAttachment", () => {
    test("converts a File to ImageAttachment", async () => {
      // Create a mock image file
      const blob = new Blob(["fake image data"], { type: "image/png" });
      const file = new File([blob], "test.png", { type: "image/png" });

      const attachment = await fileToChatAttachment(file);

      expect(attachment).toMatchObject({
        id: expect.stringMatching(/^\d+-[a-z0-9]+$/),
        url: expect.stringContaining("data:image/png;base64,"),
        mediaType: "image/png",
      });
    });

    test("rejects SVGs larger than MAX_SVG_TEXT_CHARS", async () => {
      const svg = `<svg>${"a".repeat(MAX_SVG_TEXT_CHARS + 1)}</svg>`;
      const file = new File([svg], "test.svg", { type: "image/svg+xml" });

      await expect(fileToChatAttachment(file)).rejects.toThrow("SVG attachments must be");
    });
    test("handles JPEG images", async () => {
      const blob = new Blob(["fake jpeg data"], { type: "image/jpeg" });
      const file = new File([blob], "test.jpg", { type: "image/jpeg" });

      const attachment = await fileToChatAttachment(file);

      expect(attachment.kind).toBe("provider");
      if (attachment.kind !== "provider") throw new Error("Expected provider attachment");
      expect(attachment.mediaType).toBe("image/jpeg");
      expect(attachment.url).toContain("data:image/jpeg;base64,");
    });
  });

  describe("extractAttachmentsFromClipboard", () => {
    test("extracts arbitrary file items without treating clipboard text as a file", () => {
      const image = new File(["image"], "test.png", { type: "image/png" });
      const text = new File(["text"], "notes.txt", { type: "text/plain" });
      const mockItems = [
        { kind: "file", getAsFile: () => image },
        { kind: "file", getAsFile: () => text },
        { kind: "string", getAsFile: () => null },
      ] as unknown as DataTransferItemList;

      expect(extractAttachmentsFromClipboard(mockItems)).toEqual([image, text]);
    });
  });

  describe("extractAttachmentsFromDrop", () => {
    test("extracts arbitrary dropped files", () => {
      const image = new File(["image"], "test.png", { type: "image/png" });
      const text = new File(["text"], "notes.txt", { type: "text/plain" });
      const binary = new File(["binary"], "data.bin", { type: "" });
      const mockDataTransfer = { files: [image, text, binary] };

      expect(extractAttachmentsFromDrop(mockDataTransfer as unknown as DataTransfer)).toEqual([
        image,
        text,
        binary,
      ]);
    });
  });

  describe("staged attachments", () => {
    test("stages arbitrary files through the provided callback", async () => {
      const file = new File(["markdown"], "notes.md", { type: "text/markdown" });

      const attachments = await processAttachmentFiles([file], {
        stageAttachment: (stagedFile, dataBase64) => {
          expect(dataBase64).toBe("bWFya2Rvd24=");
          return Promise.resolve({
            filename: stagedFile.name,
            mediaType: stagedFile.type,
            sizeBytes: stagedFile.size,
            stagedPath: `.mux/user-attachments/id/${stagedFile.name}`,
          });
        },
      });

      expect(attachments).toEqual([
        {
          kind: "staged",
          id: expect.stringMatching(/^\d+-[a-z0-9]+$/),
          filename: "notes.md",
          mediaType: "text/markdown",
          sizeBytes: 8,
          stagedPath: ".mux/user-attachments/id/notes.md",
        },
      ]);
    });

    test("rejects oversized files before reading or staging them", async () => {
      let read = false;
      let staged = false;
      const file = {
        name: "large.bin",
        type: "",
        size: MAX_STAGED_ATTACHMENT_SIZE_BYTES + 1,
        arrayBuffer: () => {
          read = true;
          return Promise.reject(new Error("should not read"));
        },
      } as unknown as File;

      await expect(
        processAttachmentFiles([file], {
          stageAttachment: () => {
            staged = true;
            return Promise.reject(new Error("should not stage"));
          },
        })
      ).rejects.toThrow("cannot be staged");
      expect(read).toBe(false);
      expect(staged).toBe(false);
    });

    test("does not convert staged attachments to provider file parts", () => {
      expect(
        chatAttachmentsToFileParts([
          {
            kind: "staged",
            id: "file-1",
            filename: "notes.md",
            mediaType: "text/markdown",
            sizeBytes: 1,
            stagedPath: ".mux/user-attachments/id/notes.md",
          },
        ])
      ).toEqual([]);
    });

    test("does not convert pending files to provider file parts", () => {
      expect(
        chatAttachmentsToFileParts([
          {
            kind: "pending-file",
            id: "file-1",
            filename: "notes.md",
            mediaType: "text/markdown",
            sizeBytes: 1,
            dataBase64: "bQ==",
          },
        ])
      ).toEqual([]);
    });
  });

  describe("pending files", () => {
    test("holds non-provider files in memory with base64 bytes and resolved media type", async () => {
      const markdown = new File(["markdown"], "notes.md", { type: "text/markdown" });
      const binary = new File(["bin"], "data.bin", { type: "" });

      const attachments = await processAttachmentFiles([markdown, binary], {
        holdNonProviderFiles: true,
      });

      expect(attachments).toEqual([
        {
          kind: "pending-file",
          id: expect.stringMatching(/^\d+-[a-z0-9]+$/),
          filename: "notes.md",
          mediaType: "text/markdown",
          sizeBytes: 8,
          dataBase64: "bWFya2Rvd24=",
        },
        {
          kind: "pending-file",
          id: expect.stringMatching(/^\d+-[a-z0-9]+$/),
          filename: "data.bin",
          mediaType: "application/octet-stream",
          sizeBytes: 3,
          dataBase64: "Ymlu",
        },
      ]);
    });

    test("routes provider-native files before the pending-file hold", async () => {
      const image = new File(["image"], "photo.png", { type: "image/png" });

      const attachments = await processAttachmentFiles([image], {
        holdNonProviderFiles: true,
      });

      expect(attachments.map((attachment) => attachment.kind)).toEqual(["provider"]);
    });

    test("prefers staging over the pending-file hold when both are configured", async () => {
      const markdown = new File(["markdown"], "notes.md", { type: "text/markdown" });

      const attachments = await processAttachmentFiles([markdown], {
        stageAttachment: (file) =>
          Promise.resolve({
            filename: file.name,
            mediaType: file.type,
            sizeBytes: file.size,
            stagedPath: `.mux/user-attachments/id/${file.name}`,
          }),
        holdNonProviderFiles: true,
      });

      expect(attachments.map((attachment) => attachment.kind)).toEqual(["staged"]);
    });

    test("rejects oversized files before holding them", async () => {
      let read = false;
      const file = {
        name: "large.bin",
        type: "",
        size: MAX_STAGED_ATTACHMENT_SIZE_BYTES + 1,
        arrayBuffer: () => {
          read = true;
          return Promise.reject(new Error("should not read"));
        },
      } as unknown as File;

      await expect(processAttachmentFiles([file], { holdNonProviderFiles: true })).rejects.toThrow(
        "cannot be staged"
      );
      expect(read).toBe(false);
    });
  });

  describe("processAttachmentFiles", () => {
    test("routes provider-native files before the staged fallback", async () => {
      const image = new File(["image"], "photo.png", { type: "image/png" });
      const pdf = new File(["pdf"], "document.pdf", { type: "application/pdf" });

      const attachments = await processAttachmentFiles([image, pdf], {
        stageAttachment: () => Promise.reject(new Error("provider file was staged")),
      });

      expect(attachments.map((attachment) => attachment.kind)).toEqual(["provider", "provider"]);
      expect(attachments.map((attachment) => attachment.mediaType)).toEqual([
        "image/png",
        "application/pdf",
      ]);
    });

    test("routes mixed arbitrary files independently", async () => {
      const image = new File(["image"], "photo.png", { type: "image/png" });
      const markdown = new File(["md"], "notes.md", { type: "text/markdown" });
      const csv = new File(["csv"], "data.csv", { type: "text/csv" });
      const binary = new File(["bin"], "data.bin", { type: "" });
      const stagedNames: string[] = [];

      const attachments = await processAttachmentFiles([image, markdown, csv, binary], {
        stageAttachment: (file) => {
          stagedNames.push(file.name);
          const mediaType = file.type || "application/octet-stream";
          return Promise.resolve({
            filename: file.name,
            mediaType,
            sizeBytes: file.size,
            stagedPath: `.mux/user-attachments/id/${file.name}`,
          });
        },
      });

      expect(attachments.map((attachment) => attachment.kind)).toEqual([
        "provider",
        "staged",
        "staged",
        "staged",
      ]);
      expect(stagedNames).toEqual(["notes.md", "data.csv", "data.bin"]);
    });

    test("handles empty array", async () => {
      expect(await processAttachmentFiles([])).toEqual([]);
    });
  });
});
