// Bootstrap Happy DOM before the document builders run (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDom } from "../../../../../tests/ui/dom";
import { finalizeSandboxedDocument, parseArtifactHtml } from "./artifactDocument";
import { buildMcpAppCsp, MCP_APP_PREAMBLE_SCRIPT } from "./mcpAppCsp";
import { createMcpAppHost, type McpAppConsentRequest } from "./mcpAppHost";
import { mcpAppOpenAiShimScript } from "./mcpAppOpenAiShim";

interface OpenAi {
  toolOutput: unknown;
  toolResponseMetadata: unknown;
  widgetState: unknown;
  locale: string;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  sendFollowUpMessage(args: { prompt: string }): Promise<void>;
  setWidgetState(state: unknown): Promise<void>;
}
type ViewWindow = Window & {
  openai: OpenAi;
  events: Array<Record<string, unknown>>;
  done?: boolean;
};

const GRANTED = { resourceDomains: [], connectDomains: [] };

/** The document McpAppFrame builds: CSP meta, preamble, shim, then the view. */
function viewDocument(viewHtml: string, widgetState: string | null = null): string {
  return finalizeSandboxedDocument(parseArtifactHtml(viewHtml), {
    csp: buildMcpAppCsp(GRANTED),
    bridgeScript: [MCP_APP_PREAMBLE_SCRIPT, mcpAppOpenAiShimScript(widgetState)],
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
    /** The view's stored widget state (JSON), as McpAppFrame passes it. */
    widgetState?: string;
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
  const savedStates: string[] = [];
  const parent = {
    postMessage: (message: { method?: string; params?: unknown }) => {
      posted.push(message);
      void host.handleMessage(message);
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
    saveWidgetState: (json) => savedStates.push(json),
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
      options.widgetState
    )
  );
  for (let i = 0; i < 5; i++) await tick();
  return { win, host, posted, consents, composer, calls, warnings, savedStates };
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

  test("unsupported members never throw, warn once each, and widgetState reads null", async () => {
    const t = await runView(`
      var o = window.openai;
      window.widget = o.widgetState;
      ["requestModal", "requestClose"].forEach(function (name) { o[name]({}).catch(function () {}); o[name]({}).catch(function () {}); });
      o.setWidgetState({ a: 1 });
      o.setOpenInAppUrl({ href: "https://example.com" });
      // The Apps SDK feature-detection pattern: no file APIs here, so the view uses its own.
      window.picker = o.selectFiles ? "library" : o.uploadFile ? "upload" : "own input";
      window.done = true;`);
    expect(t.win.done).toBe(true);
    expect((t.win as unknown as { widget: unknown }).widget).toBeNull();
    expect((t.win as unknown as { picker: unknown }).picker).toBe("own input");
    expect(t.warnings).toHaveLength(3);
  });

  test("widget state is stored at once, reaches the host, and starts the next mount", async () => {
    // A string that would end the shim's script element if it were not escaped.
    const state = { selected: "</script><b>x</b>", n: 3 };
    const t = await runView(`
      window.openai.setWidgetState({ n: 1 });
      window.openai.setWidgetState(${JSON.stringify(state).replace(/</g, "\\u003c")});
      window.read = window.openai.widgetState;`);
    expect((t.win as unknown as { read: unknown }).read).toEqual(state);
    // The host hears it once (the latest), after the flush delay.
    expect(t.savedStates).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(t.savedStates.map((json) => JSON.parse(json) as unknown)).toEqual([state]);
    // A teardown sends the state that has not gone out yet, before the shim's reply.
    void t.win.openai.setWidgetState({ n: 4 });
    await t.host.teardown("unmount");
    expect(JSON.parse(t.savedStates.at(-1)!)).toEqual({ n: 4 });
    // The next mount reads it at load, before any host message.
    const again = await runView(`window.first = window.openai.widgetState;`, {
      widgetState: JSON.stringify(state),
    });
    expect((again.win as unknown as { first: unknown }).first).toEqual(state);
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
