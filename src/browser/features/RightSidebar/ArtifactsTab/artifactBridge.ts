import { z } from "zod";
import {
  ARTIFACT_ANNOTATION_CONTEXT_CHARS,
  ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS,
  ARTIFACT_ANNOTATION_SELECTOR_MAX_CHARS,
  ARTIFACT_JSON_MAX_BYTES,
  ARTIFACT_SEND_TEXT_MAX_CHARS,
  isJsonValue,
  jsonByteLength,
} from "@/common/constants/artifactInteractions";

/**
 * postMessage bridge between the app and a sandboxed HTML/SVG artifact frame
 * (experiment: "artifacts"). Security-owned contract:
 *
 * - Every message is an object `{ xumArtifact: 1, type, ... }`, validated with zod.
 * - Frame -> host (M3): `{ type: "key", key: "Escape" | "F", shiftKey }`, so Escape and
 *   Shift+F can exit fullscreen while focus is inside the frame (the host never lets a frame
 *   message enter fullscreen: the artifact's script can post these without a key press).
 * - Frame -> host (M5b): `{ type: "send", text, data? }` (window.xum.send) only fills the
 *   host-owned confirm strip, never sends by itself; `{ type: "setState", state }`
 *   (window.xum.setState) is persisted per artifact version. Text and JSON sizes are capped.
 * - Frame -> host (M5b annotate): `{ type: "annotate", x, y, selector?, quote?, prefix?,
 *   suffix? }`, posted by the shim only while the host has annotate mode on; x/y are fractions of
 *   the frame size. The host also ignores it unless annotate mode is on.
 * - Host -> frame: `{ type: "theme", theme: "dark" | "light" }`, sent after load and on theme
 *   change; the artifact may read it, and the host never injects its own CSS.
 *   `{ type: "annotate", enabled }` switches the shim's click-to-pin capture on or off (clicks
 *   are swallowed while it is on).
 * - The persisted `window.xum.state` is never posted: it is baked into the shim when the srcdoc
 *   is built (buildArtifactBridgeScript). Host posts must target "*" (opaque origin), and a frame
 *   that navigated itself keeps the same contentWindow, so a posted state could reach a remote
 *   page before the host notices the navigation.
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

/**
 * Any JSON value under the size cap. postMessage uses structured clone, which also carries Maps,
 * Dates and the like; those are refused rather than silently reshaped.
 */
const BridgeJsonSchema = z.unknown().superRefine((value, ctx) => {
  if (!isJsonValue(value)) {
    ctx.addIssue({ code: "custom", message: "not JSON" });
  } else if ((jsonByteLength(value) ?? Infinity) > ARTIFACT_JSON_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "too large" });
  }
});

const ArtifactSendMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("send"),
    text: z.string().min(1).max(ARTIFACT_SEND_TEXT_MAX_CHARS),
    data: BridgeJsonSchema.optional(),
  })
  .strict();

const ArtifactSetStateMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("setState"),
    state: BridgeJsonSchema,
  })
  .strict();

const fraction = z.number().min(0).max(1);
const ArtifactAnnotateMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("annotate"),
    x: fraction,
    y: fraction,
    selector: z.string().min(1).max(ARTIFACT_ANNOTATION_SELECTOR_MAX_CHARS).optional(),
    quote: z.string().min(1).max(ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS).optional(),
    prefix: z.string().max(ARTIFACT_ANNOTATION_CONTEXT_CHARS).optional(),
    suffix: z.string().max(ARTIFACT_ANNOTATION_CONTEXT_CHARS).optional(),
  })
  .strict();

export const ArtifactFrameToHostMessageSchema = z.discriminatedUnion("type", [
  ArtifactKeyMessageSchema,
  ArtifactSendMessageSchema,
  ArtifactSetStateMessageSchema,
  ArtifactAnnotateMessageSchema,
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

const ArtifactAnnotateModeMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("annotate"),
    enabled: z.boolean(),
  })
  .strict();

