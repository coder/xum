/** Shim -> host notification carrying window.openai widget state (Xum only, not MCP Apps). */
export const MCP_APP_WIDGET_STATE_METHOD = "xum/notifications/widget-state";
/** Widget state goes to the host at most this often; it stays under the bridge rate limit. */
const WIDGET_STATE_FLUSH_MS = 100;

/**
 * ChatGPT compatibility for MCP Apps views: `window.openai` (Apps SDK) on top of the standard
 * MCP Apps bridge, so a view built for ChatGPT renders in Xum. Injected as the second script of
 * every view document, after MCP_APP_PREAMBLE_SCRIPT and before any view script.
 *
 * SECURITY AUDIT: the shim adds no host power. It runs inside the view's own sandboxed document
 * (same opaque origin, same CSP) and only posts JSON-RPC messages the view could post itself
 * (ui/initialize, tools/call, ui/message, ui/open-link, ui/request-display-mode,
 * ui/notifications/*, and the widget-state notification, stored for that view only and size
 * capped by the host). The stored state comes back only into the same view's document, as
 * escaped JSON. Every check (frame gate, rate limits, visibility, consent, https-only
 * links, composer-only messages) stays in the host (mcpAppHost.ts, the backend), which cannot
 * tell shim messages from view messages. A view that redefines or tampers with `window.openai`
 * only changes what it sees: the shim keeps its own references (parent window, dispatch, event
 * constructor) from load and never reads `window.openai` back.
 *
 * Handshake: standard views initialize themselves, and the shim reads the host's replies and
 * notifications passively. The shim sends its own ui/initialize only when the view first uses
 * `window.openai` and no handshake was seen yet, so a standard-only view gets no extra
 * handshake. Members without a standard equivalent warn once; their Promises reject and
 * nothing throws. Optional
 * extensions Xum lacks (uploadFile, selectFiles, getFileDownloadUrl, requestCheckout) are
 * absent, so `if (window.openai?.selectFiles)` takes the view's fallback.
 * Shapes: https://developers.openai.com/plugins/reference.md and the Apps SDK example types.
 *
 * Widget state: setWidgetState stores the snapshot at once (window.openai.widgetState) and
 * sends it to the host (MCP_APP_WIDGET_STATE_METHOD, at most one message per
 * WIDGET_STATE_FLUSH_MS, and before a teardown reply). The host keeps it in renderer memory
 * per view, and the next mount of the view starts with it: `widgetStateJson` is written into
 * this script, so a view reading widgetState once at load (the Apps SDK example) sees it.
 */
