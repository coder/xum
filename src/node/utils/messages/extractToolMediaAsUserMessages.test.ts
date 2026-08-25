import { describe, expect, it } from "@jest/globals";
import sharp from "sharp";
import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import type { MuxMessage } from "@/common/types/message";
import { expectContentOutputValue } from "./testToolOutputHelpers";
import { extractToolMediaAsUserMessages } from "./extractToolMediaAsUserMessages";

describe("extractToolMediaAsUserMessages", () => {
  it("rewrites attach_file image output into a synthetic user file part", async () => {
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "attach_file",
            input: { path: "fixtures/screenshot.png" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: screenshot.png]" },
                {
                  type: "media",
                  mediaType: "image/png",
                  data: base64,
                  filename: "screenshot.png",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const rewrittenAssistant = rewritten[0];
    expect(rewrittenAssistant.role).toBe("assistant");

    const toolPart = rewrittenAssistant.parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputText = JSON.stringify(toolPart.output);
      expect(outputText).toContain("[Attachment attached:");
      expect(outputText).not.toMatch(/[A]{1000,}/);
    }

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(syntheticUser.metadata?.synthetic).toBe(true);
    expect(syntheticUser.parts[0]).toEqual({
      type: "text",
      text: "[Attached 1 attachment(s) from tool output]",
    });

    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.filename).toBe("screenshot.png");
      expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);
      expect(filePart.url).toContain(base64.slice(0, 100));
    }
  });

  it("extracts media from nested bridged tool records inside code_execution output", async () => {
    // Exclusive PTC: bridged MCP tools run nested inside code_execution and
    // their full results land in the classic record's toolCalls. Media there
    // must become a model-visible attachment (with a placeholder in the
    // record) instead of riding as raw base64 JSON text.
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "ce1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "return xum.mcp__shots__take({});" },
            state: "output-available",
            output: {
              success: true,
              toolCalls: [
                {
                  toolName: "mcp__shots__take",
                  args: {},
                  result: {
                    type: "content",
                    value: [
                      { type: "text", text: "took a screenshot" },
                      { type: "media", mediaType: "image/png", data: base64 },
                    ],
                  },
                },
                // Kernel-compacted / error records carry no extractable result.
                { toolName: "bash", args: { script: "true" }, ok: true, bytes: 4 },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).toContain("[Attachment attached:");
    expect(outputText).not.toContain(base64);
    // Untouched sibling records survive the rewrite.
    expect(outputText).toContain('"bytes":4');

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    if (filePart?.type !== "file") {
      throw new Error("Expected a synthetic file part for nested tool media");
    }
    expect(filePart.mediaType).toBe("image/png");
    expect(filePart.url).toContain(base64.slice(0, 100));
  });

  it("dedupes media returned from code_execution (record + outer result carry the same payload)", async () => {
    // `return xum.<mediaTool>(...)` duplicates the media container in the
    // nested record AND the outer result; both copies must be replaced, and
    // the model should receive a single attachment.
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const mediaContainer = {
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    };
    const input: MuxMessage[] = [
      {
        id: "ce2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "return xum.mcp__shots__take({});" },
            state: "output-available",
            output: {
              success: true,
              result: mediaContainer,
              toolCalls: [{ toolName: "mcp__shots__take", args: {}, result: mediaContainer }],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    // Both copies replaced — no base64 rides as JSON text anywhere.
    expect(JSON.stringify(toolPart.output)).not.toContain(base64);

    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
    expect(syntheticUser.parts[0]).toEqual({
      type: "text",
      text: "[Attached 1 attachment(s) from tool output]",
    });
  });

  it("self-heals oversized raster tool attachments by downscaling them for provider requests", async () => {
    const oversizedPng = await sharp({
      create: {
        width: 9001,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const base64 = oversizedPng.toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a1-resize",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "attach_file",
            input: { path: "fixtures/oversized.png" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: oversized.png]" },
                {
                  type: "media",
                  mediaType: "image/png",
                  data: base64,
                  filename: "oversized.png",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type !== "file") {
      throw new Error("Expected a synthetic file part for resized tool attachment");
    }

    expect(filePart.mediaType).toBe("image/png");
    const resizedBase64 = filePart.url.replace(/^data:image\/png;base64,/, "");
    const metadata = await sharp(Buffer.from(resizedBase64, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(resizedBase64).not.toBe(base64);
  });

  it("rewrites attach_file PDF output into a synthetic user file part", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call2",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: report.pdf]" },
                {
                  type: "media",
                  mediaType: "application/pdf",
                  data: base64,
                  filename: "report.pdf",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 2 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("application/pdf");
      expect(filePart.filename).toBe("report pdf");
      expect(filePart.url).toBe(`data:application/pdf;base64,${base64}`);
    }
  });

  it("sanitizes extracted PDF filenames in synthetic user file parts", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a3",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call3",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: report.pdf]" },
                {
                  type: "media",
                  mediaType: "application/pdf",
                  data: base64,
                  filename: "report.pdf",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 3 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.filename).toBe("report pdf");
    }
  });

  it("inlines extracted SVG attachments as text instead of synthetic file parts", async () => {
    const base64 = Buffer.from('<svg><rect width="10" height="10"/></svg>', "utf8").toString(
      "base64"
    );

    const input: MuxMessage[] = [
      {
        id: "a4",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call4",
            toolName: "attach_file",
            input: { path: "/tmp/diagram.svg" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: diagram.svg]" },
                {
                  type: "media",
                  mediaType: "image/svg+xml",
                  data: base64,
                  filename: "diagram.svg",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 4 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.parts.some((part) => part.type === "file")).toBe(false);
    const svgTextPart = syntheticUser.parts.find(
      (part) => part.type === "text" && part.text.includes("[SVG attachment converted to text")
    );
    expect(svgTextPart).toBeDefined();
  });

  it("strips display-only file bytes without creating a model attachment", async () => {
    const base64 = Buffer.from("webm bytes").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a5",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call5",
            toolName: "attach_file",
            input: { path: "/tmp/clip.webm" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[File shown to user: clip.webm]" },
                {
                  type: "display_file",
                  mediaType: "video/webm",
                  data: base64,
                  filename: "clip.webm",
                  providerOptions: { mux: { displayOnly: true, size: 10 } },
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 5 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected rewritten output-available tool part");
    }

    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
    const rewrittenValue = expectContentOutputValue(toolPart.output);
    const textParts = rewrittenValue.filter((part) => (part as { type?: unknown }).type === "text");
    expect(textParts).toHaveLength(2);
    expect(JSON.stringify(textParts)).toContain("clip.webm");
    expect(
      rewrittenValue.some((part) => (part as { type?: unknown }).type === "display_file")
    ).toBe(false);
  });

  it("strips display-only file bytes even when metadata is missing", async () => {
    const base64 = Buffer.from("webm bytes").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a6",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call6",
            toolName: "attach_file",
            input: { path: "/tmp/corrupt.webm" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[File shown to user: corrupt.webm]" },
                {
                  type: "display_file",
                  mediaType: "video/webm",
                  data: base64,
                  filename: "corrupt.webm",
                },
              ],
            },
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected rewritten output-available tool part");
    }

    const rewrittenValue = expectContentOutputValue(toolPart.output);
    const textParts = rewrittenValue.filter((part) => (part as { type?: unknown }).type === "text");
    expect(textParts).toHaveLength(2);
    expect(JSON.stringify(textParts)).toContain("corrupt.webm");
    expect(
      rewrittenValue.some((part) => (part as { type?: unknown }).type === "display_file")
    ).toBe(false);

    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
  });

  it("does not rewrite unrelated tool outputs", async () => {
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "bash",
            input: { script: "pwd" },
            state: "output-available",
            output: { type: "json", value: { stdout: "/tmp" } },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toBe(input);
  });
});
