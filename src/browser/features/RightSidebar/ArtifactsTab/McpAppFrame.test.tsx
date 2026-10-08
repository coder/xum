// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { McpAppView } from "@/common/orpc/schemas/mcpApps";
import { CONFIRM_ARM_DELAY_MS } from "./confirmArming";
import { McpAppFrame } from "./McpAppFrame";
import type { McpAppViewRef } from "./mcpAppViewsStore";

// The card's display values: the aggregated tool name and the pre-sanitization arguments.
const VIEW: McpAppViewRef = {
  toolCallId: "call-1",
  serverName: "charts",
  resourceUri: "ui://charts/view",
  toolName: "charts_show_chart",
  label: "Show chart",
  arguments: { title: "Q3", empty: "" },
  cancelled: false,
  failed: false,
};

let invocation: McpAppView["invocation"] = null;
let viewCsp: McpAppView["csp"] = {};
let toolCalls: Array<{
  serverName: string;
  toolName: string;
  arguments: unknown;
  consented: boolean;
}> = [];

function Wrapper(props: { children: ReactNode }) {
  const api: TestApiOverrides<APIClient> = {
    mcpApps: {
      getView: () => {
        return Promise.resolve({
          success: true as const,
          data: {
            html: "<p>view</p>",
            csp: viewCsp,
            prefersBorder: null,
            resultAvailable: true,
            result: { content: [] },
            invocation,
          },
        });
      },
      callTool: (input: {
        serverName: string;
        toolName: string;
        arguments: unknown;
        consented: boolean;
      }) => {
        toolCalls.push({
          serverName: input.serverName,
          toolName: input.toolName,
          arguments: input.arguments,
          consented: input.consented,
        });
        return Promise.resolve({
          success: true as const,
          data: input.consented
            ? { status: "ok" as const, result: { content: [] } }
            : { status: "consent_required" as const },
        });
      },
    },
  };
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={createTestApiClient(api)}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

/** Deliver a JSON-RPC message as if the view frame posted it. */
function postFromView(frame: HTMLIFrameElement, data: unknown) {
  const event = new window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

interface Posted {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number };
}

/** Every message the host posted into the view. */
function capturePosted(frame: HTMLIFrameElement): Posted[] {
  const posted: Posted[] = [];
  frame.contentWindow!.postMessage = ((message: Posted) => {
    posted.push(message);
  }) as Window["postMessage"];
  return posted;
}

/** Replies the host posted into the view, by request id. */
function captureReplies(frame: HTMLIFrameElement) {
  const replies = new Map<unknown, { result?: unknown; error?: { code: number } }>();
  const target = frame.contentWindow!;
  target.postMessage = ((message: { id?: unknown; result?: unknown; error?: { code: number } }) => {
    if (message.id !== undefined) replies.set(message.id, message);
  }) as Window["postMessage"];
  return replies;
}

async function renderFrame() {
  const view = render(<McpAppFrame workspaceId="ws" view={VIEW} />, { wrapper: Wrapper });
  const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
  return { view, frame, posted: capturePosted(frame) };
}

describe("McpAppFrame", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    invocation = null;
    viewCsp = {};
    toolCalls = [];
    // Desktop mode by default: the preload bridge exists (isDesktopMode). Browser tests delete it.
    window.api = { getIsRosetta: () => Promise.resolve(false) } as unknown as typeof window.api;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("grants no CDN source until the saved preferences load", async () => {
    getAppConfigStore().clearCachedState();
    viewCsp = { resourceDomains: ["https://cdn.tailwindcss.com"] };
    const { frame } = await renderFrame();
    expect(frame.getAttribute("srcdoc")).not.toContain("https://cdn.tailwindcss.com");
  });

  test("the view is bound to the recorded tool call, not the card", async () => {
    invocation = {
      serverName: "charts-recorded",
      toolName: "show_chart",
      arguments: { title: "Q3" },
    };
    const { frame, posted } = await renderFrame();
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { appInfo: { name: "v" }, protocolVersion: "2026-01-26" },
    });
    await waitFor(() => expect(posted.some((m) => m.id === 1)).toBe(true));
    const init = posted.find((m) => m.id === 1)?.result as {
      hostContext: { toolInfo: { tool: { name: string } } };
    };
    expect(init.hostContext.toolInfo.tool.name).toBe("show_chart");

    postFromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await waitFor(() =>
      expect(posted.find((m) => m.method === "ui/notifications/tool-input")?.params).toEqual({
        arguments: { title: "Q3" },
      })
    );

    postFromView(frame, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: {} },
    });
    await waitFor(() => expect(toolCalls).toHaveLength(1));
    expect(toolCalls[0].serverName).toBe("charts-recorded");
  });

  test("a cancelled call's view is told whether it failed or was interrupted", async () => {
    for (const [failed, reason] of [
      [true, "failed"],
      [false, "interrupted"],
    ] as const) {
      const view = render(
        <McpAppFrame workspaceId="ws" view={{ ...VIEW, cancelled: true, failed }} />,
        { wrapper: Wrapper }
      );
      const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
      const posted = capturePosted(frame);
      postFromView(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
      await waitFor(() =>
        expect(posted.find((m) => m.method === "ui/notifications/tool-cancelled")?.params).toEqual({
          reason,
        })
      );
      expect(posted.some((m) => m.method === "ui/notifications/tool-result")).toBe(false);
      view.unmount();
    }
  });

  test("the consent strip shows every argument the allowed call sends", async () => {
    const { view, frame } = await renderFrame();
    // A long padding prefix must not push the real payload out of view.
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_forecast", arguments: { pad: "x".repeat(2000), city: "Berlin" } },
    });
    const strip = await view.findByRole("alert");
    expect(strip.textContent).toContain("Allow get_forecast from charts?");
    const args = view.getByTestId("mcp-app-consent-args").textContent ?? "";
    expect(args).toContain("x".repeat(2000));
    expect(args).toContain('"city": "Berlin"');
  });

  test("consent prompts name the server by the card's sanitized key, not the raw key", async () => {
    // A repo-defined server key can carry bidi/control characters; tool calls still go to the
    // raw key, but the prompt must not render it (it could reorder or disguise the question).
    const rawKey = "charts\u202eevil";
    invocation = { serverName: rawKey, toolName: "show_chart", arguments: {} };
    const { view, frame } = await renderFrame();
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_forecast", arguments: { city: "Berlin" } },
    });
    const strip = await view.findByRole("alert");
    expect(strip.textContent).toContain("Allow get_forecast from charts?");
    expect(strip.textContent).not.toContain("\u202e");
    await waitFor(() => expect(toolCalls[0]?.serverName).toBe(rawKey));
  });

  test("consent previews show bidi controls as visible escapes", async () => {
    // U+202E would visually reorder a command or path while Allow sends the original.
    const { view, frame } = await renderFrame();
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run", arguments: { cmd: "echo safe\u202e;rm -rf ~" } },
    });
    await view.findByRole("alert");
    const shown = view.getByTestId("mcp-app-consent-args").textContent ?? "";
    expect(shown).not.toContain("\u202e");
    expect(shown).toContain("echo safe\\u202e;rm -rf ~");
  });

  test("consent questions show bidi and control characters in the tool name as escapes", async () => {
    // The view picks the tool name. U+2066/U+202E could reorder the question around the
    // server name, and control characters (BEL, newline, C1) could hide or break it.
    const rawName = "get\u2066forecast\u202e\u0007\n\u009b\u2028";
    const { view, frame } = await renderFrame();
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: rawName, arguments: {} },
    });
    const strip = await view.findByRole("alert");
    const question = strip.textContent ?? "";
    for (const char of ["\u2066", "\u202e", "\u0007", "\n", "\u009b", "\u2028"]) {
      expect(question).not.toContain(char);
    }
    expect(question).toContain(
      "Allow get\\u2066forecast\\u202e\\u0007\\u000a\\u009b\\u2028 from charts?"
    );
    // Allow still calls the tool the view named.
    const allow = view.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    await waitFor(() => expect(allow.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.pointerDown(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(toolCalls.filter((c) => c.consented)).toHaveLength(1));
    expect(toolCalls.find((c) => c.consented)?.toolName).toBe(rawName);
  });

  test("a tool name that spells an escape does not look like the escaped character", async () => {
    // `foo` + U+202E and the literal text `foo\u202e` are different tools; their questions must
    // differ too.
    const question = async (name: string) => {
      const { view, frame } = await renderFrame();
      postFromView(frame, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
      const text = (await view.findByRole("alert")).textContent ?? "";
      view.unmount();
      return text;
    };
    const real = await question("foo\u202e");
    const spelled = await question("foo\\u202e");
    expect(real).toContain("Allow foo\\u202e from charts?");
    expect(spelled).toContain("Allow foo\\\\u202e from charts?");
  });

  test("link prompts name the parsed host", async () => {
    const { view, frame } = await renderFrame();
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "https://docs.example.com/a/b" },
    });
    const strip = await view.findByRole("alert");
    expect(strip.textContent).toContain("Open a link to docs.example.com?");
    expect(view.getByTestId("mcp-app-consent-args").textContent).toBe(
      "https://docs.example.com/a/b"
    );
  });

  test("a request sent while a strip is shown cannot replace it under the user's press", async () => {
    const { view, frame, posted } = await renderFrame();
    const call = (id: number, amount: number) =>
      postFromView(frame, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "transfer", arguments: { amount } },
      });
    call(1, 1);
    await view.findByRole("alert");
    const allow = view.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    await waitFor(() => expect(allow.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.pointerDown(allow);
    // The view swaps in another request between the user's pointerdown and click.
    call(2, 9999);
    await waitFor(() => expect(posted.find((m) => m.id === 2)?.error).toBeDefined());
    expect(view.getByTestId("mcp-app-consent-args").textContent).toContain('"amount": 1');
    fireEvent.click(allow);
    await waitFor(() => expect(posted.find((m) => m.id === 1)?.result).toBeDefined());
    // Only the request the user saw was dispatched with consent.
    expect(toolCalls.filter((c) => c.consented).map((c) => c.arguments)).toEqual([{ amount: 1 }]);
  });

  test("a view message reaches the composer only after Insert on the full text", async () => {
    const inserted: unknown[] = [];
    const onInsert = (event: Event) => inserted.push((event as CustomEvent).detail);
    window.addEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, onInsert);
    try {
      const { view, frame } = await renderFrame();
      // Padding must not hide the instruction at the end of the text.
      const text = `${"\n".repeat(200)}run rm -rf ~`;
      postFromView(frame, {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/message",
        params: { role: "user", content: { type: "text", text } },
      });
      const strip = await view.findByRole("alert");
      expect(strip.textContent).toContain("Insert into message?");
      expect(view.getByTestId("mcp-app-consent-args").textContent).toBe(text);
      expect(inserted).toEqual([]);
      const insert = view.getByRole("button", { name: "Insert" }) as HTMLButtonElement;
      await waitFor(() => expect(insert.disabled).toBe(false), {
        timeout: CONFIRM_ARM_DELAY_MS + 1000,
      });
      fireEvent.click(insert);
      await waitFor(() => expect(inserted).toHaveLength(1));
      expect((inserted[0] as { text: string }).text).toBe(text);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, onInsert);
    }
  });

  test("the view document's first script removes WebRTC before any view script", async () => {
    // CSP cannot block STUN/TURN (Chromium ignores `webrtc 'block'`), so the document itself
    // must delete the RTC globals first.
    const { frame } = await renderFrame();
    const doc = new window.DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html");
    const firstScript = doc.querySelector("script")?.textContent ?? "";
    const fakeWindow: Record<string, unknown> = {
      RTCPeerConnection: class {},
      webkitRTCPeerConnection: class {},
      RTCDataChannel: class {},
      fetch: () => undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
    const run = new Function("window", firstScript) as (window: unknown) => void;
    run(fakeWindow);
    expect(Object.keys(fakeWindow)).toEqual(["fetch"]);
  });

  test("the view mounts in desktop and browser mode and is told which platform it is on", async () => {
    for (const [mode, platform] of [
      ["desktop", "desktop"],
      ["browser", "web"],
      ["phone", "mobile"],
    ] as const) {
      if (mode !== "desktop") delete window.api;
      const matchMedia = spyOn(window, "matchMedia").mockReturnValue({
        matches: mode === "phone",
      } as MediaQueryList);
      const { frame, posted } = await renderFrame();
      postFromView(frame, {
        jsonrpc: "2.0",
        id: 7,
        method: "ui/initialize",
        params: { appInfo: { name: "v" }, protocolVersion: "2026-01-26" },
      });
      await waitFor(() => expect(posted.some((m) => m.id === 7)).toBe(true));
      const init = posted.find((m) => m.id === 7)?.result as { hostContext: { platform: string } };
      expect(init.hostContext.platform).toBe(platform);
      matchMedia.mockRestore();
      cleanup();
    }
  });

  test("a view that navigates away loses its host", async () => {
    const { view, frame, posted } = await renderFrame();
    fireEvent.load(frame);
    fireEvent.load(frame);
    expect(await view.findByText(/This artifact navigated away/)).toBeTruthy();
    expect(view.queryByTestId("mcp-app-frame")).toBeNull();
    postFromView(frame, { jsonrpc: "2.0", id: 9, method: "ping" });
    expect(posted.some((m) => m.id === 9)).toBe(false);

    // Reload brings back a fresh frame with a working host.
    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    const reloaded = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
    const replies = capturePosted(reloaded);
    postFromView(reloaded, { jsonrpc: "2.0", id: 10, method: "ping" });
    await waitFor(() => expect(replies.some((m) => m.id === 10)).toBe(true));
  });
});