export const ArtifactHostToFrameMessageSchema = z.discriminatedUnion("type", [
  ArtifactThemeMessageSchema,
  ArtifactAnnotateModeMessageSchema,
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
 * The frame gate shared by the artifact bridge and the MCP Apps host: the event must come
 * from `frameWindow` (never another frame or the app itself) and be under the rate limit.
 */
export function passesFrameGate(
  event: Pick<MessageEvent, "source">,
  frameWindow: Window | null | undefined,
  allowMessage: () => boolean
): boolean {
  return frameWindow != null && event.source === frameWindow && allowMessage();
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
  if (!passesFrameGate(event, frameWindow, allowMessage)) return null;
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

/** Turn the shim's click-to-pin capture on or off (annotate mode). */
export function postArtifactAnnotateMode(frameWindow: Window | null | undefined, enabled: boolean) {
  if (frameWindow == null) return;
  const message: ArtifactHostToFrameMessage = {
    xumArtifact: ARTIFACT_BRIDGE_VERSION,
    type: "annotate",
    enabled,
  };
  frameWindow.postMessage(message, "*");
}

/**
 * Source of the inline <script> injected as the frame's first script (inline, so the CSP's
 * 'unsafe-inline' allows it). It forwards Escape and Shift+F to the host and exposes a
 * read-only `window.xum.theme`, updated from theme messages, plus a `xumthemechange` event;
 * `window.xum.send` / `window.xum.setState`, and a read-only `window.xum.state` with a
 * `xumstatechange` event. It also mirrors the theme into `data-xum-theme` on the root element,
 * so plain CSS (the goal status board, which has no scripts) can follow the app theme instead
 * of the OS preference. While the host has annotate mode on, a capture-phase click listener
 * swallows clicks and reports the point (plus any selected text) instead.
 * Only the initial theme and the persisted state are interpolated. The state goes in as a JSON
 * string passed to JSON.parse, never as an object literal (a literal `"__proto__"` key would set
 * the prototype instead of an own property), with `<` escaped so a `</script>` or `<!--` inside
 * it cannot leave the inline script. A restored state also gets one `xumstatechange` just after
 * DOMContentLoaded, so artifacts that listen for the event (not just read `xum.state`) see it.
 *
 * SECURITY AUDIT: it first deletes every WebRTC global (RTCPeerConnection and friends). CSP
 * cannot block WebRTC: `connect-src 'none'` does not govern ICE, and Chromium ignores
 * `webrtc 'block'`, so without this an artifact could send data out through STUN/TURN to any
 * host. Running first means no artifact script can keep a reference, and `frame-src 'none'`
 * keeps it from reaching a fresh window's constructors through a child frame.
 */
/**
 * Shim-side spacing of `setState` posts. The host rate-limits every frame message (a hostile
 * frame guard), so an artifact saving on every keystroke or drag would get its last save
 * dropped. The shim keeps `window.xum.state` current at once, posts at most this often, and
 * always flushes the latest value after the interval.
 */
export const ARTIFACT_STATE_POST_INTERVAL_MS = 250;

export function buildArtifactBridgeScript(
  initialTheme: ArtifactTheme,
  initialState: unknown = null
): string {
  return `(function () {
  "use strict";
  Object.getOwnPropertyNames(window).forEach(function (name) {
    if (/^(webkit)?RTC/.test(name)) {
      try { delete window[name]; } catch (error) {}
    }
  });
  var host = window.parent;
  var theme = ${JSON.stringify(initialTheme)};
  var state = JSON.parse(${inlineScriptJson(JSON.stringify(initialState ?? null))});
  var annotating = false;
  var api = {};
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function setLocalState(next) {
    state = next;
    window.dispatchEvent(new CustomEvent("xumstatechange", { detail: { state: clone(state) } }));
  }
  Object.defineProperty(api, "theme", { enumerable: true, get: function () { return theme; } });
  Object.defineProperty(api, "state", { enumerable: true, get: function () { return clone(state); } });
  // send() only asks the host to show its confirm strip; the user decides whether it is sent.
  api.send = function (text, data) {
    var message = { xumArtifact: ${ARTIFACT_BRIDGE_VERSION}, type: "send", text: String(text) };
    if (data !== undefined) message.data = clone(data);
    host.postMessage(message, "*");
  };
  var stateFlushTimer = null;
  var lastStatePostAt = 0;
  function postState() {
    stateFlushTimer = null;
    lastStatePostAt = Date.now();
    host.postMessage({ xumArtifact: ${ARTIFACT_BRIDGE_VERSION}, type: "setState", state: state }, "*");
  }
  api.setState = function (next) {
    var value = clone(next === undefined ? null : next);
    setLocalState(value);
    // A pending flush posts the latest state when it fires.
    if (stateFlushTimer !== null) return;
    var wait = lastStatePostAt + ${ARTIFACT_STATE_POST_INTERVAL_MS} - Date.now();
    if (wait <= 0) postState();
    else stateFlushTimer = setTimeout(postState, wait);
  };
  Object.defineProperty(window, "xum", { value: Object.freeze(api) });
  if (state !== null) {
    document.addEventListener("DOMContentLoaded", function () {
      // A task, not a microtask: microtasks run between listener callbacks, so this would still
      // fire before the artifact's own DOMContentLoaded handlers (registered after this shim).
      setTimeout(function () {
        window.dispatchEvent(new CustomEvent("xumstatechange", { detail: { state: clone(state) } }));
      }, 0);
    }, { once: true });
  }
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
    } else if (data.type === "annotate") {
      annotating = data.enabled === true;
    }
  });
  // Annotate mode: clicks become pins (the artifact never sees them), with the selection if any.
  function clampFraction(value) { return value > 0 ? (value < 1 ? value : 1) : 0; }
  function selectorFor(element) {
    var parts = [];
    while (element && element.nodeType === 1 && parts.length < 4) {
      if (element.id) { parts.unshift("#" + element.id); break; }
      var tag = element.tagName.toLowerCase();
      var parent = element.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var index = 1;
      for (var sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === element.tagName) index += 1;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      element = parent;
    }
    return parts.join(" > ").slice(0, ${ARTIFACT_ANNOTATION_SELECTOR_MAX_CHARS});
  }
  window.addEventListener("click", function (event) {
    if (!annotating) return;
    event.preventDefault();
    // Immediate: the artifact's own capture listeners on window must not see the click either
    // (stopPropagation only stops other targets). The shim registers first, so it runs first.
    event.stopImmediatePropagation();
    var message = {
      xumArtifact: ${ARTIFACT_BRIDGE_VERSION},
      type: "annotate",
      x: clampFraction(event.clientX / (window.innerWidth || 1)),
      y: clampFraction(event.clientY / (window.innerHeight || 1))
    };
    var selector = selectorFor(event.target);
    if (selector) message.selector = selector;
    var selection = window.getSelection();
    var quote = selection ? String(selection).trim() : "";
    if (quote && selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      message.quote = quote.slice(0, ${ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS});
      var start = range.startContainer;
      var end = range.endContainer;
      if (start.nodeType === 3) {
        message.prefix = start.data.slice(Math.max(0, range.startOffset - ${ARTIFACT_ANNOTATION_CONTEXT_CHARS}), range.startOffset);
      }
      if (end.nodeType === 3) {
        message.suffix = end.data.slice(range.endOffset, range.endOffset + ${ARTIFACT_ANNOTATION_CONTEXT_CHARS});
      }
    }
    host.postMessage(message, "*");
  }, true);
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

/** JSON for an inline <script>: `<` becomes `\u003c`, so the HTML parser never sees a tag. */
function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
