import type { McpAppCspDeclaration } from "@/common/orpc/schemas/mcpApps";
import { mcpAppGrantableOrigin } from "@/common/utils/mcpApps";
import { ARTIFACT_IN_PAGE_LINK_SCRIPT } from "./artifactBridge";

/**
 * CSP for MCP Apps views (artifacts experiment).
 *
 * Views run in the same sandbox as HTML artifacts (srcdoc, sandbox exactly "allow-scripts",
 * opaque origin), with this policy instead of the artifact one. The base is the spec's default
 * policy; `'self'` is dropped because it matches nothing in an opaque origin. Declared
 * `resourceDomains`/`connectDomains` that are bare https origins are granted only after the user
 * approved them for the view's server (one approval per server and project, kept in project
 * config). `frameDomains`, `baseUriDomains`, `permissions` and `domain` are never granted. What
 * was granted is reported to the view in hostCapabilities.sandbox.csp.
 */

export interface GrantedMcpAppCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

export interface McpAppCspGrant {
  granted: GrantedMcpAppCsp;
  /** Declared grantable origins the server's approvals lack: what the strip asks for. */
  pending: string[];
  /** Declared domains that are never granted (not bare https, frames, base URIs). */
  notGranted: string[];
}

export function grantMcpAppCsp(
  declared: McpAppCspDeclaration,
  approved: readonly string[]
): McpAppCspGrant {
  const granted: GrantedMcpAppCsp = { resourceDomains: [], connectDomains: [] };
  const pending: string[] = [];
  const notGranted: string[] = [];
  for (const key of ["resourceDomains", "connectDomains"] as const) {
    for (const domain of declared[key] ?? []) {
      const origin = mcpAppGrantableOrigin(domain);
      // SECURITY AUDIT: an approved origin can receive any data the view has (its tool input,
      // result and whatever it reads through the bridge), and can serve it code. That is what
      // the user approves in the strip, per server, for exactly these origins.
      if (origin == null) notGranted.push(domain);
      else if (!approved.includes(origin)) pending.push(origin);
      else if (!granted[key].includes(origin)) granted[key].push(origin);
    }
  }
  notGranted.push(...(declared.frameDomains ?? []), ...(declared.baseUriDomains ?? []));
  return { granted, pending: [...new Set(pending)], notGranted: [...new Set(notGranted)] };
}

/**
 * First script of every view document (after the CSP meta, before any view script).
 *
 * SECURITY AUDIT: CSP cannot block WebRTC: `connect-src` does not govern ICE, and Chromium
 * ignores `webrtc 'block'`, so without this a view could send data out through STUN/TURN to any
 * host regardless of its granted connectDomains. Running first means no view script can keep a
 * reference, and `frame-src 'none'` keeps it from reaching a fresh window's constructors through
 * a child frame. HTML artifacts get the same removal from their bridge script.
 * It also makes in-page `#` links jump within the view instead of navigating it away (same
 * reason as for HTML artifacts: ARTIFACT_IN_PAGE_LINK_SCRIPT).
 */
export const MCP_APP_PREAMBLE_SCRIPT = `(function () {
  "use strict";
  Object.getOwnPropertyNames(window).forEach(function (name) {
    if (/^(webkit)?RTC/.test(name)) {
      try { delete window[name]; } catch (error) {}
    }
  });
  ${ARTIFACT_IN_PAGE_LINK_SCRIPT}
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
