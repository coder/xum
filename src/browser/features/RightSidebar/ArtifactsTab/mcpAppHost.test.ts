import { describe, expect, test } from "bun:test";
import type { McpAppToolCallResult } from "@/common/orpc/schemas/mcpApps";
import { MCP_APP_MODEL_CONTEXT_MAX_BYTES } from "@/common/utils/mcpApps";
import { passesFrameGate } from "./artifactBridge";
import {
  createMcpAppHost,
  MCP_APP_CONSENT_ARGS_MAX_BYTES,
  MCP_APP_MAX_HEIGHT,
  type McpAppConsentRequest,
  type McpAppDisplayMode,
  type McpAppHostOptions,
} from "./mcpAppHost";

function setup(overrides: Partial<McpAppHostOptions> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const calls: Array<{ toolName: string; consented: boolean }> = [];
  const reads: string[] = [];
  const modelContexts: string[] = [];
  const modeRequests: string[] = [];
  const moves: string[] = [];
  let displayMode: McpAppDisplayMode = "inline";
  const consents: McpAppConsentRequest[] = [];
  const composer: string[] = [];
  const opened: string[] = [];
  const sizes: Array<{ width?: number; height?: number }> = [];
  let initialized = 0;
  const host = createMcpAppHost({
    serverName: "charts",
    grantedCsp: { resourceDomains: [], connectDomains: [] },
    postToView: (message) => sent.push(message as Record<string, unknown>),
    getHostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode,
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 300, maxHeight: 600 },
      locale: "en",
      timeZone: "UTC",
      platform: "desktop",
      toolInfo: { id: "call-1", tool: { name: "show_chart" } },
    }),
    callTool: (toolName, _args, consented): Promise<McpAppToolCallResult> => {
      calls.push({ toolName, consented });
      if (toolName === "model_tool" && !consented)
        return Promise.resolve({ status: "consent_required" });
      if (toolName === "hidden")
        return Promise.resolve({ status: "rejected", reason: "not for apps" });
      return Promise.resolve({ status: "ok", result: { content: [] } });
    },
    readResource: (uri) => {
      reads.push(uri);
      if (uri === "ui://missing") return Promise.reject(new Error("Resource not found"));
      return Promise.resolve({ contents: [{ uri, mimeType: "text/plain", text: "data" }] });
    },
    updateModelContext: (text) => {
      modelContexts.push(text);
      return Promise.resolve();
    },
    setDisplayMode: (mode) => {
      modeRequests.push(mode);
      return () => {
        moves.push(mode);
        displayMode = mode;
      };
    },
    requestConsent: (request) => {
      consents.push(request);
      return Promise.resolve(true);
    },
    insertIntoComposer: (text) => composer.push(text),
    openExternalLink: (url) => opened.push(url),
    onSizeChanged: (size) => sizes.push(size),
    onInitialized: () => (initialized += 1),
    log: () => undefined,
    ...overrides,
  });
  const request = (id: number, method: string, params?: unknown) =>
    host.handleMessage({ jsonrpc: "2.0", id, method, params });
  const reply = (id: number) => sent.find((m) => m.id === id);
  const answered = new Set<unknown>();
  /** A display-mode request whose teardown the view answers, as the ext-apps SDK does. */
  const requestMode = async (id: number, mode: string) => {
    const done = request(id, "ui/request-display-mode", { mode });
    const teardown = sent.find((m) => m.method === "ui/resource-teardown" && !answered.has(m.id));
    if (teardown !== undefined) {
      answered.add(teardown.id);
      await host.handleMessage({ jsonrpc: "2.0", id: teardown.id, result: {} });
    }
    await done;
  };
  return {
    host,
    sent,
    calls,
    reads,
    modelContexts,
    modeRequests,
    moves,
    requestMode,
    setHostMode: (mode: McpAppDisplayMode) => (displayMode = mode),
    consents,
    composer,
    opened,
    sizes,
    request,
    reply,
    initialized: () => initialized,
  };
}

