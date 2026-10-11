// Bootstrap Happy DOM before the document builders run (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDom } from "../../../../../tests/ui/dom";
import { finalizeSandboxedDocument, parseArtifactHtml } from "./artifactDocument";
import { buildMcpAppCsp, MCP_APP_PREAMBLE_SCRIPT } from "./mcpAppCsp";
import { createMcpAppHost, type McpAppConsentRequest } from "./mcpAppHost";
import { mcpAppOpenAiShimScript, type McpAppOpenAiSeed } from "./mcpAppOpenAiShim";

interface OpenAi {
  toolOutput: unknown;
  toolResponseMetadata: unknown;
  widgetState: unknown;
  locale: string;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  sendFollowUpMessage(args: { prompt: string }): Promise<void>;
}
type ViewWindow = Window & {
  openai: OpenAi;
  events: Array<Record<string, unknown>>;
  done?: boolean;
};

const GRANTED = { resourceDomains: [], connectDomains: [] };

/** The document McpAppFrame builds: CSP meta, preamble, shim, then the view. */
const SEED: McpAppOpenAiSeed = {
  theme: "light",
  displayMode: "inline",
  locale: "en-US",
  platform: "desktop",
  maxHeight: 600,
};

function viewDocument(viewHtml: string, seed: McpAppOpenAiSeed = SEED): string {
  return finalizeSandboxedDocument(parseArtifactHtml(viewHtml), {
    csp: buildMcpAppCsp(GRANTED),
    bridgeScript: [MCP_APP_PREAMBLE_SCRIPT, mcpAppOpenAiShimScript(seed)],
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run a view document (scripts on) in its own happy-dom window, wired to a real host through a
 * fake parent window, like McpAppFrame wires the iframe.
 */
async function runView(
  viewScript: string,
  options: {
    consent?: boolean;
    beforeLoad?: (win: Window) => void;
    seed?: McpAppOpenAiSeed;
    /** The host does not answer (yet): what the view sees before any handshake reply. */
    silentHost?: boolean;
  } = {}
) {
  const win = new Window({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  }) as unknown as ViewWindow;
  // Bun's vm contexts lack the JS builtins happy-dom expects there; lend this realm's.
  for (const name of ["Object", "Array", "Map", "Promise", "JSON", "String", "Number", "Error"]) {
    Object.defineProperty(win, name, { value: (globalThis as Record<string, unknown>)[name] });
  }
  const warnings: string[] = [];
  win.console.warn = (message: string) => warnings.push(message);
  const posted: Array<{ method?: string; params?: unknown }> = [];
  const consents: McpAppConsentRequest[] = [];
  const composer: string[] = [];
  const calls: Array<{ toolName: string; args: unknown }> = [];
  const parent = {
    postMessage: (message: { method?: string; params?: unknown }) => {
      posted.push(message);
      if (!options.silentHost) void host.handleMessage(message);
    },
  };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const host = createMcpAppHost({
    serverName: "dice",
    grantedCsp: GRANTED,
    postToView: (data) =>
      win.dispatchEvent(new win.MessageEvent("message", { data, source: parent as never })),
    getHostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 300, maxHeight: 600 },
      locale: "de-DE",
      timeZone: "UTC",
      platform: "desktop",
      toolInfo: { id: "call-1", tool: { name: "roll" } },
    }),
    callTool: (toolName, args) => {
      calls.push({ toolName, args });
      return Promise.resolve({ status: "ok", result: { structuredContent: { rolled: [4] } } });
    },
    readResource: () => Promise.reject(new Error("unused")),
    updateModelContext: () => Promise.resolve(),
    setDisplayMode: () => null,
    requestConsent: (request) => {
      consents.push(request);
      return Promise.resolve(options.consent ?? true);
    },
    insertIntoComposer: (text) => composer.push(text),
    openExternalLink: () => undefined,
    onSizeChanged: () => undefined,
    onInitialized: () => {
      host.sendToolInput({ count: 2 });
      host.sendToolResult({ structuredContent: { dice: [3, 5] }, _meta: { seed: 7 } });
    },
    log: () => undefined,
  });
  options.beforeLoad?.(win);
  win.document.write(
    viewDocument(
      `<html><head></head><body><script>${viewScript}</script></body></html>`,
      options.seed
    )
  );
  for (let i = 0; i < 5; i++) await tick();
  return { win, host, posted, consents, composer, calls, warnings };
}

