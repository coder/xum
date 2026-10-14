import type { McpAppCspDeclaration } from "@/common/orpc/schemas/mcpApps";
import assert from "@/common/utils/assert";
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

/** Key of the preamble's document announcements (never a JSON-RPC message). */
const MCP_APP_DOCUMENT_MARKER = "xumMcpAppDocument";

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
 *
 * SECURITY AUDIT: it also binds the host bridge to this document (#6187). A page the frame
 * navigates to keeps the frame's window, so the source-window gate alone accepts it, and in
 * browser mode nothing blocks the navigation (the desktop app does: subframeNavigation.ts).
 * So the preamble announces the document with the host's per-document nonce before any view
 * script runs, and announces it gone when it starts to leave. The host accepts messages only
 * in between (createMcpAppDocumentGate). Its capture listeners are registered before any view
 * script, so no view listener runs ahead of them.
 * - Browser mode: the leave goes out on `beforeunload`, before the navigation request starts,
 *   so it reaches the host ahead of every message of the next page.
 * - `pagehide` covers what `beforeunload` misses: Chromium fires no `beforeunload` for a
 *   redirect while the srcdoc still loads. Its message arrived ahead of the next page's first
 *   message in Chromium, but no spec orders the two. The load count of
 *   useFrameNavigationGuard stays as a second check.
 * - Desktop app: the navigation is blocked after `beforeunload`, and the view must keep
 *   working, so only `pagehide` (the document really unloads) counts there.
 * A view that hands its nonce to the page it navigates to gains nothing: the gate never
 * reopens after a leave, and the view could put its data in the navigation URL anyway.
 */
export function mcpAppPreambleScript(document: {
  nonce: string;
  /** Announce the leave on `beforeunload` (browser mode), not only on `pagehide`. */
  leaveOnBeforeUnload: boolean;
}): string {
  assert(/^[0-9a-f]+$/.test(document.nonce), "MCP App document nonce must be hex");
  const leaveEvents = document.leaveOnBeforeUnload ? ["beforeunload", "pagehide"] : ["pagehide"];
  return `(function () {
  "use strict";
  Object.getOwnPropertyNames(window).forEach(function (name) {
    if (/^(webkit)?RTC/.test(name)) {
      try { delete window[name]; } catch (error) {}
    }
  });
  // window.parent is replaceable: keep the real one before any view script runs.
  var host = window.parent;
  var announce = function (type) {
    host.postMessage({ ${MCP_APP_DOCUMENT_MARKER}: 1, type: type, nonce: "${document.nonce}" }, "*");
  };
  var left = false;
  var leave = function () {
    if (left) return;
    left = true;
    announce("leave");
  };
  ${JSON.stringify(leaveEvents)}.forEach(function (type) {
    window.addEventListener(type, leave, true);
  });
  announce("open");
  ${ARTIFACT_IN_PAGE_LINK_SCRIPT}
})();`;
}

/** A fresh nonce for one view document. getRandomValues also works outside secure contexts. */
export function newMcpAppDocumentNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What to do with one message: hand it to the host, drop it, or drop it because the document
 * just announced its leave (then the frame is treated as navigated away).
 */
export type McpAppDocumentVerdict = "deliver" | "drop" | "left";

/** `fromFrame`: the message passed the source-window gate (passesFrameGate). */
export type McpAppDocumentGate = (data: unknown, fromFrame: boolean) => McpAppDocumentVerdict;

/**
 * The host side of the preamble's announcements for the document built with `nonce`. Fail
 * closed: nothing is delivered before the document's own open announcement, and nothing after
 * its leave, for good. Announcements with another nonce (an earlier document of the same
 * frame, or a forgery) are dropped and change nothing.
 *
 * A leave counts from any source: Chromium runs `pagehide` once the next document committed,
 * so its message no longer comes from the frame's window. A leave can only close the bridge,
 * and only a holder of the nonce can send it.
 */
/** What one message is for the gate of the document with `nonce`. */
function documentEvent(
  data: unknown,
  nonce: string,
  fromFrame: boolean
): "message" | "open" | "leave" | "ignore" {
  if (typeof data !== "object" || data === null || !(MCP_APP_DOCUMENT_MARKER in data)) {
    return "message";
  }
  const announcement = data as { type?: unknown; nonce?: unknown };
  if (announcement.nonce !== nonce) return "ignore";
  if (announcement.type === "leave") return "leave";
  return announcement.type === "open" && fromFrame ? "open" : "ignore";
}

export function createMcpAppDocumentGate(nonce: string): McpAppDocumentGate {
  let state: "waiting" | "open" | "left" = "waiting";
  return (data, fromFrame) => {
    const event = documentEvent(data, nonce, fromFrame);
    if (state === "left") return "drop";
    if (event === "leave") {
      state = "left";
      return "left";
    }
    if (event === "open" && state === "waiting") state = "open";
    return event === "message" && fromFrame && state === "open" ? "deliver" : "drop";
  };
}

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
