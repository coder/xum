// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIContext, type APIClient, type UseAPIResult } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { CONFIRM_ARM_DELAY_MS } from "./confirmArming";
import { CanvasArtifact } from "./CanvasArtifact";
import { McpAppFrame } from "./McpAppFrame";
import type { McpAppViewRef } from "./mcpAppViewsStore";

/*
 * A dropped backend connection: while it is down, useAPI() returns `api: null`; the reconnect
 * returns a NEW client. Neither may rebuild or remount what the Artifacts tab already shows:
 * a rebuilt frame loses the in-page state of a dynamic artifact.
 */

function ok(path: string, content: string): ArtifactReadResult {
  return {
    status: "ok",
    path,
    kind: getArtifactKind(path),
    size: content.length,
    modifiedMs: 1,
    encoding: "utf8",
    content,
  };
}

const VIEW: McpAppViewRef = {
  toolCallId: "call-1",
  serverName: "charts",
  resourceUri: "ui://charts/view",
  toolName: "charts_show_chart",
  label: "Show chart",
  arguments: {},
  cancelled: false,
  failed: false,
};

let files: Record<string, ArtifactReadResult> = {};
let persistedState: unknown = null;
let savedStates: unknown[] = [];
let assetReads: string[] = [];
let listCalls = 0;
let getStateCalls = 0;
let getViewCalls = 0;
/** Every request but getState fails with this error while set (a backend still starting). */
let failWith: string | null = null;
/** The artifacts the listing returns. */
let listEntries = [{ path: "app.html", kind: "html" as const, size: 10, modifiedMs: 1 }];
/** Only listVersions fails while set. */
let failVersions = false;
/** getState answers unsuccessfully while set. */
let failGetState = false;
let sends: Array<{ version: number | null }> = [];

function fail() {
  return Promise.resolve({ success: false as const, error: failWith ?? "" });
}

/** A fresh client, as each reconnect creates. */
function createClient(): APIClient {
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      list: () => {
        listCalls += 1;
        if (failWith != null) return fail();
        return Promise.resolve({
          success: true as const,
          data: {
            available: true as const,
            dir: "/scratch/artifacts",
            entries: listEntries,
            truncated: false,
          },
        });
      },
      read: (input: { path: string; maxBytes?: number | null }) => {
        if (input.maxBytes != null) assetReads.push(input.path);
        if (failWith != null) return fail();
        const file = files[input.path];
        return Promise.resolve(
          file
            ? { success: true as const, data: file }
            : { success: false as const, error: `Artifact not found: ${input.path}` }
        );
      },
      listVersions: (input: { path: string }) => {
        if (failWith != null) return fail();
        if (failVersions) return Promise.resolve({ success: false as const, error: "no list" });
        return Promise.resolve({
          success: true as const,
          data: {
            artifactId: "id",
            path: input.path,
            pin: null,
            versions: [
              {
                version: 1,
                label: null,
                source: "publish" as const,
                createdAtMs: 1,
                sha256: "x",
                size: 10,
                path: input.path,
              },
            ],
          },
        });
      },
      listPinned: () =>
        Promise.resolve({ success: true as const, data: { available: true as const, files: [] } }),
      listShelf: () =>
        Promise.resolve({
          success: true as const,
          data: { project: { available: true as const, entries: [] }, global: [] },
        }),
      capabilities: () => Promise.resolve({ agentBrowserAvailable: true }),
      getState: () => {
        getStateCalls += 1;
        if (failGetState) return Promise.resolve({ success: false as const, error: "starting" });
        return Promise.resolve({ success: true as const, data: { state: persistedState } });
      },
      setState: (input: { state: unknown }) => {
        savedStates.push(input.state);
        persistedState = input.state;
        return Promise.resolve({ success: true as const, data: undefined });
      },
      sendInteraction: (input: { version: number | null }) => {
        sends.push({ version: input.version });
        return Promise.resolve({ success: true as const, data: { id: "i1" } });
      },
    },
    mcpApps: {
      getView: () => {
        getViewCalls += 1;
        return Promise.resolve({
          success: true as const,
          data: {
            html: "<p>view</p>",
            csp: {},
            prefersBorder: null,
            resultAvailable: true,
            result: { content: [] },
            invocation: null,
          },
        });
      },
    },
  };
  return createTestApiClient(api);
}

let setConnection: (api: APIClient | null) => void = () => undefined;
const noop = () => undefined;