const COLLECT_EVENTS = `window.events = [];
window.addEventListener("openai:set_globals", function (e) { window.events.push(e.detail.globals); });`;

describe("window.openai shim", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("toolOutput and toolResponseMetadata follow tool-result, with openai:set_globals", async () => {
    const t = await runView(
      `${COLLECT_EVENTS} window.first = window.openai.toolOutput; window.firstInput = window.openai.toolInput;`
    );
    expect((t.win as unknown as { first: unknown }).first).toBeNull();
    // Before tool-input, toolInput is the Apps SDK's missing-input null, not empty arguments.
    expect((t.win as unknown as { firstInput: unknown }).firstInput).toBeNull();
    expect((t.win.openai as unknown as { toolInput: unknown }).toolInput).toEqual({ count: 2 });
    expect(t.win.openai.toolOutput).toEqual({ dice: [3, 5] });
    // The reference's envelope (status, call_tool_result, mcp_tool_result) with the whole
    // result, hidden _meta included; the _meta keys stay readable at the top too.
    const result = { structuredContent: { dice: [3, 5] }, _meta: { seed: 7 } };
    const metadata = {
      seed: 7,
      status: "success",
      call_tool_result: result,
      mcp_tool_result: result,
    };
    expect(t.win.openai.toolResponseMetadata).toEqual(metadata);
    expect(t.win.events).toContainEqual({ toolInput: { count: 2 } });
    expect(t.win.events).toContainEqual({
      toolOutput: { dice: [3, 5] },
      toolResponseMetadata: metadata,
    });
    // The host context reaches the globals and the document language.
    expect(t.win.openai.locale).toBe("de-DE");
    expect(t.win.document.documentElement.lang).toBe("de-DE");
    // host-context-changed fires the event too.
    t.host.sendHostContextChanged({ theme: "light" });
    expect(t.win.events.at(-1)).toEqual({ theme: "light" });
  });

  test("callTool sends tools/call and resolves with the result", async () => {
    const t = await runView("");
    const result = await t.win.openai.callTool("reroll", { die: 1 });
    expect(t.calls).toEqual([{ toolName: "reroll", args: { die: 1 } }]);
    expect(result).toEqual({ structuredContent: { rolled: [4] } });
  });

  test("sendFollowUpMessage goes through ui/message, so Xum asks first and never sends", async () => {
    const t = await runView("");
    await t.win.openai.sendFollowUpMessage({ prompt: "Roll again" });
    expect(t.posted.some((m) => m.method === "ui/message")).toBe(true);
    expect(t.consents).toEqual([{ kind: "message", text: "Roll again" }]);
    expect(t.composer).toEqual(["Roll again"]);
    const declined = await runView("", { consent: false });
    let rejected = false;
    await declined.win.openai.sendFollowUpMessage({ prompt: "x" }).catch(() => (rejected = true));
    expect(rejected).toBe(true);
    expect(declined.composer).toEqual([]);
  });

  test("unsupported members never throw and warn once each; widgetState lives in the page", async () => {
    const t = await runView(`
      var o = window.openai;
      window.widget = o.widgetState;
      o.requestClose().catch(function () {});
      o.requestClose().catch(function () {});
      o.setWidgetState({ a: 1 });
      window.widgetAfter = o.widgetState;
      o.setOpenInAppUrl({ href: "https://example.com" });
      // The Apps SDK feature-detection pattern: no file APIs here, so the view uses its own.
      window.picker = o.selectFiles ? "library" : o.uploadFile ? "upload" : "own input";
      window.modal = o.requestModal ? "host modal" : "own dialog";
      window.done = true;`);
    expect(t.win.done).toBe(true);
    expect((t.win as unknown as { widget: unknown }).widget).toBeNull();
    // The Apps SDK reads its snapshot back synchronously after setWidgetState.
    expect((t.win as unknown as { widgetAfter: unknown }).widgetAfter).toEqual({ a: 1 });
    expect((t.win as unknown as { picker: unknown }).picker).toBe("own input");
    expect((t.win as unknown as { modal: unknown }).modal).toBe("own dialog");
    expect(t.warnings).toHaveLength(2);
  });

  test("host context is in the globals before any view script reads them", async () => {
    // A host value with "</script>" or "<!--" cannot end the shim's script element.
    const locale = "x</script><!--<script>window.broken = 1</script>";
    const t = await runView(
      `window.first = { theme: window.openai.theme, mode: window.openai.displayMode,
        max: window.openai.maxHeight, locale: window.openai.locale,
        device: window.openai.userAgent.device.type };`,
      {
        seed: {
          theme: "dark",
          displayMode: "fullscreen",
          locale,
          platform: "mobile",
          maxHeight: 321,
        },
        silentHost: true,
      }
    );
    expect((t.win as unknown as { first: unknown }).first).toEqual({
      theme: "dark",
      mode: "fullscreen",
      max: 321,
      locale,
      device: "mobile",
    });
    expect((t.win as unknown as { broken?: number }).broken).toBeUndefined();
  });

  /** The view's own MCP Apps client connecting after the shim did (a hybrid view). */
  function connectStandardClient(t: Awaited<ReturnType<typeof runView>>) {
    const received: string[] = [];
    const parent = t.win.parent as unknown as { postMessage: (message: unknown) => void };
    t.win.addEventListener("message", (event) => {
      const { data, source } = event as unknown as { data: { method?: string }; source: unknown };
      // The ext-apps SDK's PostMessageTransport accepts only messages from window.parent.
      if (source === parent && data.method !== undefined) received.push(data.method);
    });
    parent.postMessage({ jsonrpc: "2.0", id: 99, method: "ui/initialize", params: {} });
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    return received;
  }

  test("a standard client that connects after the shim gets the lifecycle from the shim", async () => {
    const t = await runView("window.openai.toolOutput;");
    expect(t.win.openai.toolOutput).toEqual({ dice: [3, 5] });
    const fromHost = () => t.posted.length;
    const before = fromHost();
    const received = connectStandardClient(t);
    for (let i = 0; i < 3; i++) await tick();
    expect(received).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    // Replayed in the page: the host sent the client its initialize reply and nothing more.
    expect(t.posted.slice(before).map((m) => m.method)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
    ]);
  });

  test("a standard-only view gets the lifecycle once, with no shim handshake", async () => {
    const t = await runView(`
      window.got = [];
      window.addEventListener("message", function (e) {
        if (e.source !== window.parent) return;
        if (e.data.method) window.got.push(e.data.method);
        if (e.data.id === 1) window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
      });
      window.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, "*");`);
    for (let i = 0; i < 3; i++) await tick();
    expect((t.win as unknown as { got: string[] }).got).toEqual([
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    expect(t.posted.filter((m) => m.method === "ui/initialize")).toHaveLength(1);
  });

  test("the shim stops answering teardown once the view's own client connected", async () => {
    const teardownReplies = (t: Awaited<ReturnType<typeof runView>>) =>
      t.posted.filter((m) => (m as { id?: unknown }).id === "host-1").length;
    const shimOnly = await runView("window.openai.toolOutput;");
    void shimOnly.host.teardown("unmount");
    expect(teardownReplies(shimOnly)).toBe(1);
    const hybrid = await runView("window.openai.toolOutput;");
    connectStandardClient(hybrid);
    void hybrid.host.teardown("unmount");
    expect(teardownReplies(hybrid)).toBe(0);
  });

  test("a view that redefines window.openai, before or after load, keeps rendering", async () => {
    const before = await runView("window.done = true;", {
      beforeLoad: (win) =>
        Object.defineProperty(win, "openai", { value: 1, writable: false, configurable: false }),
    });
    expect(before.win.done).toBe(true);
    // After load: the shim keeps its own references, so the event still fires.
    const after = await runView(`${COLLECT_EVENTS} window.openai.toolOutput; window.openai = {};`);
    expect(after.win.events.find((e) => "toolOutput" in e)?.toolOutput).toEqual({ dice: [3, 5] });
  });

  test("the CSP allows the shim, and runs it before any CSP the view adds", () => {
    // A nonce or hash source makes browsers ignore 'unsafe-inline', which would block the shim.
    const scriptSrc = buildMcpAppCsp({
      resourceDomains: ["https://cdn.jsdelivr.net"],
      connectDomains: [],
    })
      .split("; ")
      .find((directive) => directive.startsWith("script-src "))!
      .split(" ");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc.some((source) => /^'(nonce-|sha(256|384|512)-)/.test(source))).toBe(false);
    // A meta CSP only governs what follows it: the shim has run before the view's own policy.
    const html = viewDocument(
      `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc'"></head><body></body></html>`
    );
    expect(html.indexOf("xum-openai-shim")).toBeGreaterThan(0);
    expect(html.indexOf("xum-openai-shim")).toBeLessThan(html.indexOf("'nonce-abc'"));
  });
});