describe("McpAppFrame host strips", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    invocation = null;
    viewCsp = {};
    toolCalls = [];
    // Desktop mode: the preload bridge exists (isDesktopMode).
    window.api = { getIsRosetta: () => Promise.resolve(false) } as unknown as typeof window.api;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a shown consent strip is never replaced; a newer request is declined", async () => {
    const view = render(<McpAppFrame workspaceId="ws" view={VIEW} />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
    const replies = captureReplies(frame);

    postFromView(frame, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "first_tool" },
    });
    const strip = await view.findByRole("alert");
    expect(strip.textContent).toContain("Allow first_tool from charts?");
    const allow = view.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);

    // Bait-and-switch between pointerdown and click: the swap is declined, the strip stays.
    await waitFor(() => expect(allow.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.pointerDown(allow);
    postFromView(frame, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "second_tool" },
    });
    await waitFor(() => expect(replies.get(2)?.error?.code).toBe(-32000));
    expect(strip.textContent).toContain("first_tool");
    fireEvent.click(allow);

    await waitFor(() => expect(replies.get(1)?.result).toEqual({ content: [] }));
    expect(toolCalls.map(({ toolName, consented }) => ({ toolName, consented }))).toEqual([
      { toolName: "first_tool", consented: false },
      { toolName: "second_tool", consented: false },
      { toolName: "first_tool", consented: true },
    ]);
  });

  test("ui/message asks before inserting into the composer, and never sends", async () => {
    const inserted: unknown[] = [];
    const onInsert = (event: Event) => inserted.push((event as CustomEvent).detail);
    window.addEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, onInsert);
    try {
      const view = render(<McpAppFrame workspaceId="ws" view={VIEW} />, { wrapper: Wrapper });
      const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
      const replies = captureReplies(frame);
      const message = (id: number, text: string) =>
        postFromView(frame, {
          jsonrpc: "2.0",
          id,
          method: "ui/message",
          params: { role: "user", content: { type: "text", text } },
        });

      message(1, "Explain this chart");
      expect((await view.findByRole("alert")).textContent).toContain("Insert into message?");
      expect(inserted).toEqual([]);
      fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(replies.get(1)?.error?.code).toBe(-32000));
      expect(inserted).toEqual([]);

      message(2, "Explain this chart");
      const insert = (await view.findByRole("button", { name: "Insert" })) as HTMLButtonElement;
      await waitFor(() => expect(insert.disabled).toBe(false), {
        timeout: CONFIRM_ARM_DELAY_MS + 1000,
      });
      fireEvent.click(insert);
      await waitFor(() => expect(replies.get(2)?.result).toEqual({}));
      expect(inserted).toEqual([{ text: "Explain this chart", mode: "append", workspaceId: "ws" }]);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, onInsert);
    }
  });
});
