import { createInterface } from "node:readline";

/**
 * Legacy-protocol (2025-11-25) MCP stdio server exposing MCP Apps (SEP-1865) tools, for tests
 * and dogfooding the Artifacts tab host. Raw JSON-RPC on purpose (see identity-server.ts).
 *
 * - show_chart: model + app visible, view ui://chart/view, returns structuredContent.
 * - refresh_chart: app-only (hidden from the model), callable from the view.
 * - legacy_view: deprecated flat `_meta["ui/resourceUri"]`.
 * - capabilities_probe: echoes the client's initialize capabilities (gating tests).
 * Extra resources exercise the host's resources/read validation.
 */
const VIEW_URI = "ui://chart/view";

// The view implements the spec handshake by hand (no SDK), like a vite-singlefile bundle would.
export const CHART_VIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; }
  .bars { display: flex; gap: 6px; align-items: flex-end; height: 120px; }
  .bar { flex: 1; background: #6366f1; border-radius: 3px 3px 0 0; }
  button { margin-top: 8px; margin-right: 6px; }
  #log { font-size: 11px; color: #64748b; margin-top: 8px; white-space: pre-wrap; }
</style></head>
<body>
  <h3 id="title">Waiting for host...</h3>
  <div class="bars" id="bars"></div>
  <button id="refresh">Refresh (app-only tool)</button>
  <button id="again">Run show_chart again</button>
  <button id="ask">Ask in chat</button>
  <button id="link">Open docs</button>
  <div id="log"></div>
<script>
  var nextId = 1, pending = {};
  function log(t) { document.getElementById("log").textContent += t + "\\n"; }
  function send(msg) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function draw(data) {
    var bars = document.getElementById("bars"); bars.innerHTML = "";
    (data.values || []).forEach(function (v) {
      var b = document.createElement("div"); b.className = "bar"; b.style.height = v + "%"; bars.appendChild(b);
    });
    document.getElementById("title").textContent = data.title || "Chart";
    send({ method: "ui/notifications/size-changed", params: { width: document.body.scrollWidth, height: document.body.scrollHeight } });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data || {};
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-input") log("tool-input: " + JSON.stringify(m.params.arguments));
    if (m.method === "ui/notifications/tool-result") {
      log("tool-result received");
      if (m.params && m.params.structuredContent) draw(m.params.structuredContent);
    }
    if (m.method === "ui/notifications/host-context-changed") log("theme: " + (m.params.theme || "?"));
    if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ id: m.id, result: {} });
  });
  request("ui/initialize", {
    appInfo: { name: "chart-view", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26"
  }).then(function (init) {
    document.body.style.background = init.hostContext.theme === "dark" ? "#0b0b0b" : "#ffffff";
    document.body.style.color = init.hostContext.theme === "dark" ? "#e5e5e5" : "#111111";
    log("initialized; theme=" + init.hostContext.theme + " csp=" + JSON.stringify(init.hostCapabilities.sandbox.csp));
    send({ method: "ui/notifications/initialized", params: {} });
  });
  document.getElementById("refresh").onclick = function () {
    request("tools/call", { name: "refresh_chart", arguments: {} }).then(function (r) {
      draw(r.structuredContent); log("refresh_chart ok");
    }, function (e) { log("refresh_chart error: " + e.message); });
  };
  document.getElementById("again").onclick = function () {
    request("tools/call", { name: "show_chart", arguments: { title: "Again" } }).then(function (r) {
      draw(r.structuredContent); log("show_chart ok");
    }, function (e) { log("show_chart error: " + e.message); });
  };
  document.getElementById("ask").onclick = function () {
    request("ui/message", { role: "user", content: { type: "text", text: "Explain this chart" } });
  };
  document.getElementById("link").onclick = function () {
    request("ui/open-link", { url: "https://modelcontextprotocol.io/" });
  };
</script>
</body></html>`;

let clientCapabilities: unknown = null;
let refreshCount = 0;

function chartResult(title: string, values: number[]) {
  return {
    content: [{ type: "text", text: `${title}: ${values.join(", ")}` }],
    structuredContent: { title, values },
    _meta: { "fixture/raw": "kept for the view only" },
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: string | number;
    method: string;
    params?: {
      name?: string;
      uri?: string;
      capabilities?: unknown;
      arguments?: { title?: string };
    };
  };
  if (request.id === undefined) return;
  let result: Record<string, unknown> | undefined;
  switch (request.method) {
    case "initialize":
      clientCapabilities = request.params?.capabilities ?? null;
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "apps-fixture", version: "1", title: "Apps fixture" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "show_chart",
            title: "Show chart",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
            _meta: { ui: { resourceUri: VIEW_URI, visibility: ["model", "app"] } },
          },
          {
            name: "refresh_chart",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
          },
          {
            name: "legacy_view",
            inputSchema: { type: "object", properties: {} },
            _meta: { "ui/resourceUri": "ui://chart/legacy" },
          },
          { name: "capabilities_probe", inputSchema: { type: "object", properties: {} } },
        ],
      };
      break;
    case "tools/call": {
      const name = request.params?.name;
      if (name === "show_chart") {
        result = chartResult(
          request.params?.arguments?.title ?? "Quarterly revenue",
          [40, 75, 55, 90]
        );
      } else if (name === "refresh_chart") {
        refreshCount += 1;
        result = chartResult(`Refreshed ${refreshCount}`, [90, 30, 60, 20]);
      } else if (name === "legacy_view") {
        result = { content: [{ type: "text", text: "legacy" }] };
      } else if (name === "capabilities_probe") {
        result = { content: [{ type: "text", text: JSON.stringify(clientCapabilities) }] };
      }
      break;
    }
    case "resources/read": {
      const uri = request.params?.uri ?? "";
      const html = CHART_VIEW_HTML;
      if (uri === VIEW_URI) {
        result = {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: html,
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: ["https://cdn.jsdelivr.net", "https://evil.example"],
                    connectDomains: ["https://api.example.com"],
                  },
                  prefersBorder: true,
                },
              },
            },
          ],
        };
      } else if (uri === "ui://chart/blob") {
        result = {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              blob: Buffer.from(html).toString("base64"),
            },
          ],
        };
      } else if (uri === "ui://chart/wrong-mime") {
        result = { contents: [{ uri, mimeType: "text/html", text: html }] };
      } else if (uri === "ui://chart/big") {
        result = {
          contents: [
            { uri, mimeType: "text/html;profile=mcp-app", text: "x".repeat(2 * 1024 * 1024 + 1) },
          ],
        };
      }
      break;
    }
    case "ping":
      result = {};
      break;
  }
  const envelope =
    result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...envelope }) + "\n");
});
