/**
 * Header-only facts of a raster logo (PNG, JPEG, WebP), read without decoding: the decoded
 * size bounds what Chromium allocates when Settings renders the data URL, and animation is
 * refused (no unrequested UI animation). Returns an error message, or null when the image is
 * acceptable. A format this parser cannot read is refused, never guessed.
 */

/** OpenAI's raster asset limit (submission guide, icons and screenshots). */
export const LOGO_MAX_DIMENSION = 4096;
/** Decoded pixel budget: a 4096×4096 RGBA image is ~64 MB; keep it to ~16 M pixels. */
export const LOGO_MAX_PIXELS = 16_000_000;

interface ImageInfo {
  width: number;
  height: number;
  animated: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngInfo(bytes: Buffer): ImageInfo | string {
  // Signature, then the IHDR chunk first: length(4) "IHDR" width(4) height(4).
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return "it is not a PNG image";
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return "its PNG header is missing";
  // APNG: an acTL chunk before the first IDAT marks an animation.
  let animated = false;
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") animated = true;
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), animated };
}

function jpegInfo(bytes: Buffer): ImageInfo | string {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return "it is not a JPEG image";
  // Walk the marker segments to the first SOF (C0–CF except C4 DHT, C8 JPG, CC DAC).
  for (let offset = 2; offset + 4 <= bytes.length; ) {
    if (bytes[offset] !== 0xff) return "its JPEG markers are malformed";
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // Fill byte.
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before any SOF.
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (offset + 9 > bytes.length) break;
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        animated: false,
      };
    }
    offset += 2 + length;
  }
  return "its JPEG size is missing";
}

/**
 * Whether a RIFF/WEBP file has a chunk with this FourCC. Walks the chunk headers (FourCC,
 * 32-bit little-endian size, data padded to an even length), so the bytes of another chunk's
 * data (an XMP packet that mentions "ANIMATION") never count as a header.
 */
function hasRiffChunk(bytes: Buffer, fourCC: string): boolean {
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    if (bytes.toString("latin1", offset, offset + 4) === fourCC) return true;
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return false;
}

function webpInfo(bytes: Buffer): ImageInfo | string {
  if (
    bytes.length < 30 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  )
    return "it is not a WebP image";
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    // Flags byte: bit 1 (0x02) is the animation flag. Canvas size is 24-bit, minus one.
    const animatedFlag = (bytes[20] & 0x02) !== 0;
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    // A real ANIM chunk also marks an animation (a writer that forgot the flag).
    return { width, height, animated: animatedFlag || hasRiffChunk(bytes, "ANIM") };
  }
  if (chunk === "VP8 ") {
    // Keyframe start code 9d 01 2a, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return "its WebP header is malformed";
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      animated: false,
    };
  }
  if (chunk === "VP8L") {
    // Signature 0x2f, then 14-bit width-1 and height-1, little-endian bit packed.
    if (bytes[20] !== 0x2f) return "its WebP header is malformed";
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), animated: false };
  }
  return "its WebP format is not supported";
}

export function checkLogoImage(bytes: Buffer, mime: string): string | null {
  const info =
    mime === "image/png"
      ? pngInfo(bytes)
      : mime === "image/jpeg"
        ? jpegInfo(bytes)
        : mime === "image/webp"
          ? webpInfo(bytes)
          : `${mime} is not a supported logo type`;
  if (typeof info === "string") return info;
  if (info.animated) return "animated images are not supported";
  if (
    info.width === 0 ||
    info.height === 0 ||
    info.width > LOGO_MAX_DIMENSION ||
    info.height > LOGO_MAX_DIMENSION ||
    info.width * info.height > LOGO_MAX_PIXELS
  )
    return `it is ${info.width}×${info.height}; the limit is ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} and ${LOGO_MAX_PIXELS} pixels`;
  return null;
}
