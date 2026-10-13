/**
 * ChatGPT compatibility for MCP Apps views: `window.openai` (Apps SDK) on top of the standard
 * MCP Apps bridge, so a view built for ChatGPT renders in Xum. Injected as the second script of
 * every view document, after MCP_APP_PREAMBLE_SCRIPT and before any view script.
 *
 * SECURITY AUDIT: the shim adds no host power. It runs inside the view's own sandboxed document
 * (same opaque origin, same CSP) and only posts JSON-RPC messages the view could post itself
 * (ui/initialize, tools/call, ui/message, ui/open-link, ui/request-display-mode,
 * ui/notifications/*). Every check (frame gate, rate limits, visibility, consent, https-only
 * links, composer-only messages) stays in the host (mcpAppHost.ts, the backend), which cannot
 * tell shim messages from view messages. A view that redefines or tampers with `window.openai`
 * only changes what it sees: the shim keeps its own references (parent window, dispatch, event
 * constructor) from load and never reads `window.openai` back.
 *
 * Handshake: standard views initialize themselves, and the shim reads the host's replies and
 * notifications passively. The shim sends its own ui/initialize only when the view first uses
 * `window.openai` and no handshake was seen yet, so a standard-only view gets no extra
 * handshake. The host sends the tool lifecycle (tool-input, tool-result or tool-cancelled) once
 * per frame, so if the view's own client connects after the shim, the shim replays the
 * lifecycle it received to that client, in this page, and leaves teardown replies to it.
 * Members without a standard equivalent warn once; their Promises reject and nothing throws. setWidgetState updates window.openai.widgetState in this page only: the state
 * lasts as long as the frame (a collapsed card or a move to the tab starts with null). Optional
 * extensions Xum lacks (uploadFile, selectFiles, getFileDownloadUrl, requestCheckout,
 * requestModal) are absent, so `if (window.openai?.selectFiles)` takes the view's fallback.
 * Shapes: https://developers.openai.com/plugins/reference.md and the Apps SDK example types.
 */
/**
 * Host context the frame already knows when it builds the view document, so the globals are
 * right before any view script reads them (a widget may read theme or displayMode once at
 * load). Host-authored values only: nothing from the view or the tool result goes in here.
 */
export interface McpAppOpenAiSeed {
  theme: "light" | "dark";
  displayMode: string;
  locale: string;
  platform: string;
  /** The inline cap; null in a panel, whose frame is as tall as its container. */
  maxHeight: number | null;
}

export function mcpAppOpenAiShimScript(seed: McpAppOpenAiSeed): string {
  // SECURITY AUDIT: host data in a script element of the view's srcdoc. JSON text is a JS
  // expression; "<" only occurs inside its strings, where the \u003c escape is the same
  // character, so a value cannot close this script element ("</script>") or open an HTML
  // comment, and U+2028/U+2029 are escaped for older JS parsers.
  const seedJson = JSON.stringify({
    theme: seed.theme,
    displayMode: seed.displayMode,
    locale: seed.locale,
    platform: seed.platform,
    ...(seed.maxHeight != null ? { containerDimensions: { maxHeight: seed.maxHeight } } : {}),
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function () {
  "use strict";
  var parentWindow = window.parent;
  var dispatch = window.dispatchEvent.bind(window);
  var CustomEventCtor = window.CustomEvent;
  var MessageEventCtor = window.MessageEvent;
  var setTimer = window.setTimeout.bind(window);
  var warn = console.warn.bind(console);
  var media = typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
  var pending = new Map();
  var nextId = 1;
  var handshakeSeen = false;
  var ownHandshake = false;
  // A handshake reply that was not the shim's: the view's own MCP Apps client is connected.
  var standardClient = false;
  // The tool lifecycle as the host sent it ({ data, origin }), for a client that connects late.
  var lifecycle = [];
  var replaying = false;
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
    widgetState: null
  };
  var seeded = fromHostContext(${seedJson});
  for (var seedKey in seeded) globals[seedKey] = seeded[seedKey];
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

  // The view's own client connected after the shim's handshake took the host's one lifecycle:
  // hand it what arrived so far, as the host's messages (the SDK checks only event.source).
  // After this task, so the client has handled its initialize reply and sent initialized.
  // Page-local: nothing reaches the host, and later messages reach the client directly.
  function replayLifecycle() {
    var messages = lifecycle.slice();
    if (messages.length === 0) return;
    setTimer(function () {
      replaying = true;
      try {
        messages.forEach(function (message) {
          dispatch(new MessageEventCtor("message", {
            data: message.data,
            origin: message.origin,
            source: parentWindow
          }));
        });
      } finally {
        replaying = false;
      }
    }, 0);
  }

  window.addEventListener("message", function (event) {
    if (replaying || event.source !== parentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    var params = data.params && typeof data.params === "object" ? data.params : {};
    if (data.method === undefined) {
      if (data.result && typeof data.result === "object" && data.result.hostContext) {
        handshakeSeen = true;
        if (!pending.has(data.id) && !standardClient) {
          standardClient = true;
          if (ownHandshake) replayLifecycle();
        }
        setGlobals(fromHostContext(data.result.hostContext));
      }
      var settle = pending.get(data.id);
      if (settle !== undefined) {
        pending.delete(data.id);
        settle(data);
      }
      return;
    }
    if (
      data.method === "ui/notifications/tool-input" ||
      data.method === "ui/notifications/tool-result" ||
      data.method === "ui/notifications/tool-cancelled"
    ) {
      lifecycle.push({ data: data, origin: event.origin });
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
        // Only a view the shim connected, and whose own client never connected, has no SDK to
        // answer; an early reply here would end the host's wait before the SDK cleans up.
        if (ownHandshake && !standardClient) post({ jsonrpc: "2.0", id: data.id, result: {} });
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
      setGlobals({ widgetState: state === undefined ? null : state });
      return Promise.resolve();
    },
    setOpenInAppUrl: function () {
      warnOnce("setOpenInAppUrl");
    }
  };
  // requestClose is a plain runtime API in the reference (views call it unguarded), so it gets
  // a rejecting stub. Extensions (file APIs, checkout, requestModal) stay absent: the UI guide
  // feature-detects them (\`if (openai?.requestModal)\`) and picks a fallback.
  api.requestClose = function () {
    warnOnce("requestClose");
    return Promise.reject(new Error("window.openai.requestClose is not supported here"));
  };
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
