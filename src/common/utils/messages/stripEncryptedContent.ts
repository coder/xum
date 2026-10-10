/**
 * Strip encryptedContent from web search results to reduce token usage.
 * The encrypted page content can be massive (4000+ chars per result) and isn't
 * needed for model context. Keep URL, title, and pageAge for reference.
 */
function stripEncryptedContentFromArray(output: unknown[]): unknown[] {
  return output.map((item: unknown) => {
    if (item && typeof item === "object" && "encryptedContent" in item) {
      // Remove encryptedContent but keep other fields
      const { encryptedContent, ...rest } = item as Record<string, unknown>;
      return rest;
    }

    return item;
  });
}

export function stripEncryptedContent(output: unknown): unknown {
  if (Array.isArray(output)) {
    return stripEncryptedContentFromArray(output);
  }

  // Handle SDK json output shape: { type: "json", value: unknown[] }
  if (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    output.type === "json" &&
    "value" in output &&
    Array.isArray(output.value)
  ) {
    return {
      ...output,
      value: stripEncryptedContentFromArray(output.value),
    };
  }

  return output;
}
