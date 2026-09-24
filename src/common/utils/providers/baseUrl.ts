export function resolveConfigBaseUrl(config: {
  baseUrl?: unknown;
  baseURL?: unknown;
}): string | undefined {
  const rawBaseUrl =
    (typeof config.baseUrl === "string" ? config.baseUrl : undefined) ??
    (typeof config.baseURL === "string" ? config.baseURL : undefined);
  const trimmed = rawBaseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

/**
 * Normalize Anthropic base URL to ensure it ends with /v1 suffix.
 *
 * The Anthropic SDK expects baseURL to include /v1 (default: https://api.anthropic.com/v1).
 * Many users configure base URLs without the /v1 suffix, which causes API calls to fail.
 * This function automatically appends /v1 if missing.
 *
 * @param baseURL - The base URL to normalize (may or may not have /v1)
 * @returns The base URL with /v1 suffix
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  // Append /v1 to the URL PATH: raw-string suffixing would push the version
  // segment into a query or fragment (proxy.example/a?token=x -> ...?token=x/v1).
  try {
    const url = new URL(baseURL.trim());
    // Compute on a local: the pathname setter normalizes "" back to "/".
    const strippedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = strippedPath.endsWith("/v1") ? strippedPath : `${strippedPath}/v1`;
    return url.toString();
  } catch {
    // Not an absolute URL; keep the legacy raw-string behavior.
    const trimmed = baseURL.replace(/\/+$/, ""); // Remove trailing slashes
    if (trimmed.endsWith("/v1")) {
      return trimmed;
    }
    return `${trimmed}/v1`;
  }
}

export function normalizeOpenAICompatibleBaseURL(baseURL: string): string {
  // Trim first: new URL() tolerates surrounding whitespace, which would defeat
  // the raw-string trailing-slash check below for values like "http://x/ ".
  const trimmed = baseURL.trim();
  try {
    const url = new URL(trimmed);
    // An explicit trailing slash ("http://host:8080/") opts out for servers that
    // mount /chat/completions at the origin root. The URL API normalizes both
    // spellings to pathname "/", so the raw string is the only place the intent
    // survives.
    if (url.pathname !== "/" || trimmed.endsWith("/")) {
      return trimmed;
    }

    // Most compatible servers mount their API under /v1, but explicit proxy paths must remain intact.
    url.pathname = "/v1";
    return url.toString();
  } catch {
    return trimmed;
  }
}
