import { createRequire } from "node:module";
import type sharp from "sharp";
import {
  MCP_ICON_LIMITS,
  MCP_ICON_PNG_PREFIX,
  MCP_ICON_PNG_SIGNATURE,
} from "@/common/constants/mcpIcon";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import { isPngDataUrl, isStrictBase64 } from "@/common/utils/mcp/pngDataUrl";
import { sanitizeMcpIconSvg } from "@/node/services/mcpIconSvg";

function sniff(bytes: Buffer): string | null {
  if (MCP_ICON_PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (/^\uFEFF?\s*<(?:\?xml\b|svg\b)/.test(bytes.toString("utf8"))) return "image/svg+xml";
  return null;
}

async function decode(message: unknown): Promise<string | null> {
  if (
    typeof message !== "object" ||
    message === null ||
    !("base64" in message) ||
    typeof message.base64 !== "string" ||
    message.base64.length > MCP_IDENTITY_LIMITS.iconDataSrcMaxChars ||
    !isStrictBase64(message.base64) ||
    !("mimeTypes" in message) ||
    !Array.isArray(message.mimeTypes) ||
    message.mimeTypes.length > 3 ||
    !message.mimeTypes.every(
      (mime): mime is string => typeof mime === "string" && mime.length <= 128
    )
  )
    return null;
  let bytes = Buffer.from(message.base64, "base64");
  if (bytes.length === 0 || bytes.length > MCP_ICON_LIMITS.bodyMaxBytes) return null;
  const mime = sniff(bytes);
  if (
    !mime ||
    message.mimeTypes.some((type) => {
      const declared = type.split(";")[0].trim().toLowerCase();
      return declared.startsWith("image/") && declared !== mime;
    })
  )
    return null;
  if (mime === "image/svg+xml") {
    const svg = sanitizeMcpIconSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (svg === null) return null;
    bytes = Buffer.from(svg, "utf8");
  }
  // The worker is disposable; native loading and all filtering stay inside its
  // parent-enforced lifetime. createRequire keeps sharp external in bundles.
  const image = createRequire(__filename)("sharp") as typeof sharp;
  const pipeline = image(bytes, {
    limitInputPixels: MCP_ICON_LIMITS.inputMaxPixels,
    pages: 1,
    failOn: "error",
  });
  const png = await pipeline
    .timeout({ seconds: MCP_ICON_LIMITS.decodeTimeoutSeconds })
    .resize(MCP_ICON_LIMITS.outputSize, MCP_ICON_LIMITS.outputSize, { fit: "inside" })
    .png()
    .toBuffer();
  if (png.length > MCP_ICON_LIMITS.pngMaxBytes) return null;
  const dataUrl = MCP_ICON_PNG_PREFIX + png.toString("base64");
  return isPngDataUrl(dataUrl) ? dataUrl : null;
}

function reply(result: string | null): void {
  if (!process.send) process.exit(1);
  process.send(result, undefined, undefined, (error) => process.exit(error ? 1 : 0));
}

// One IPC request per child. Errors expose neither source bytes nor URLs/logs.
process.once("message", (message: unknown) => {
  decode(message).then(reply, () => reply(null));
});