describe("MCP Apps host router", () => {
  test("frame gate rejects other windows", () => {
    const frame = Object.create(null) as Window;
    const other = Object.create(null) as Window;
    expect(passesFrameGate({ source: frame }, frame, () => true)).toBe(true);
    expect(passesFrameGate({ source: other }, frame, () => true)).toBe(false);
    expect(passesFrameGate({ source: frame }, frame, () => false)).toBe(false);
  });

  test("initialize advertises only implemented capabilities and the granted CSP", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", { appInfo: { name: "v" }, protocolVersion: "2026-01-26" });
    expect(t.reply(1)?.result).toMatchObject({
      protocolVersion: "2026-01-26",
      hostCapabilities: {
        serverTools: {},
        serverResources: {},
        logging: {},
        openLinks: {},
        sandbox: { csp: { resourceDomains: [], connectDomains: [] } },
      },
      hostContext: { displayMode: "inline", platform: "desktop", theme: "dark" },
    });
    const capabilities = (t.reply(1)?.result as { hostCapabilities: object }).hostCapabilities;
    expect(Object.keys(capabilities).sort()).toEqual([
      "logging",
      "openLinks",
      "sandbox",
      "serverResources",
      "serverTools",
      "updateModelContext",
    ]);
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(t.initialized()).toBe(1);
  });

  test("unknown methods get -32601 and malformed messages are rejected", async () => {
    const t = setup();
    for (const [id, method] of [
      [2, "resources/subscribe"],
      [3, "ui/request-teardown"],
      [4, "ui/request-pip"],
      [5, "sampling/createMessage"],
    ] as const) {
      await t.request(id, method, {});
      expect((t.reply(id)?.error as { code: number }).code).toBe(-32601);
    }
    await t.host.handleMessage({ jsonrpc: "1.0", id: 9, method: "ping" });
    expect((t.reply(9)?.error as { code: number }).code).toBe(-32600);
    await t.host.handleMessage("garbage");
    expect(t.sent).toHaveLength(5);
  });

  test("tools/call asks for consent only when the backend requires it", async () => {
    const t = setup();
    await t.request(1, "tools/call", { name: "app_tool", arguments: {} });
    expect(t.consents).toEqual([]);
    expect(t.reply(1)?.result).toEqual({ content: [] });

    await t.request(2, "tools/call", { name: "model_tool", arguments: { city: "Berlin" } });
    // The strip shows the exact arguments the allowed call sends.
    expect(t.consents).toEqual([
      { kind: "tool", toolName: "model_tool", serverName: "charts", args: { city: "Berlin" } },
    ]);
    expect(t.calls.slice(1)).toEqual([
      { toolName: "model_tool", consented: false },
      { toolName: "model_tool", consented: true },
    ]);

    await t.request(3, "tools/call", { name: "hidden" });
    expect(t.reply(3)?.error).toEqual({ code: -32000, message: "not for apps" });
  });

  test("a denied consent fails the call without calling again", async () => {
    const t = setup({ requestConsent: () => Promise.resolve(false) });
    await t.request(1, "tools/call", { name: "model_tool" });
    expect(t.calls).toEqual([{ toolName: "model_tool", consented: false }]);
    expect((t.reply(1)?.error as { code: number }).code).toBe(-32000);
  });

  test("arguments too large to review are declined without asking", async () => {
    const t = setup();
    const big = { pad: "x".repeat(MCP_APP_CONSENT_ARGS_MAX_BYTES) };
    await t.request(1, "tools/call", { name: "model_tool", arguments: big });
    expect(t.consents).toEqual([]);
    expect(t.calls).toEqual([{ toolName: "model_tool", consented: false }]);
    expect(t.reply(1)?.error).toEqual({
      code: -32000,
      message: "The tool arguments are too large to review",
    });
    // Just under the cap still asks.
    const fits = { pad: "x".repeat(MCP_APP_CONSENT_ARGS_MAX_BYTES - 20) };
    await t.request(2, "tools/call", { name: "model_tool", arguments: fits });
    expect(t.consents).toHaveLength(1);
  });

  test("open-link accepts https only, after confirmation", async () => {
    const t = setup();
    await t.request(1, "ui/open-link", { url: "javascript:alert(1)" });
    await t.request(2, "ui/open-link", { url: "http://example.com" });
    await t.request(3, "ui/open-link", { url: "https://example.com/docs" });
    expect((t.reply(1)?.error as { code: number }).code).toBe(-32602);
    expect((t.reply(2)?.error as { code: number }).code).toBe(-32602);
    expect(t.reply(3)?.result).toEqual({});
    expect(t.consents).toEqual([
      { kind: "link", url: "https://example.com/docs", host: "example.com" },
    ]);
    expect(t.opened).toEqual(["https://example.com/docs"]);
  });

  test("open-link refuses URLs with credentials, which disguise the real host", async () => {
    // https://trusted.example@evil.example/ opens evil.example.
    const t = setup();
    await t.request(1, "ui/open-link", { url: "https://trusted.example@evil.example/" });
    await t.request(2, "ui/open-link", { url: "https://user:pw@evil.example/" });
    expect((t.reply(1)?.error as { code: number }).code).toBe(-32602);
    expect((t.reply(2)?.error as { code: number }).code).toBe(-32602);
    expect(t.consents).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  test("ui/message fills the composer only after the user confirms the insert", async () => {
    const t = setup();
    await t.request(1, "ui/message", { role: "user", content: { type: "text", text: "hi" } });
    expect(t.consents).toEqual([{ kind: "message", text: "hi" }]);
    expect(t.composer).toEqual(["hi"]);
    expect(t.reply(1)?.result).toEqual({});
    await t.request(2, "ui/message", { role: "assistant", content: { type: "text", text: "x" } });
    expect(t.composer).toEqual(["hi"]);

    const dismissed = setup({ requestConsent: () => Promise.resolve(false) });
    await dismissed.request(3, "ui/message", {
      role: "user",
      content: { type: "text", text: "while typing" },
    });
    expect(dismissed.composer).toEqual([]);
    expect((dismissed.reply(3)?.error as { code: number }).code).toBe(-32000);
  });

  test("size changes are clamped and teardown waits for the reply", async () => {
    const t = setup();
    await t.host.handleMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 200, height: 1e9 },
    });
    expect(t.sizes).toEqual([{ width: 200, height: MCP_APP_MAX_HEIGHT }]);
    const done = t.host.teardown("closed");
    const teardown = t.sent.at(-1) as { id: string; method: string };
    expect(teardown.method).toBe("ui/resource-teardown");
    await t.host.handleMessage({ jsonrpc: "2.0", id: teardown.id, result: {} });
    await done;
  });

  test("resources/read goes to the view's own server and returns its result", async () => {
    const t = setup();
    await t.request(1, "resources/read", { uri: "ui://charts/data.json" });
    expect(t.reads).toEqual(["ui://charts/data.json"]);
    expect(t.reply(1)?.result).toEqual({
      contents: [{ uri: "ui://charts/data.json", mimeType: "text/plain", text: "data" }],
    });
    // The server's failure (e.g. a URI it does not serve) reaches the view as an error.
    await t.request(2, "resources/read", { uri: "ui://missing" });
    expect(t.reply(2)?.error).toEqual({ code: -32000, message: "Resource not found" });
    await t.request(3, "resources/read", {});
    expect((t.reply(3)?.error as { code: number }).code).toBe(-32602);
    expect(t.reads).toHaveLength(2);
  });

  test("resources/read shares the tools/call budget", async () => {
    const t = setup();
    for (let id = 1; id <= 4; id++) await t.request(id, "tools/call", { name: "app_tool" });
    await t.request(5, "resources/read", { uri: "ui://charts/a" });
    await t.request(6, "resources/read", { uri: "ui://charts/b" });
    expect(t.reads).toEqual(["ui://charts/a"]);
    expect((t.reply(6)?.error as { code: number }).code).toBe(-32000);
  });

  test("ui/message accepts the content-block array form, after the same confirm", async () => {
    const t = setup();
    await t.request(1, "ui/message", {
      role: "user",
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      // ChatGPT's send hint is ignored: the text is only inserted, never sent.
      _meta: { "openai/message": { send: true } },
    });
    expect(t.consents).toEqual([{ kind: "message", text: "line one\nline two" }]);
    expect(t.composer).toEqual(["line one\nline two"]);
    expect(t.reply(1)?.result).toEqual({});

    const declined = setup({ requestConsent: () => Promise.resolve(false) });
    await declined.request(2, "ui/message", {
      role: "user",
      content: [{ type: "text", text: "x" }],
    });
    expect(declined.composer).toEqual([]);
  });

  test("ui/message rejects non-text or empty content without asking", async () => {
    const t = setup();
    await t.request(1, "ui/message", {
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    await t.request(2, "ui/message", { role: "user", content: [] });
    await t.request(3, "ui/message", {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(20_000) },
        { type: "text", text: "x".repeat(20_000) },
      ],
    });
    for (const id of [1, 2, 3]) expect((t.reply(id)?.error as { code: number }).code).toBe(-32602);
    expect(t.consents).toEqual([]);
    expect(t.composer).toEqual([]);
  });

  test("a view that checks the host capability before updating model context sends it", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", { appInfo: { name: "v" }, protocolVersion: "2026-01-26" });
    // Gates like an ext-apps view: it sends only the modalities the host advertises.
    const { hostCapabilities } = t.reply(1)?.result as {
      hostCapabilities: { updateModelContext?: { text?: object; structuredContent?: object } };
    };
    const supported = hostCapabilities.updateModelContext;
    if (supported !== undefined) {
      await t.request(2, "ui/update-model-context", {
        ...(supported.text !== undefined ? { content: [{ type: "text", text: "3 dice" }] } : {}),
        ...(supported.structuredContent !== undefined
          ? { structuredContent: { dice: [1, 2, 3] } }
          : {}),
      });
    }
    expect(t.modelContexts).toEqual(['3 dice\n\n{"dice":[1,2,3]}']);
  });

  test("model context is stored only after the user allows it, once per mounted view", async () => {
    const declined = setup({ requestConsent: () => Promise.resolve(false) });
    await declined.request(1, "ui/update-model-context", {
      content: [{ type: "text", text: "3 dice" }],
    });
    expect(declined.reply(1)?.error).toEqual({ code: -32000, message: "Context update denied" });
    expect(declined.modelContexts).toEqual([]);
    // Clearing needs no consent.
    await declined.request(2, "ui/update-model-context", {});
    expect(declined.reply(2)?.result).toEqual({});
    expect(declined.modelContexts).toEqual([""]);

    const t = setup();
    await t.request(1, "ui/update-model-context", { content: [{ type: "text", text: "3 dice" }] });
    await t.request(2, "ui/update-model-context", { content: [{ type: "text", text: "2 dice" }] });
    expect(t.consents).toEqual([{ kind: "context", text: "3 dice" }]);
    expect(t.modelContexts).toEqual(["3 dice", "2 dice"]);
    // A remounted view gets a new host, which asks again.
    const remounted = setup();
    await remounted.request(1, "ui/update-model-context", {
      content: [{ type: "text", text: "2 dice" }],
    });
    expect(remounted.consents).toEqual([{ kind: "context", text: "2 dice" }]);
  });

  test("update-model-context replaces the view's context with the latest update", async () => {
    const t = setup();
    await t.request(1, "ui/update-model-context", {
      content: [{ type: "text", text: "3 dice" }],
      structuredContent: { dice: [1, 2, 3] },
    });
    await t.request(2, "ui/update-model-context", { content: [{ type: "text", text: "2 dice" }] });
    // An empty update clears the context.
    await t.request(3, "ui/update-model-context", {});
    expect(t.modelContexts).toEqual(['3 dice\n\n{"dice":[1,2,3]}', "2 dice", ""]);
    for (const id of [1, 2, 3]) expect(t.reply(id)?.result).toEqual({});
  });

  test("update-model-context rejects non-text content and text over 16 KB", async () => {
    const t = setup();
    await t.request(1, "ui/update-model-context", {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    await t.request(2, "ui/update-model-context", {
      content: [{ type: "text", text: "x".repeat(MCP_APP_MODEL_CONTEXT_MAX_BYTES + 1) }],
    });
    // Multi-byte text counts in UTF-8 bytes.
    await t.request(3, "ui/update-model-context", {
      content: [{ type: "text", text: "é".repeat(MCP_APP_MODEL_CONTEXT_MAX_BYTES / 2 + 1) }],
    });
    for (const id of [1, 2, 3]) expect((t.reply(id)?.error as { code: number }).code).toBe(-32602);
    await t.request(4, "ui/update-model-context", {
      content: [{ type: "text", text: "x".repeat(MCP_APP_MODEL_CONTEXT_MAX_BYTES) }],
    });
    expect(t.reply(4)?.result).toEqual({});
    expect(t.modelContexts).toHaveLength(1);
  });

  test("request-display-mode round trip notifies host-context-changed", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", {
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    expect(t.reply(1)?.result).toMatchObject({
      hostContext: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
    });
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    const changes = () =>
      t.sent
        .filter((m) => m.method === "ui/notifications/host-context-changed")
        .map((m) => m.params);
    await t.requestMode(2, "fullscreen");
    expect(t.reply(2)?.result).toEqual({ mode: "fullscreen" });
    expect(changes()).toEqual([{ displayMode: "fullscreen" }]);
    expect(t.moves).toEqual(["fullscreen"]);
    // The move replaced that instance; the one in the tab (fullscreen) asks for inline.
    const tab = setup();
    tab.setHostMode("fullscreen");
    await tab.request(1, "ui/initialize", {});
    await tab.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await tab.requestMode(2, "inline");
    expect(tab.reply(2)?.result).toEqual({ mode: "inline" });
    expect(tab.moves).toEqual(["inline"]);
    // A change from outside the view (closing it in Artifacts) notifies once.
    const tabChanges = () =>
      tab.sent
        .filter((m) => m.method === "ui/notifications/host-context-changed")
        .map((m) => m.params);
    tab.host.displayModeChanged("fullscreen");
    tab.host.displayModeChanged("inline");
    tab.host.displayModeChanged("inline");
    expect(tabChanges()).toEqual([
      { displayMode: "inline" },
      { displayMode: "fullscreen" },
      { displayMode: "inline" },
    ]);
  });

  test("unknown, unavailable or undeclared modes return the current mode", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", { appCapabilities: { availableDisplayModes: ["inline"] } });
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await t.request(2, "ui/request-display-mode", { mode: "pip" });
    await t.request(3, "ui/request-display-mode", { mode: "theater" });
    // The view did not declare fullscreen: the host must not switch it there.
    await t.request(4, "ui/request-display-mode", { mode: "fullscreen" });
    for (const id of [2, 3, 4]) expect(t.reply(id)?.result).toEqual({ mode: "inline" });
    await t.request(5, "ui/request-display-mode", {});
    expect((t.reply(5)?.error as { code: number }).code).toBe(-32602);
    expect(t.modeRequests).toEqual([]);
    expect(t.sent.some((m) => m.method === "ui/notifications/host-context-changed")).toBe(false);
  });

  test("a view that did not declare fullscreen is never told it is fullscreen", async () => {
    // Shown in the Artifacts tab, where the host's own mode is fullscreen.
    for (const [declared, told] of [
      [["inline"], "inline"],
      [["inline", "fullscreen"], "fullscreen"],
      [undefined, "fullscreen"],
    ] as const) {
      const t = setup();
      t.setHostMode("fullscreen");
      await t.request(1, "ui/initialize", {
        appCapabilities: declared === undefined ? {} : { availableDisplayModes: declared },
      });
      expect(t.reply(1)?.result).toMatchObject({ hostContext: { displayMode: told } });
      await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      await t.requestMode(2, "inline");
      if (told === "inline") {
        // Already inline for the view: nothing changes (the view stays in the Artifacts tab).
        expect(t.reply(2)?.result).toEqual({ mode: "inline" });
        expect(t.modeRequests).toEqual([]);
        t.host.displayModeChanged("inline");
        t.host.displayModeChanged("fullscreen");
        expect(t.sent.some((m) => m.method === "ui/notifications/host-context-changed")).toBe(
          false
        );
      } else {
        expect(t.modeRequests).toEqual(["inline"]);
      }
    }
  });

  test("the requester gets its display-mode reply before the move unmounts it", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", {});
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    const done = t.request(2, "ui/request-display-mode", { mode: "fullscreen" });
    // Reply and teardown are posted; the view has not answered the teardown yet: no move.
    expect(t.sent.map((m) => m.id ?? m.method).slice(-3)).toEqual([
      2,
      "ui/notifications/host-context-changed",
      "host-1",
    ]);
    expect(t.reply(2)?.result).toEqual({ mode: "fullscreen" });
    expect(t.moves).toEqual([]);
    await t.host.handleMessage({ jsonrpc: "2.0", id: "host-1", result: {} });
    await done;
    expect(t.moves).toEqual(["fullscreen"]);
  });

  test("requests before a pending move runs are answered with the pending mode", async () => {
    const t = setup();
    await t.request(1, "ui/initialize", {});
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    const done = t.request(2, "ui/request-display-mode", { mode: "fullscreen" });
    // The view got its reply and asks again before answering the teardown.
    await t.request(3, "ui/request-display-mode", { mode: "inline" });
    await t.request(4, "ui/request-display-mode", { mode: "fullscreen" });
    expect(t.reply(3)?.result).toEqual({ mode: "fullscreen" });
    expect(t.reply(4)?.result).toEqual({ mode: "fullscreen" });
    await t.host.handleMessage({ jsonrpc: "2.0", id: "host-1", result: {} });
    await done;
    // One move, to the mode every reply named.
    expect(t.modeRequests).toEqual(["fullscreen"]);
    expect(t.moves).toEqual(["fullscreen"]);
  });

  test("a mode the host cannot show now returns the current mode and does not move", async () => {
    const t = setup({ setDisplayMode: () => null });
    await t.request(1, "ui/initialize", {});
    await t.host.handleMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await t.request(2, "ui/request-display-mode", { mode: "fullscreen" });
    expect(t.reply(2)?.result).toEqual({ mode: "inline" });
    expect(t.sent.some((m) => m.method === "ui/resource-teardown")).toBe(false);
  });

  test("text blocks are not read past the length limit", async () => {
    const t = setup();
    // Counts reads of each block after the one that crosses the limit.
    let laterBlockReads = 0;
    const laterBlock = {
      type: "text",
      get text() {
        laterBlockReads += 1;
        return "z";
      },
    };
    await t.request(1, "ui/message", {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(32_000) },
        { type: "text", text: "y" },
        laterBlock,
      ],
    });
    await t.request(2, "ui/update-model-context", {
      content: [
        { type: "text", text: "x".repeat(MCP_APP_MODEL_CONTEXT_MAX_BYTES) },
        { type: "text", text: "y" },
        laterBlock,
      ],
    });
    for (const id of [1, 2]) expect((t.reply(id)?.error as { code: number }).code).toBe(-32602);
    expect(laterBlockReads).toBe(0);
    expect(t.consents).toEqual([]);
    expect(t.modelContexts).toEqual([]);
  });

  test("update-model-context answers -32602 for structured content JSON cannot encode", async () => {
    const t = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await t.request(1, "ui/update-model-context", { structuredContent: cyclic });
    await t.request(2, "ui/update-model-context", { structuredContent: { count: BigInt(3) } });
    for (const id of [1, 2]) expect((t.reply(id)?.error as { code: number }).code).toBe(-32602);
    expect(t.modelContexts).toEqual([]);
  });
});
