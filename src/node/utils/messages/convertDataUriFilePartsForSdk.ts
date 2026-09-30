import assert from "node:assert";
import type { MuxMessage } from "@/common/types/message";

const DATA_URI_PREFIX = "data:";

interface ParsedDataUri {
  mediaType?: string;
  base64Data: string;
}

function parseDataUriToBase64(dataUri: string): ParsedDataUri {
  assert(dataUri.toLowerCase().startsWith(DATA_URI_PREFIX), "Expected a data URI file part");

  const commaIndex = dataUri.indexOf(",");
  assert(commaIndex !== -1, "Malformed data URI in file part: missing comma");

  const metadata = dataUri.slice(DATA_URI_PREFIX.length, commaIndex);
  const payload = dataUri.slice(commaIndex + 1);

  const metadataTokens = metadata
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const mediaType = metadataTokens.find((token) => token.includes("/"));
  const hasBase64Flag = metadataTokens.some((token) => token.toLowerCase() === "base64");

  if (hasBase64Flag) {
    return {
      mediaType,
      base64Data: payload,
    };
  }

  let decodedPayload: string;
  try {
    decodedPayload = decodeURIComponent(payload);
  } catch (error) {
    assert.fail(
      `Malformed data URI in file part: invalid URL encoding (${error instanceof Error ? error.message : String(error)})`
    );
  }

  return {
    mediaType,
    base64Data: Buffer.from(decodedPayload, "utf8").toString("base64"),
  };
}

/**
 * Normalizes user file-part data URIs into canonical base64 `data:` URLs.
 *
 * AI SDK 7's convertToModelMessages() requires FileUIPart.url to parse as a real
 * URL (`new URL(part.url)`), and it inlines `data:` URLs itself via splitDataUrl().
 * However splitDataUrl() naively treats the payload after the comma as base64, so
 * URL-encoded (non-base64) data URIs would be silently corrupted. Rebuilding the
 * canonical `data:<mediaType>;base64,<payload>` form keeps both cases safe.
 */
export function convertDataUriFilePartsForSdk(messages: MuxMessage[]): MuxMessage[] {
  let changedAnyMessage = false;

  const convertedMessages = messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }

    let changedMessage = false;

    const convertedParts: MuxMessage["parts"] = message.parts.map((part) => {
      if (part.type !== "file" || !part.url.toLowerCase().startsWith(DATA_URI_PREFIX)) {
        return part;
      }

      const { mediaType, base64Data } = parseDataUriToBase64(part.url);
      const effectiveMediaType = mediaType ?? part.mediaType;
      assert(effectiveMediaType, "file part data URI requires a media type");

      changedMessage = true;
      return {
        ...part,
        mediaType: effectiveMediaType,
        url: `${DATA_URI_PREFIX}${effectiveMediaType};base64,${base64Data}`,
      };
    });

    if (!changedMessage) {
      return message;
    }

    changedAnyMessage = true;
    return {
      ...message,
      parts: convertedParts,
    };
  });

  return changedAnyMessage ? convertedMessages : messages;
}
