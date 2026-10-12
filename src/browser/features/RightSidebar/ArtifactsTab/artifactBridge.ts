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
 *   (window.xum.setState) is persisted per artifact, for all its versions. Text and JSON sizes
 *   are capped.
 * - Frame -> host (M5b annotate): `{ type: "annotate", x, y, selector?, quote?, prefix?,
 *   suffix? }`, posted by the shim only while the host has annotate mode on; x/y are fractions of
 *   the frame size. The host also ignores it unless annotate mode is on.
 * - Frame -> host (openWorkspace): `{ type: "openWorkspace", workspaceId }`
 *   (window.xum.openWorkspace) asks the host to switch the app to that workspace. The host
 *   honours it only for an interactive artifact (not pinned files or shelf copies), right after
 *   the user clicked or typed inside this frame, and only for an active workspace
 *   (SandboxedArtifactFrame.tsx). The frame never gets a reply, so no workspace list or title
 *   reaches it.
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

/**
 * Longest workspace ID the bridge accepts. New IDs are 10 hex characters, but legacy IDs are
 * `<project>-<dir>` basenames with any characters, so there is no character set. The host's
 * lookup in its active-workspace map is the real gate; this cap only keeps junk out before it.
 */
export const ARTIFACT_WORKSPACE_ID_MAX_CHARS = 1024;

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

const ArtifactOpenWorkspaceMessageSchema = z
  .object({
    ...bridgeEnvelope,
    type: z.literal("openWorkspace"),
    workspaceId: z.string().min(1).max(ARTIFACT_WORKSPACE_ID_MAX_CHARS),
  })
  .strict();

export const ArtifactFrameToHostMessageSchema = z.discriminatedUnion("type", [
  ArtifactKeyMessageSchema,
  ArtifactOpenWorkspaceMessageSchema,
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
 * `window.xum.send` / `window.xum.setState` / `window.xum.openWorkspace`, and a read-only
 * `window.xum.state` with a `xumstatechange` event. It also mirrors the theme into `data-xum-theme` on the root element,
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

/**
 * Frame script (a statement, run inside the bridge's IIFE and the MCP App preamble) that makes
 * in-page links (`<a href="#section">`) jump within the artifact instead of navigating away.
 *
 * Why: a srcdoc frame resolves relative URLs against the parent page, so `#section` becomes
 * `<app URL>#section`: a cross-document navigation to the Xum app, not a fragment jump. The
 * navigation guard (frameNavigationGuard.tsx) then closes the artifact as "navigated away",
 * and the desktop app refuses the navigation (subframeNavigation.ts). CSP `base-uri 'none'`
 * rules out a `<base>` fix.
 *
 * So a plain left click on a link for this document (`href`, or SVG `xlink:href`, no `download`,
 * no `target` other than `_self`) whose raw value starts with `#` is cancelled, and the script does the browser's fragment steps itself: the target is an id or
 * an `<a name>`, raw first and then percent-decoded, else the top for `#` and `#top`. It is
 * scrolled into view and focused, or, when it cannot take focus, given `tabindex="-1"` until it
 * loses focus, so the next Tab continues after it. A native fragment navigation
 * (`location.replace("about:srcdoc#x")`, `location.hash`, `<base href="about:srcdoc">`) would
 * do this for free, but WebKit fires the iframe's `load` event for it, which the navigation
 * guard must treat as leaving the document.
 *
 * It decides when the click reaches window in the bubble phase, after the artifact's element
 * and document handlers, so one of those that calls preventDefault keeps the click. Window
 * listeners the artifact adds itself run after this one, so they see the click already handled. The link is found through
 * composedPath, so links in open shadow roots count too. Annotate mode stops the click in the
 * capture phase first. Known limits (#6219), where the click still leaves the document as
 * before: a handler that stops the click's propagation hides it from window, and a target
 * inside a closed <details> is not revealed first.
 *
 * SECURITY AUDIT: it only cancels a navigation and scrolls or focuses inside the document; it
 * never navigates, so both navigation guards stay as they are.
 */
export const ARTIFACT_IN_PAGE_LINK_SCRIPT = `(function () {
    var XLINK = "http://www.w3.org/1999/xlink";
    function fragmentOf(event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
      var path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (!node || node.nodeType !== 1 || (node.localName !== "a" && node.localName !== "area")) continue;
        // A download link, or one for another browsing context (target="_blank"), never navigated
        // this document.
        if (node.hasAttribute("download")) return null;
        var linkTarget = node.getAttribute("target");
        if (linkTarget !== null && linkTarget !== "" && linkTarget.toLowerCase() !== "_self") return null;
        var href = node.getAttribute("href");
        if (href === null) href = node.getAttributeNS(XLINK, "href");
        if (href === null) return null;
        href = href.trim();
        return href.charAt(0) === "#" ? href.slice(1) : null;
      }
      return null;
    }
    // HTML's "find a potential indicated element": an id first, then an <a name>.
    function findTarget(fragment) {
      if (fragment === "") return null;
      var element = document.getElementById(fragment);
      if (element) return element;
      var named = document.getElementsByName(fragment);
      for (var i = 0; i < named.length; i++) if (named[i].localName === "a") return named[i];
      return null;
    }
    function jump(raw) {
      // Like URL percent-decoding: a "%" without two hex digits stays as it is.
      var decoded = raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (run) {
        try { return decodeURIComponent(run); } catch (error) { return run; }
      });
      var target = findTarget(raw) || findTarget(decoded);
      if (!target) {
        if (raw !== "" && decoded.toLowerCase() !== "top") return;
        // The top of the document: no focusing steps, so focus stays on the link (as in HTML).
        window.scrollTo(0, 0);
        return;
      }
      target.scrollIntoView();
      target.focus({ preventScroll: true });
      // tabIndex cannot tell (an <a> without href reports 0), so check whether focus moved.
      if (document.activeElement !== target && !target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        // Still unfocusable (disabled, inert): no blur will come to remove the attribute.
        if (document.activeElement !== target) target.removeAttribute("tabindex");
        // Only our own value: a focus handler (roving tabindex) may have set its own meanwhile.
        else target.addEventListener("blur", function () {
          if (target.getAttribute("tabindex") === "-1") target.removeAttribute("tabindex");
        }, { once: true });
      }
    }
    window.addEventListener("click", function (event) {
      if (event.defaultPrevented) return;
      var fragment = fragmentOf(event);
      if (fragment === null) return;
      event.preventDefault();
      jump(fragment);
    });
  })();`;

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
  // openWorkspace() only asks; the host switches only after a user gesture in this frame.
  api.openWorkspace = function (workspaceId) {
    host.postMessage({ xumArtifact: ${ARTIFACT_BRIDGE_VERSION}, type: "openWorkspace", workspaceId: String(workspaceId) }, "*");
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
    // Announce after window load, the point where the host used to post state, so listeners an
    // artifact installs from its own DOMContentLoaded or load handlers still hear it. A task, not
    // a microtask: microtasks run between listener callbacks, so this would still fire before
    // the artifact's own load handlers (registered after this shim).
    window.addEventListener("load", function () {
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
  ${ARTIFACT_IN_PAGE_LINK_SCRIPT}
})();`;
}

/** JSON for an inline <script>: `<` becomes `\u003c`, so the HTML parser never sees a tag. */
function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
