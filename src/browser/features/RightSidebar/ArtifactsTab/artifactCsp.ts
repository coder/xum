/**
 * Content Security Policy for sandboxed HTML/SVG artifacts (experiment: "artifacts").
 *
 * SECURITY AUDIT: this string is the second wall around agent-written HTML. The first wall is
 * the iframe sandbox (`allow-scripts` only, opaque origin), which keeps the artifact away from
 * the app's DOM, storage and cookies. The CSP below limits what the frame can load or contact:
 * no network (`connect-src 'none'`), no forms, no <base>, no nested frames, images only from
 * data:/blob:, and scripts/styles only inline or from a short CDN allowlist. Keep the
 * directives exact; the escape-attempt stories and unit tests pin them. CSP cannot stop
 * WebRTC (STUN/TURN), so the bridge script deletes the RTC globals (artifactBridge.ts).
 *
 * Known residual risk (documented in the setting text): with CDN scripts allowed, a hostile
 * artifact can encode data into the request path of an allowlisted CDN URL. Turning the
 * "Allow CDN scripts in artifacts" setting off drops every CDN host, Google Fonts included.
 */

/** Script hosts allowed when the user keeps "Allow CDN scripts in artifacts" on. */
export const ARTIFACT_CDN_SCRIPT_SOURCES = [
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
  "https://cdn.jsdelivr.net/npm/",
] as const;

export const ARTIFACT_CDN_STYLE_SOURCES = ["https://fonts.googleapis.com"] as const;
export const ARTIFACT_CDN_FONT_SOURCES = ["https://fonts.gstatic.com"] as const;

export interface ArtifactCspOptions {
  allowCdn: boolean;
}

export function buildArtifactCsp(options: ArtifactCspOptions): string {
  const cdn = <T extends readonly string[]>(sources: T): readonly string[] =>
    options.allowCdn ? sources : [];
  const directives: Array<[string, readonly string[]]> = [
    ["default-src", ["'none'"]],
    ["script-src", ["'unsafe-inline'", ...cdn(ARTIFACT_CDN_SCRIPT_SOURCES)]],
    ["style-src", ["'unsafe-inline'", ...cdn(ARTIFACT_CDN_STYLE_SOURCES)]],
    ["font-src", ["data:", ...cdn(ARTIFACT_CDN_FONT_SOURCES)]],
    ["img-src", ["data:", "blob:"]],
    ["connect-src", ["'none'"]],
    ["form-action", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["frame-src", ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/**
 * True when the CSP built with `options` lets the frame load `url` as a script or stylesheet.
 * Used only to decide which absolute URLs get an "External asset blocked" notice; the CSP
 * itself is what enforces the rule.
 */
export function isArtifactCdnUrl(
  url: string,
  type: "script" | "style",
  options: ArtifactCspOptions
): boolean {
  if (!options.allowCdn) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const sources: readonly string[] =
    type === "script" ? ARTIFACT_CDN_SCRIPT_SOURCES : ARTIFACT_CDN_STYLE_SOURCES;
  return sources.some((source) => {
    const allowed = new URL(source);
    if (allowed.host !== parsed.host) return false;
    // CSP host sources ending in "/" match a path prefix; bare hosts match any path.
    return allowed.pathname === "/" || parsed.pathname.startsWith(allowed.pathname);
  });
}
