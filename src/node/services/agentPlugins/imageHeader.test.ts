import { describe, expect, test } from "bun:test";
import { checkLogoImage } from "./imageHeader";

function png(width: number, height: number, extraChunk?: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(extraChunk !== undefined ? [chunk(extraChunk, Buffer.alloc(8))] : []),
    chunk("IDAT", Buffer.alloc(4)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x00]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width: number, height: number, flags: number, anim = false): Buffer {
  const body = Buffer.alloc(18);
  body.write("VP8X", 0, "latin1");
  body.writeUInt32LE(10, 4);
  body[8] = flags;
  body.writeUIntLE(width - 1, 12, 3);
  body.writeUIntLE(height - 1, 15, 3);
  const rest = anim
    ? Buffer.from("ANIM\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")
    : Buffer.alloc(0);
  return Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1"), body, rest]);
}

/** A VP8X WebP followed by these extra chunks (FourCC, data); odd sizes are padded. */
function webpWithChunks(chunks: Array<[string, string]>): Buffer {
  const parts = chunks.map(([fourCC, data]) => {
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, "latin1");
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, Buffer.from(data, "latin1"), Buffer.alloc(data.length % 2)]);
  });
  return Buffer.concat([webpVp8x(64, 64, 0), ...parts]);
}

function webpVp8l(width: number, height: number): Buffer {
  const head = Buffer.alloc(30);
  head.write("RIFF", 0, "latin1");
  head.write("WEBP", 8, "latin1");
  head.write("VP8L", 12, "latin1");
  head[20] = 0x2f;
  head.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return head;
}

describe("checkLogoImage", () => {
  test("accepts PNG, JPEG and WebP within the limits", () => {
    expect(checkLogoImage(png(512, 512), "image/png")).toBeNull();
    expect(checkLogoImage(jpeg(4096, 3906), "image/jpeg")).toBeNull();
    expect(checkLogoImage(webpVp8x(256, 256, 0), "image/webp")).toBeNull();
    expect(checkLogoImage(webpVp8l(64, 32), "image/webp")).toBeNull();
  });

  test("refuses a decoded size over 4096 per side or 16 M pixels", () => {
    // A 10000×10000 PNG compresses under the byte cap but decodes to ~400 MB.
    expect(checkLogoImage(png(10000, 10000), "image/png")).toContain("10000×10000");
    expect(checkLogoImage(png(4097, 16), "image/png")).not.toBeNull();
    expect(checkLogoImage(jpeg(16, 5000), "image/jpeg")).not.toBeNull();
    // 4096×4096 is 16.8 M pixels: within each side, over the pixel budget.
    expect(checkLogoImage(png(4096, 4096), "image/png")).not.toBeNull();
    expect(checkLogoImage(webpVp8x(8000, 10, 0), "image/webp")).not.toBeNull();
  });

  test("refuses animation: APNG, the VP8X flag, or an ANIM chunk", () => {
    expect(checkLogoImage(png(64, 64, "acTL"), "image/png")).toContain("animated");
    expect(checkLogoImage(webpVp8x(64, 64, 0x02), "image/webp")).toContain("animated");
    expect(checkLogoImage(webpVp8x(64, 64, 0, true), "image/webp")).toContain("animated");
  });

  test("only a real ANIM chunk header marks a WebP animated, not its bytes elsewhere", () => {
    // XMP metadata (odd length, padded) that mentions ANIMATION: still a static image.
    const xmp = "<x:xmpmeta><dc:subject>ANIMATION reference</dc:subject></x:xmpmeta>!?";
    expect(xmp.length % 2).toBe(1);
    expect(
      checkLogoImage(
        webpWithChunks([
          ["XMP ", xmp],
          ["VP8L", "x"],
        ]),
        "image/webp"
      )
    ).toBeNull();
    // A real ANIM chunk after the padded XMP chunk is found by walking the headers.
    expect(
      checkLogoImage(
        webpWithChunks([
          ["XMP ", xmp],
          ["ANIM", "\x00".repeat(6)],
        ]),
        "image/webp"
      )
    ).toContain("animated");
  });

  test("refuses what it cannot read, and GIF", () => {
    expect(checkLogoImage(Buffer.from("not an image"), "image/png")).not.toBeNull();
    expect(checkLogoImage(png(64, 64), "image/jpeg")).not.toBeNull();
    expect(checkLogoImage(Buffer.from("GIF89a"), "image/gif")).not.toBeNull();
  });
});
