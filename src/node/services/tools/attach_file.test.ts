import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as path from "path";
import sharp from "sharp";
import { MAX_IMAGE_DIMENSION, MAX_SVG_TEXT_CHARS } from "@/common/constants/imageAttachments";
import type { AttachFileToolResult } from "@/common/types/tools";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/readAttachmentFromPath";
import { createAttachFileTool } from "./attach_file";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function createTestAttachFileTool(cwd: string) {
  return createAttachFileTool(createTestToolConfig(cwd));
}

async function createTestPngBytes(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

function expectSuccessfulAttachFileResult(
  result: AttachFileToolResult
): Extract<AttachFileToolResult, { type: "content" }> {
  if (
    typeof result !== "object" ||
    result === null ||
    !("type" in result) ||
    result.type !== "content"
  ) {
    throw new Error(`Expected attach_file success result, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("attach_file tool", () => {
  it("attaches a relative PNG path inside the workspace", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(workspaceDir.path, "fixtures", "screenshot.png");
    const pngBytes = await createTestPngBytes();
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "fixtures/screenshot.png" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: screenshot.png]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "screenshot.png",
    });
  });

  it("resizes oversized raster images before attaching them", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(workspaceDir.path, "fixtures", "oversized.png");
    const pngBytes = await sharp({
      create: {
        width: 9001,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "fixtures/oversized.png" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[1]).toMatchObject({
      type: "media",
      mediaType: "image/png",
      filename: "oversized.png",
    });
    if (result.value[1]?.type !== "media") {
      throw new Error("Expected a media part for resized image attachment");
    }

    const metadata = await sharp(Buffer.from(result.value[1].data, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(result.value[1].data).not.toBe(pngBytes.toString("base64"));
  });

  it("preserves EXIF orientation when resizing oversized JPEGs", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const jpegPath = path.join(workspaceDir.path, "fixtures", "rotated.jpg");
    const jpegBytes = await sharp({
      create: {
        width: 10,
        height: 9001,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await fs.mkdir(path.dirname(jpegPath), { recursive: true });
    await fs.writeFile(jpegPath, jpegBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "fixtures/rotated.jpg" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[1]).toMatchObject({
      type: "media",
      mediaType: "image/jpeg",
      filename: "rotated.jpg",
    });
    if (result.value[1]?.type !== "media") {
      throw new Error("Expected a media part for rotated image attachment");
    }

    const metadata = await sharp(Buffer.from(result.value[1].data, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(metadata.orientation == null || metadata.orientation === 1).toBe(true);
  });

  it("attaches an absolute PNG path outside the workspace", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    using externalDir = new TestTempDir("attach-file-external");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(externalDir.path, "outside.png");
    const pngBytes = await createTestPngBytes();
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: pngPath }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "outside.png",
    });
  });

  it("attaches an absolute PDF path and preserves explicit overrides", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    using externalDir = new TestTempDir("attach-file-external");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pdfPath = path.join(externalDir.path, "report.bin");
    const pdfBytes = Buffer.from("%PDF-1.7\nhello\n");
    await fs.writeFile(pdfPath, pdfBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        {
          path: pdfPath,
          mediaType: "application/pdf; charset=utf-8",
          filename: "Quarterly Report.pdf",
        },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: Quarterly Report.pdf]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pdfBytes.toString("base64"),
      mediaType: "application/pdf",
      filename: "Quarterly Report.pdf",
    });
  });

  it("infers media type from the source path when filename override has no extension", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(workspaceDir.path, "chart.png");
    const pngBytes = await createTestPngBytes();
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        {
          path: "chart.png",
          filename: "Quarterly Report",
        },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: Quarterly Report]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "Quarterly Report",
    });
  });

  it("rejects a missing file", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);

    const result = (await tool.execute!(
      { path: "missing.png" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `File not found: ${path.join(workspaceDir.path, "missing.png")}`,
    });
  });

  it("rejects a directory", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const dirPath = path.join(workspaceDir.path, "screenshots");
    await fs.mkdir(dirPath, { recursive: true });

    const result = (await tool.execute!(
      { path: dirPath },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `Path is a directory, not a file: ${dirPath}`,
    });
  });

  it("shows an unsupported file to the user without attaching it to the model", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const webmPath = path.join(workspaceDir.path, "clip.webm");
    const webmBytes = Buffer.from("webm bytes");
    await fs.writeFile(webmPath, webmBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "clip.webm" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[0].type).toBe("text");
    if (result.value[0].type !== "text") {
      throw new Error("Expected display-only status text");
    }
    expect(result.value[0].text).toContain("clip.webm");
    expect(result.value[1]).toEqual({
      type: "display_file",
      data: webmBytes.toString("base64"),
      mediaType: "video/webm",
      filename: "clip.webm",
      providerOptions: { mux: { displayOnly: true, size: webmBytes.length } },
    });
  });

  it("shows markdown files to the user without attaching them to the model", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const markdownPath = path.join(workspaceDir.path, "release-notes.md");
    const markdown = "# Release Notes\n\n- Added preview/download support.\n";
    await fs.writeFile(markdownPath, markdown);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "release-notes.md" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[0].type).toBe("text");
    if (result.value[0].type !== "text") {
      throw new Error("Expected display-only status text");
    }
    expect(result.value[0].text).toContain("release-notes.md (text/markdown)");
    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(markdown).toString("base64"),
      mediaType: "text/markdown",
      filename: "release-notes.md",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(markdown) } },
    });
  });

  it("allows a markdown media type override for generated files with ambiguous extensions", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const markdownPath = path.join(workspaceDir.path, "release-notes.out");
    const markdown = "# Release Notes\n";
    await fs.writeFile(markdownPath, markdown);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "release-notes.out", mediaType: "text/markdown; charset=utf-8" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(markdown).toString("base64"),
      mediaType: "text/markdown",
      filename: "release-notes.out",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(markdown) } },
    });
  });

  it("shows text files to the user as display-only text/plain", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const textPath = path.join(workspaceDir.path, "notes.txt");
    const text = "hello";
    await fs.writeFile(textPath, text);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "notes.txt" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(text).toString("base64"),
      mediaType: "text/plain",
      filename: "notes.txt",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(text) } },
    });
  });

  it("shows unmapped source files to the user as display-only text/plain", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const sourcePath = path.join(workspaceDir.path, "script.py");
    const source = "print('hello')\n";
    await fs.writeFile(sourcePath, source);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "script.py" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(source).toString("base64"),
      mediaType: "text/plain",
      filename: "script.py",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(source) } },
    });
  });

  it("shows a diff file to the user as display-only text/plain", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const diffPath = path.join(workspaceDir.path, "changes.diff");
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    await fs.writeFile(diffPath, diff);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "changes.diff" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(diff).toString("base64"),
      mediaType: "text/plain",
      filename: "changes.diff",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(diff) } },
    });
  });

  it("shows extensionless text files to the user as display-only text/plain", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const makefilePath = path.join(workspaceDir.path, "Makefile");
    const makefile = "all:\n\techo hello\n";
    await fs.writeFile(makefilePath, makefile);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "Makefile" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: Buffer.from(makefile).toString("base64"),
      mediaType: "text/plain",
      filename: "Makefile",
      providerOptions: { mux: { displayOnly: true, size: Buffer.byteLength(makefile) } },
    });
  });

  it("shows an unmapped binary file with the octet-stream fallback", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const zipPath = path.join(workspaceDir.path, "bundle.zip");
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    await fs.writeFile(zipPath, zipBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: "bundle.zip" }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "display_file",
      data: zipBytes.toString("base64"),
      mediaType: "application/octet-stream",
      filename: "bundle.zip",
      providerOptions: { mux: { displayOnly: true, size: zipBytes.length } },
    });
  });

  it("rejects oversized display-only files with the size cap message", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const largePath = path.join(workspaceDir.path, "huge.webm");
    await fs.writeFile(largePath, Buffer.alloc(MAX_ATTACH_FILE_SIZE_BYTES + 1, 0x61));

    const result = (await tool.execute!(
      { path: "huge.webm" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: "Attachment is too large (10.00MB). The maximum supported size is 10.00MB.",
    });
  });

  it("rejects files over the size cap", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const largePath = path.join(workspaceDir.path, "huge.pdf");
    await fs.writeFile(largePath, Buffer.alloc(MAX_ATTACH_FILE_SIZE_BYTES + 1, 0x61));

    const result = (await tool.execute!(
      { path: "huge.pdf" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: "Attachment is too large (10.00MB). The maximum supported size is 10.00MB.",
    });
  });

  it("rejects oversized SVG text", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const svgPath = path.join(workspaceDir.path, "diagram.svg");
    await fs.writeFile(svgPath, `<svg>${"a".repeat(MAX_SVG_TEXT_CHARS + 1)}</svg>`);

    const result = (await tool.execute!(
      { path: "diagram.svg" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${(MAX_SVG_TEXT_CHARS + 12).toLocaleString()}).`,
    });
  });
});