export function mcpAppOpenAiShimScript(widgetStateJson: string | null): string {
  // SECURITY AUDIT: view data in a script element of the view's srcdoc. JSON text is a JS
  // expression; "<" only occurs inside its strings, where the \u003c escape is the same
  // character, so the data cannot close this script element ("</script>") or open an HTML
  // comment, and U+2028/U+2029 are escaped for older JS parsers. The state comes from this same
  // view (stored under the frame's own workspace and tool call, never a key from the message)
  // and returns only into this view's sandboxed document, so even a break-out could run
  // nothing the view could not already run.
  const initialWidgetState = (widgetStateJson ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function () {
  "use strict";
  var parentWindow = window.parent;
  var dispatch = window.dispatchEvent.bind(window);
  var CustomEventCtor = window.CustomEvent;
  var warn = console.warn.bind(console);
  var media = typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
  var setTimer = window.setTimeout.bind(window);
  var clearTimer = window.clearTimeout.bind(window);
  var stateTimer = null;
  var pending = new Map();
  var nextId = 1;
  var handshakeSeen = false;
  var ownHandshake = false;
  var warned = {};
  var globals = {
    theme: "light",
    userAgent: userAgentFor("desktop"),
    locale: navigator.language || "en",
    maxHeight: window.innerHeight,
    displayMode: "inline",
    safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    // null until ui/notifications/tool-input: the Apps SDK's "missing input" value, which
    // approval-gated views read as pending (an empty object would read as empty arguments).
    toolInput: null,
    toolOutput: null,
    toolResponseMetadata: null,
    widgetState: ${initialWidgetState}
  };
  setLang(globals.locale);

  function post(message) {
    parentWindow.postMessage(message, "*");
  }
  function setLang(locale) {
    try { document.documentElement.lang = locale; } catch (error) {}
  }
  function matches(query) {
    try { return media !== null && media(query).matches; } catch (error) { return false; }
  }
  function userAgentFor(platform) {
    return {
      device: { type: platform === "mobile" ? "mobile" : "desktop" },
      capabilities: { hover: matches("(hover: hover)"), touch: matches("(pointer: coarse)") }
    };
  }
  function setGlobals(patch) {
    for (var key in patch) globals[key] = patch[key];
    if (typeof patch.locale === "string") setLang(patch.locale);
    try {
      dispatch(new CustomEventCtor("openai:set_globals", { detail: { globals: patch } }));
    } catch (error) {}
  }
  function fromHostContext(context) {
    var patch = {};
    if (!context || typeof context !== "object") return patch;
    if (context.theme === "light" || context.theme === "dark") patch.theme = context.theme;
    if (typeof context.locale === "string") patch.locale = context.locale;
    if (typeof context.displayMode === "string") patch.displayMode = context.displayMode;
    var dimensions = context.containerDimensions;
    if (dimensions && typeof dimensions.maxHeight === "number") patch.maxHeight = dimensions.maxHeight;
    var insets = context.safeAreaInsets;
    if (insets && typeof insets === "object") patch.safeArea = { insets: insets };
    if (typeof context.platform === "string") patch.userAgent = userAgentFor(context.platform);
    return patch;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    var params = data.params && typeof data.params === "object" ? data.params : {};
    if (data.method === undefined) {
      if (data.result && typeof data.result === "object" && data.result.hostContext) {
        handshakeSeen = true;
        setGlobals(fromHostContext(data.result.hostContext));
      }
      var settle = pending.get(data.id);
      if (settle !== undefined) {
        pending.delete(data.id);
        settle(data);
      }
      return;
    }
    switch (data.method) {
      case "ui/notifications/tool-input":
        setGlobals({ toolInput: params.arguments || {} });
        return;
      case "ui/notifications/tool-result":
        setGlobals({
          toolOutput: params.structuredContent === undefined ? null : params.structuredContent,
          toolResponseMetadata: responseMetadata(params)
        });
        return;
      case "ui/notifications/host-context-changed":
        setGlobals(fromHostContext(params));
        return;
      case "ui/resource-teardown":
        // Listeners run in order and the shim's is first: the last state goes before the reply.
        flushWidgetState();
        // Only a view the shim connected has no SDK of its own to answer.
        if (ownHandshake) post({ jsonrpc: "2.0", id: data.id, result: {} });
        return;
    }
  });

  function request(method, params) {
    connect();
    return new Promise(function (resolve, reject) {
      var id = "xum-openai-" + nextId++;
      pending.set(id, function (response) {
        if (response.error) reject(new Error(String(response.error.message || "Request failed")));
        else resolve(response.result);
      });
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function connect() {
    if (handshakeSeen || ownHandshake) return;
    ownHandshake = true;
    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "xum-openai-shim", version: "1.0.0" },
      appCapabilities: {}
    }).then(function () {
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    }, function () {});
  }
  // The reference's toolResponseMetadata: "status, call_tool_result, and mcp_tool_result,
  // preserving the full MCP result envelope, including hidden _meta". The result's own _meta
  // keys stay on top as well, for views written when this global was the bare _meta.
  function responseMetadata(result) {
    var envelope = {};
    var meta = result._meta;
    if (meta && typeof meta === "object") for (var key in meta) envelope[key] = meta[key];
    envelope.status = result.isError === true ? "error" : "success";
    envelope.call_tool_result = result;
    envelope.mcp_tool_result = result;
    return envelope;
  }
  function flushWidgetState() {
    if (stateTimer === null) return;
    clearTimer(stateTimer);
    stateTimer = null;
    try {
      post({ jsonrpc: "2.0", method: "${MCP_APP_WIDGET_STATE_METHOD}", params: { state: globals.widgetState } });
    } catch (error) {
      warn("[Xum] window.openai.setWidgetState: the state cannot be stored", error);
    }
  }
  function warnOnce(name) {
    if (warned[name]) return;
    warned[name] = true;
    warn("[Xum] window.openai." + name + " is not supported here");
  }

  var api = {
    callTool: function (name, args) {
      return request("tools/call", { name: String(name), arguments: args || {} });
    },
    sendFollowUpMessage: function (args) {
      var prompt = String((args && args.prompt) || "");
      return request("ui/message", { role: "user", content: [{ type: "text", text: prompt }] })
        .then(function () {});
    },
    requestDisplayMode: function (args) {
      return request("ui/request-display-mode", { mode: String((args && args.mode) || "") });
    },
    notifyIntrinsicHeight: function (height) {
      connect();
      var value = typeof height === "object" && height !== null ? height.height : height;
      post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: Number(value) } });
    },
    openExternal: function (args) {
      request("ui/open-link", { url: String((args && args.href) || "") }).catch(function () {});
    },
    setWidgetState: function (state) {
      connect();
      setGlobals({ widgetState: state === undefined ? null : state });
      if (stateTimer === null) stateTimer = setTimer(flushWidgetState, ${WIDGET_STATE_FLUSH_MS});
      return Promise.resolve();
    },
    setOpenInAppUrl: function () {
      warnOnce("setOpenInAppUrl");
    }
  };
  // Members the Apps SDK's own API type always has get a rejecting stub. Optional extensions
  // (file APIs, checkout) stay absent: views feature-detect them and pick their fallback.
  ["requestModal", "requestClose"]
    .forEach(function (name) {
      api[name] = function () {
        warnOnce(name);
        return Promise.reject(new Error("window.openai." + name + " is not supported here"));
      };
    });
  Object.keys(globals).forEach(function (key) {
    Object.defineProperty(api, key, {
      enumerable: true,
      get: function () {
        connect();
        return globals[key];
      }
    });
  });
  try {
    Object.defineProperty(window, "openai", { value: api, writable: true, configurable: true });
  } catch (error) {}
})();`;
}
