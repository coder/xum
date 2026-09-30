import { describe, expect, it } from "@jest/globals";
import type { MuxMessage } from "@/common/types/message";
import { convertDataUriFilePartsForSdk } from "./convertDataUriFilePartsForSdk";

describe("convertDataUriFilePartsForSdk", () => {
  it("keeps base64 data URI file parts as canonical data URLs", () => {
    const base64 = Buffer.from("png-bytes", "utf8").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            url: `data:image/png;base64,${base64}`,
          },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);

    expect(converted).not.toBe(input);
    const filePart = converted[0].parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      // AI SDK 7 requires FileUIPart.url to parse as a real URL; raw base64 throws.
      expect(filePart.url).toBe(`data:image/png;base64,${base64}`);
      expect(() => new URL(filePart.url)).not.toThrow();
    }
  });

  it("returns the original array when there are no data URI file parts", () => {
    const input: MuxMessage[] = [
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", url: "https://example.com/image.png" },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    expect(converted).toBe(input);
  });

  it("does not rewrite assistant messages", () => {
    const base64 = Buffer.from("assistant", "utf8").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${base64}` }],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    expect(converted).toBe(input);
  });

  it("converts multiple user file parts and keeps non-data URLs unchanged", () => {
    const pngBase64 = Buffer.from("png", "utf8").toString("base64");
    const pdfBase64 = Buffer.from("pdf", "utf8").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "u3",
        role: "user",
        parts: [
          { type: "text", text: "files" },
          { type: "file", mediaType: "image/png", url: `data:image/png;base64,${pngBase64}` },
          {
            type: "file",
            mediaType: "application/pdf",
            url: `data:application/pdf;base64,${pdfBase64}`,
          },
          { type: "file", mediaType: "image/jpeg", url: "https://example.com/photo.jpg" },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    const convertedFileParts = converted[0].parts.filter((part) => part.type === "file");

    expect(convertedFileParts).toHaveLength(3);
    expect(convertedFileParts[0].url).toBe(`data:image/png;base64,${pngBase64}`);
    expect(convertedFileParts[1].url).toBe(`data:application/pdf;base64,${pdfBase64}`);
    expect(convertedFileParts[2].url).toBe("https://example.com/photo.jpg");
  });

  it("converts URL-encoded SVG data URIs to base64", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>';
    const encodedSvg = encodeURIComponent(svg);

    const input: MuxMessage[] = [
      {
        id: "u4",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/svg+xml",
            url: `data:image/svg+xml,${encodedSvg}`,
          },
        ],
      },
    ];

    const converted = convertDataUriFilePartsForSdk(input);
    const filePart = converted[0].parts[0];

    expect(filePart.type).toBe("file");
    if (filePart.type === "file") {
      expect(filePart.mediaType).toBe("image/svg+xml");
      const svgBase64 = Buffer.from(svg, "utf8").toString("base64");
      expect(filePart.url).toBe(`data:image/svg+xml;base64,${svgBase64}`);
    }
  });

  it("throws for malformed data URIs missing a comma separator", () => {
    const input: MuxMessage[] = [
      {
        id: "u5",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64not-a-valid-data-url",
          },
        ],
      },
    ];

    expect(() => convertDataUriFilePartsForSdk(input)).toThrow(
      "Malformed data URI in file part: missing comma"
    );
  });
});