/** The API context as ManagedAPIProvider reports it: connected, or reconnecting with no client. */
function ConnectionWrapper(props: { children: ReactNode }) {
  const [api, setApi] = useState<APIClient | null>(() => createClient());
  setConnection = setApi;
  const value: UseAPIResult =
    api != null
      ? { status: "connected", api, error: null, authenticate: noop, retry: noop }
      : {
          status: "reconnecting",
          api: null,
          error: null,
          attempt: 1,
          authenticate: noop,
          retry: noop,
        };
  return (
    <ThemeProvider forcedTheme="dark">
      <APIContext.Provider value={value}>{props.children}</APIContext.Provider>
    </ThemeProvider>
  );
}

/** Let pending requests and the renders they cause settle. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function dropConnection() {
  act(() => setConnection(null));
  await flush();
}

/** Reconnects and waits until the panel re-listed through the new client. */
async function reconnect() {
  const before = listCalls;
  act(() => setConnection(createClient()));
  await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  await flush();
}

/** Identity check without printing the whole DOM node on failure. */
function expectSameFrame(current: HTMLElement | null, frame: HTMLIFrameElement) {
  expect(current === frame ? "same frame" : current == null ? "no frame" : "new frame").toBe(
    "same frame"
  );
}

function postFromFrame(frame: HTMLIFrameElement, data: unknown) {
  const event = new window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("Artifacts tab across a dropped connection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    files = { "app.html": ok("app.html", "<button>Count</button>") };
    persistedState = null;
    savedStates = [];
    assetReads = [];
    listCalls = 0;
    getStateCalls = 0;
    getViewCalls = 0;
    failWith = null;
    failVersions = false;
    failGetState = false;
    listEntries = [{ path: "app.html", kind: "html" as const, size: 10, modifiedMs: 1 }];
    sends = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("an interactive artifact keeps its frame, and states set while offline are saved", async () => {
    persistedState = { step: 1 };
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await flush();
    const srcdoc = frame.getAttribute("srcdoc");
    const statesRead = getStateCalls;
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { step: 2 } });
    await waitFor(() => expect(savedStates).toEqual([{ step: 2 }]));

    await dropConnection();
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { step: 3 } });

    await reconnect();
    await waitFor(() => expect(savedStates).toEqual([{ step: 2 }, { step: 3 }]));
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
    // The frame owns its state once built: the new client does not read it again.
    expect(getStateCalls).toBe(statesRead);
  });

  test("an HTML artifact with inlined assets keeps its document", async () => {
    files["app.html"] = ok("app.html", '<link rel="stylesheet" href="style.css"><p>x</p>');
    files["style.css"] = ok("style.css", "p{color:red}");
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const srcdoc = frame.getAttribute("srcdoc");
    expect(srcdoc).toContain("p{color:red}");

    await dropConnection();
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);

    await reconnect();
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
    expect(assetReads).toEqual(["style.css"]);
  });

  test("failed refreshes after a reconnect keep the artifact on screen", async () => {
    persistedState = { step: 1 };
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await flush();
    const srcdoc = frame.getAttribute("srcdoc");
    const statesRead = getStateCalls;

    await dropConnection();
    failWith = "Backend is starting";
    await reconnect();
    // The error is shown, but beside the artifact, not instead of it.
    expect(view.getAllByText("Backend is starting").length).toBeGreaterThan(0);
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);

    // The next refresh (poll) succeeds: the error goes away and the frame still stays.
    failWith = null;
    await waitFor(() => expect(view.queryByText("Backend is starting")).toBeNull(), {
      timeout: 5000,
    });
    await flush();
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
    expect(getStateCalls).toBe(statesRead);
  });

  test("an MCP App view keeps its frame and host", async () => {
    const view = render(<McpAppFrame workspaceId="ws-r" view={VIEW} />, {
      wrapper: ConnectionWrapper,
    });
    const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
    const posted: Array<{ method?: string }> = [];
    frame.contentWindow!.postMessage = ((message: { method?: string }) => {
      posted.push(message);
    }) as Window["postMessage"];

    await dropConnection();
    act(() => setConnection(createClient()));
    await flush();
    expectSameFrame(view.queryByTestId("mcp-app-frame"), frame);
    // A torn-down host would have told the view to tear down.
    expect(posted.map((message) => message.method)).not.toContain("ui/resource-teardown");
    expect(getViewCalls).toBe(1);
  });

  test("a canvas keeps the data of its file references while offline", async () => {
    files["data/s.json"] = ok("data/s.json", JSON.stringify({ series: [{ q: "Q1", v: 1 }] }));
    const content = JSON.stringify({
      $xum: "canvas",
      blocks: [
        { type: "chart", kind: "bar", data: "data/s.json#/series", x: "q", y: "v", title: "Q" },
      ],
    });
    const view = render(
      <CanvasArtifact content={content} path="board.canvas.json" workspaceId="ws-r" />,
      { wrapper: ConnectionWrapper }
    );
    expect(await view.findByText("Q")).toBeTruthy();

    await dropConnection();
    expect(view.queryByText(/File references are not available here/)).toBeNull();
    expect(view.getByText("Q")).toBeTruthy();
  });

  test("a failed state read is retried with the next client", async () => {
    persistedState = { marker: "zq-persisted" };
    failGetState = true;
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await flush();
    expect(frame.getAttribute("srcdoc")).not.toContain("zq-persisted");
    const statesRead = getStateCalls;
    // A lasting failure is not retried against the same client.
    await flush();
    expect(getStateCalls).toBe(statesRead);

    failGetState = false;
    await dropConnection();
    await reconnect();
    await waitFor(() => expect(getStateCalls).toBeGreaterThan(statesRead));
    // The frame is built again, now with the persisted state.
    await waitFor(() =>
      expect(view.getByTestId("artifact-frame").getAttribute("srcdoc")).toContain("zq-persisted")
    );
  });

  test("a state set while offline is saved even if the panel unmounts first", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await flush();
    await dropConnection();
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { marker: "zq-offline" } });
    // A tab switch unmounts the panel before the connection is back.
    view.unmount();
    expect(savedStates).toEqual([]);

    // Reopening the tab (connected again) sends the held write before reading the state.
    const reopened = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    await reopened.findByTestId("artifact-frame");
    await waitFor(() => expect(savedStates).toEqual([{ marker: "zq-offline" }]));
    await waitFor(() =>
      expect(reopened.getByTestId("artifact-frame").getAttribute("srcdoc")).toContain("zq-offline")
    );
  });

  test("Send does not record a version from a version list whose refresh failed", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await flush();
    failVersions = true;
    await dropConnection();
    await reconnect();
    // The kept list still keys the frame, so it is not rebuilt.
    expectSameFrame(view.queryByTestId("artifact-frame"), frame);

    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Ship" });
    const sendButton = (await view.findByRole("button", { name: "Send" })) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.click(sendButton);
    // Null: the server resolves the version, instead of the outdated newest one (1).
    await waitFor(() => expect(sends).toEqual([{ version: null }]));
  });

  test("a canvas keeps its data through a refresh made while offline", async () => {
    files["data/s.json"] = ok("data/s.json", JSON.stringify({ series: [{ q: "Q1", v: 1 }] }));
    const content = JSON.stringify({
      $xum: "canvas",
      blocks: [
        { type: "chart", kind: "bar", data: "data/s.json#/series", x: "q", y: "v", title: "Q" },
      ],
    });
    const element = (reloadToken: number) => (
      <CanvasArtifact
        content={content}
        path="board.canvas.json"
        workspaceId="ws-r"
        reloadToken={reloadToken}
      />
    );
    const view = render(element(0), { wrapper: ConnectionWrapper });
    expect(await view.findByText("Q")).toBeTruthy();
    const reads = assetReads.length;

    await dropConnection();
    view.rerender(element(1));
    await flush();
    // The re-read waits for the connection instead of reporting the file as missing.
    expect(view.queryByText(/Could not read/)).toBeNull();
    expect(view.getByText("Q")).toBeTruthy();
    expect(assetReads.length).toBe(reads);

    act(() => setConnection(createClient()));
    await waitFor(() => expect(assetReads.length).toBe(reads + 1));
    await flush();
    expect(view.queryByText(/Could not read/)).toBeNull();
  });

  test("a failed refresh of an empty listing shows the error, not an empty folder", async () => {
    listEntries = [];
    const view = render(<ArtifactsPanel workspaceId="ws-r" />, { wrapper: ConnectionWrapper });
    expect(await view.findByText(/No artifacts yet/)).toBeTruthy();

    await dropConnection();
    failWith = "Backend is starting";
    await reconnect();
    expect(view.getByText("Backend is starting")).toBeTruthy();
    expect(view.queryByText(/No artifacts yet/)).toBeNull();
  });
});
