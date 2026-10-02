import { z } from "zod";

/**
 * postMessage bridge between the app and a sandboxed HTML/SVG artifact frame
 * (experiment: "artifacts"). Security-owned contract:
 *
 * - Every message is an object `{ xumArtifact: 1, type, ... }`, validated with zod.
 * - Frame -> host (M3): `{ type: "key", key: "Escape" | "F", shiftKey }` only, so Escape and
 *   Shift+F can exit fullscreen while focus is inside the frame (the host never lets a frame
 *   message enter fullscreen: the artifact's script can post these without a key press).
 * - Host -> frame: `{ type: "theme", theme: "dark" | "light" }`, sent after load and on theme
 *   change. The artifact may read it; the host never injects its own CSS.
 * - The host accepts a message only when `event.source` is the frame's contentWindow, the
 *   frame is under its rate limit, and the payload is schema-valid.
 * - Never send auth tokens, paths or environment data into the frame.
 *
 * Both unions are discriminated on `type` so M5 can add `send` / `setState` variants without
 * touching existing handlers.
 */

export const ARTIFACT_BRIDGE_VERSION = 1;

/** Messages above this rate (per frame, per second) are dropped unparsed. */
export const ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND = 20;

const bridgeEnvelope = { xumArtifact: z.literal(ARTIFACT_BRIDGE_VERSION) };

const ArtifactKeyMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("key"),
    key: z.enum(["Escape", "F"]),
    shiftKey: z.boolean(),
  })
  .strict();

export const ArtifactFrameToHostMessageSchema = z.discriminatedUnion("type", [
  ArtifactKeyMessageSchema,
]);
export type ArtifactFrameToHostMessage = z.infer<typeof ArtifactFrameToHostMessageSchema>;

export type ArtifactTheme = "dark" | "light";

const ArtifactThemeMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("theme"),
    theme: z.enum(["dark", "light"]),
  })
  .strict();

export const ArtifactHostToFrameMessageSchema = z.discriminatedUnion("type", [
  ArtifactThemeMessageSchema,
]);
export type ArtifactHostToFrameMessage = z.infer<typeof ArtifactHostToFrameMessageSchema>;

/**
 * Fixed-window limiter: allows `maxPerWindow` calls per `windowMs`. Every message from the
 * frame counts, valid or not, so a flood of junk cannot keep the parser busy.
 */
export function createBridgeRateLimiter(
  maxPerWindow = ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  windowMs = 1000,
  now: () => number = Date.now
): () => boolean {
  let windowStart = now();
  let count = 0;
  return () => {
    const current = now();
    if (current - windowStart >= windowMs) {
      windowStart = current;
      count = 0;
    }
    count += 1;
    return count <= maxPerWindow;
  };
}

/**
 * Host-side acceptance check for one `message` event. Returns the parsed message, or null
 * when the event is not from `frameWindow`, is over the rate limit, or is not schema-valid.
 */
export function acceptArtifactFrameMessage(
  event: Pick<MessageEvent, "source" | "data">,
  frameWindow: Window | null | undefined,
  allowMessage: () => boolean
): ArtifactFrameToHostMessage | null {
  if (frameWindow == null || event.source !== frameWindow) return null;
  if (!allowMessage()) return null;
  const parsed = ArtifactFrameToHostMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

export function postArtifactTheme(frameWindow: Window | null | undefined, theme: ArtifactTheme) {
  if (frameWindow == null) return;
  const message: ArtifactHostToFrameMessage = {
    xumArtifact: ARTIFACT_BRIDGE_VERSION,
    type: "theme",
    theme,
  };
  // The sandboxed frame has an opaque origin ("null"), which cannot be named as a target
  // origin, so "*" is required. The payload carries nothing sensitive by contract.
  frameWindow.postMessage(message, "*");
}

/**
 * Source of the inline <script> injected as the frame's first script (inline, so the CSP's
 * 'unsafe-inline' allows it). It forwards Escape and Shift+F to the host and exposes a
 * read-only `window.xum.theme`, updated from theme messages, plus a `xumthemechange` event.
 * It also mirrors the theme into `data-xum-theme` on the root element, so plain CSS (the goal
 * status board, which has no scripts) can follow the app theme instead of the OS preference.
 * Only the initial theme is interpolated, and only as a JSON string literal.
 *
 * SECURITY AUDIT: it first deletes every WebRTC global (RTCPeerConnection and friends). CSP
 * cannot block WebRTC: `connect-src 'none'` does not govern ICE, and Chromium ignores
 * `webrtc 'block'`, so without this an artifact could send data out through STUN/TURN to any
 * host. Running first means no artifact script can keep a reference, and `frame-src 'none'`
 * keeps it from reaching a fresh window's constructors through a child frame.
 */
export function buildArtifactBridgeScript(initialTheme: ArtifactTheme): string {
  return `(function () {
  "use strict";
  Object.getOwnPropertyNames(window).forEach(function (name) {
    if (/^(webkit)?RTC/.test(name)) {
      try { delete window[name]; } catch (error) {}
    }
  });
  var host = window.parent;
  var theme = ${JSON.stringify(initialTheme)};
  var api = {};
  Object.defineProperty(api, "theme", { enumerable: true, get: function () { return theme; } });
  Object.defineProperty(window, "xum", { value: Object.freeze(api) });
  function applyThemeAttribute() {
    var root = document.documentElement;
    if (root) root.setAttribute("data-xum-theme", theme);
  }
  applyThemeAttribute();
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.xumArtifact !== ${ARTIFACT_BRIDGE_VERSION}) return;
    if (data.type === "theme" && (data.theme === "dark" || data.theme === "light")) {
      theme = data.theme;
      applyThemeAttribute();
      window.dispatchEvent(new CustomEvent("xumthemechange", { detail: { theme: theme } }));
    }
  });
  function isEditable(target) {
    if (!target || target.nodeType !== 1) return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }
  window.addEventListener("keydown", function (event) {
    var plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    var key = null;
    // Escape is checked before the editable exclusion: keys inside the frame never reach the
    // host, so this is the only way to leave fullscreen while an artifact input has focus.
    if (event.key === "Escape") key = "Escape";
    else if (isEditable(event.target)) return;
    else if (plain && event.shiftKey && (event.key === "F" || event.key === "f")) key = "F";
    if (key === null) return;
    host.postMessage({ xumArtifact: ${ARTIFACT_BRIDGE_VERSION}, type: "key", key: key, shiftKey: event.shiftKey }, "*");
  }, true);
})();`;
}
