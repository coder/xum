import type { McpAppCspDeclaration } from "@/common/orpc/schemas/mcpApps";
import {
  ARTIFACT_CDN_FONT_SOURCES,
  ARTIFACT_CDN_SCRIPT_SOURCES,
  ARTIFACT_CDN_STYLE_SOURCES,
} from "./artifactCsp";

/**
 * CSP for MCP Apps views (artifacts experiment).
 *
 * SECURITY AUDIT: views run in the same sandbox as HTML artifacts (srcdoc, sandbox exactly
 * "allow-scripts", opaque origin), with this policy instead of the artifact one. The base is
 * the spec's default policy; `'self'` is dropped because it matches nothing in an opaque
 * origin. Declared `resourceDomains`/`connectDomains` are granted ONLY when they are https
 * origins that the artifacts CDN allowlist also allows and the "Allow CDN scripts in
 * artifacts" setting is on; the grant is the narrower of the two sources. Undeclared domains
 * are never granted, and `frameDomains`, `baseUriDomains`, `permissions` and `domain` never
 * are. What was granted is reported to the view in hostCapabilities.sandbox.csp.
 */

export interface GrantedMcpAppCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

/** Every CDN source the artifacts allowlist knows (scripts, styles, fonts). */
const CDN_SOURCES: readonly string[] = [
  ...ARTIFACT_CDN_SCRIPT_SOURCES,
  ...ARTIFACT_CDN_STYLE_SOURCES,
  ...ARTIFACT_CDN_FONT_SOURCES,
];

/** The allowlist source matching a declared https origin, or null. */
function allowlistedSourceFor(declared: string): string | null {
  let url: URL;
  try {
    url = new URL(declared);
  } catch {
    return null;
  }
  // Only a bare https origin is a grantable declaration (no wildcards, paths or credentials).
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    declared.includes("*")
  ) {
    return null;
  }
  return CDN_SOURCES.find((source) => new URL(source).origin === url.origin) ?? null;
}

export function grantMcpAppCsp(
  declared: McpAppCspDeclaration,
  options: { allowCdn: boolean }
): { granted: GrantedMcpAppCsp; notGranted: string[] } {
  const granted: GrantedMcpAppCsp = { resourceDomains: [], connectDomains: [] };
  const notGranted: string[] = [];
  for (const key of ["resourceDomains", "connectDomains"] as const) {
    for (const domain of declared[key] ?? []) {
      const source = options.allowCdn ? allowlistedSourceFor(domain) : null;
      if (source == null) notGranted.push(domain);
      else if (!granted[key].includes(source)) granted[key].push(source);
    }
  }
  notGranted.push(...(declared.frameDomains ?? []), ...(declared.baseUriDomains ?? []));
  return { granted, notGranted: [...new Set(notGranted)] };
}

/**
 * First script of every view document (after the CSP meta, before any view script).
 *
 * SECURITY AUDIT: CSP cannot block WebRTC: `connect-src` does not govern ICE, and Chromium
 * ignores `webrtc 'block'`, so without this a view could send data out through STUN/TURN to any
 * host regardless of its granted connectDomains. Running first means no view script can keep a
 * reference, and `frame-src 'none'` keeps it from reaching a fresh window's constructors through
 * a child frame. HTML artifacts get the same removal from their bridge script.
 */
export const MCP_APP_PREAMBLE_SCRIPT = `(function () {
  "use strict";
  Object.getOwnPropertyNames(window).forEach(function (name) {
    if (/^(webkit)?RTC/.test(name)) {
      try { delete window[name]; } catch (error) {}
    }
  });
})();`;

export function buildMcpAppCsp(granted: GrantedMcpAppCsp): string {
  const resources = granted.resourceDomains;
  const directives: Array<[string, readonly string[]]> = [
    ["default-src", ["'none'"]],
    ["script-src", ["'unsafe-inline'", ...resources]],
    ["style-src", ["'unsafe-inline'", ...resources]],
    ["img-src", ["data:", ...resources]],
    ["media-src", ["data:", ...resources]],
    // Fonts are static resources too; without a grant default-src 'none' covers them.
    ...(resources.length > 0 ? [["font-src", resources] satisfies [string, string[]]] : []),
    ["connect-src", granted.connectDomains.length > 0 ? granted.connectDomains : ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}
