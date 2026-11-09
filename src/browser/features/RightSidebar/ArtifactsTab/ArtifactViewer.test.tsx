// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom, stubNarrowViewport } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { KEYBINDS } from "@/browser/utils/ui/keybinds";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { advanceClock } from "@/browser/testFakeClock";
import { FRAME_DOCUMENT_CHECK_DEADLINE_MS } from "@/common/constants/artifactInteractions";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { ARTIFACT_ASSET_LIMITS } from "./artifactAssets";
import {
  bootFrameDocument,
  deliverFrameMessages,
  frameDocumentOf,
  postFromFrameDocument,
  postFromFrameWindow,
} from "./frameDocument.testHarness";
import { SandboxedArtifactFrame } from "./SandboxedArtifactFrame";
import { buildArtifactCsp } from "./artifactCsp";
import { DIFF_ARTIFACT_MAX_LINES } from "./DiffArtifact";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ARTIFACT_TABLE_MAX_COLUMNS, ARTIFACT_TABLE_MAX_ROWS } from "./DataTable";
import { JSON_TREE_MAX_NODES } from "./jsonData";
import { useAgentBrowserAvailable } from "./useAgentBrowserAvailable";
import { restoreHistoryPrototypeAfterEach } from "./historyPrototype.testHarness";

restoreHistoryPrototypeAfterEach();

function ok(
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8"
): ArtifactReadResult {
  return {
    status: "ok",
    path,
    kind: getArtifactKind(path),
    size: content.length,
    modifiedMs: 1,
    encoding,
    content,
  };
}

let files: Record<string, ArtifactReadResult> = {};
let selected = "";
let readInputs: Array<{ path: string; maxBytes?: number | null }> = [];
let agentBrowserAvailable: boolean | null = null;
let capabilityRequests = 0;
let readRequests: string[] = [];
// States the host persisted for an artifact's window.xum.setState.
let savedStates: unknown[] = [];

function Wrapper(props: { children: ReactNode }) {
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      getState: () => Promise.resolve({ success: true as const, data: { state: null } }),
      setState: (input: { state: unknown }) => {
        savedStates.push(input.state);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      listPinned: () =>
        Promise.resolve({ success: true as const, data: { available: true as const, files: [] } }),
      listShelf: () =>
        Promise.resolve({
          success: true as const,
          data: { project: { available: true as const, entries: [] }, global: [] },
        }),
      list: () =>
        Promise.resolve({
          success: true as const,
          data: {
            available: true as const,
            dir: "/scratch/artifacts",
            // The selected file first: the panel shows the newest entry by default.
            entries: [
              files[selected],
              ...Object.values(files).filter((f) => f.path !== selected),
            ].map((file, index) => ({
              path: file.path,
              kind: file.kind,
              size: file.size,
              modifiedMs: 10 - index,
            })),
            truncated: false,
          },
        }),
      read: (input: { workspaceId: string; path: string; maxBytes?: number | null }) => {
        readInputs.push({ path: input.path, maxBytes: input.maxBytes });
        readRequests.push(input.path);
        const file = files[input.path];
        return Promise.resolve(
          file
            ? { success: true as const, data: file }
            : { success: false as const, error: `Artifact not found: ${input.path}` }
        );
      },
      capabilities: () => {
        capabilityRequests++;
        return Promise.resolve({ agentBrowserAvailable });
      },
    },
  };
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={createTestApiClient(api)}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

function renderArtifact(path: string, all: Record<string, ArtifactReadResult>) {
  files = all;
  selected = path;
  return render(<ArtifactsPanel workspaceId="ws-viewer" />, { wrapper: Wrapper });
}

describe("ArtifactViewer renderers", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    // Fullscreen as a modal dialog over the whole window; the panel renders without a workspace
    // shell here (ArtifactsPanel.test.tsx covers the wide-window shell case).
    stubNarrowViewport(true);
    window.localStorage.clear();
    readInputs = [];
    // Desktop app by default (the preload bridge is what isDesktopMode checks). Browser-mode
    // tests delete it.
    window.api = {
      platform: "linux",
      versions: {},
      getIsRosetta: () => Promise.resolve(false),
    };
    agentBrowserAvailable = null;
    capabilityRequests = 0;
    readRequests = [];
    savedStates = [];
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders a JSON table hint as a table, with tree and raw still available", async () => {
    const content = JSON.stringify({
      $xum: "table",
      rows: [
        { name: "api", p95: 142 },
        { name: "worker", nested: { a: 1 } },
      ],
    });
    const view = renderArtifact("t.json", { "t.json": ok("t.json", content) });
    expect(await view.findByRole("columnheader", { name: "nested" })).toBeTruthy();
    expect(view.getByRole("cell", { name: '{"a":1}' })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "tree" }));
    expect(await view.findByText("rows:")).toBeTruthy();
  });

  test("a table cell nested too deeply to serialize does not take down the panel", async () => {
    // JSON.parse accepts this depth, but JSON.stringify overflows the stack. Throwing during
    // render would leave the tab (picker included) stuck on this persisted selection.
    const depth = 100_000;
    const content = `{"$xum":"table","rows":[{"name":"deep","cell":${"[".repeat(depth)}${"]".repeat(depth)}}]}`;
    const view = renderArtifact("deep.json", { "deep.json": ok("deep.json", content) });
    expect(await view.findByRole("cell", { name: "deep" })).toBeTruthy();
    expect(view.getByRole("combobox", { name: "Artifact" })).toBeTruthy();
  });

  test("renders JSON children only when expanded", async () => {
    const content = JSON.stringify({ a: { b: { deepKey: 1 } } });
    const view = renderArtifact("d.json", { "d.json": ok("d.json", content) });
    expect(await view.findByText("b:")).toBeTruthy();
    // Depth 2 starts collapsed, so its children are not in the DOM.
    expect(view.queryByText("deepKey:")).toBeNull();
    fireEvent.click(view.getByText("b:"));
    expect(await view.findByText("deepKey:")).toBeTruthy();
  });

  test("the JSON raw view shows the file as written", async () => {
    const content = '{"a":9007199254740993,"a":1}';
    const view = renderArtifact("dup.json", { "dup.json": ok("dup.json", content) });
    fireEvent.click(await view.findByRole("button", { name: "raw" }));
    expect(await view.findByText(content)).toBeTruthy();
  });

  test("falls back to the raw view for JSON with too many nodes", async () => {
    const content = JSON.stringify(Array.from({ length: JSON_TREE_MAX_NODES + 1 }, (_, i) => i));
    const view = renderArtifact("big.json", { "big.json": ok("big.json", content) });
    expect(await view.findByText(/Too many values for the tree view/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "tree" })).toBeNull();
    expect(view.getByText(content)).toBeTruthy();
  });

  test("renders CSV as a table with a row cap note", async () => {
    const rows = Array.from(
      { length: ARTIFACT_TABLE_MAX_ROWS + 5 },
      (_, i) => `r${i},"q ""${i}"""`
    );
    const view = renderArtifact("d.csv", {
      "d.csv": ok("d.csv", ["id,quote", ...rows].join("\n")),
    });
    expect(await view.findByRole("columnheader", { name: "quote" })).toBeTruthy();
    expect(view.getByRole("cell", { name: 'q "0"' })).toBeTruthy();
    expect(
      view.getByText(
        `Showing first ${ARTIFACT_TABLE_MAX_ROWS} of ${ARTIFACT_TABLE_MAX_ROWS + 5} rows`
      )
    ).toBeTruthy();
  });

  test("caps table columns for very wide rows", async () => {
    const wide = Array.from({ length: 5000 }, (_, i) => `c${i}`).join(",");
    const view = renderArtifact("wide.csv", { "wide.csv": ok("wide.csv", `${wide}\n${wide}`) });
    expect(
      await view.findByText(`Showing first ${ARTIFACT_TABLE_MAX_COLUMNS} of 5000 columns`)
    ).toBeTruthy();
    expect(view.getAllByRole("columnheader")).toHaveLength(ARTIFACT_TABLE_MAX_COLUMNS);
  });

  test("renders HTML in a scripts-only sandbox with the CSP meta first", async () => {
    getAppConfigStore().updateOptimistically({
      userPreferences: { ui: { artifactsAllowCdnScripts: false } },
    });
    const html = '<script>alert(1)</script><img src="https://tracker.example/p.gif"><p>hi</p>';
    const view = renderArtifact("page.html", { "page.html": ok("page.html", html) });
    const frame = await view.findByTestId("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    const doc = new window.DOMParser().parseFromString(srcdoc, "text/html");
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(buildArtifactCsp({ allowCdn: false }));
    expect(view.getByText("External asset blocked: https://tracker.example/p.gif")).toBeTruthy();
  });

  test("denies CDN scripts until the saved preferences load", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const srcdoc = (await view.findByTestId("artifact-frame")).getAttribute("srcdoc");
    expect(srcdoc).toContain(buildArtifactCsp({ allowCdn: false }));
  });

  test("in desktop and browser mode the frame mounts with its bridge listener", async () => {
    for (const desktop of [true, false]) {
      if (!desktop) delete window.api;
      const addListener = spyOn(window, "addEventListener");
      const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
      expect(await view.findByTestId("artifact-frame")).toBeTruthy();
      expect(addListener.mock.calls.some(([type]) => type === "message")).toBe(true);
      addListener.mockRestore();
      cleanup();
    }
  });

  test("a frame that navigates away is dropped and gets no bridge until Reload", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    fireEvent.load(frame);
    // The second load is a navigation (location.href, a clicked link).
    fireEvent.load(frame);
    expect(await view.findByText(/This artifact navigated away/)).toBeTruthy();
    expect(view.queryByTestId("artifact-frame")).toBeNull();
    // Whatever the frame's window posts now is ignored (F would toggle fullscreen).
    postFromFrameWindow(frame, { xumArtifact: 1, type: "key", key: "F", shiftKey: false });
    expect(view.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    expect(await view.findByTestId("artifact-frame")).toBeTruthy();
  });

  // WebKit fires the iframe's load event again when the artifact sets location.hash, and Chromium
  // does for a history.back() to the srcdoc's first entry. The document is still the one Xum built.
  test("a frame stays open with its bridge across loads of the same document", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const artifact = bootFrameDocument(frame);
    fireEvent.load(frame);
    fireEvent.load(frame);
    fireEvent.load(frame);
    const shownWithoutNotice = () =>
      view.queryByText(/This artifact navigated away/) == null &&
      view.queryByTestId("artifact-frame") === frame;
    expect(shownWithoutNotice()).toBe(true);

    artifact.win.xum?.setState({ route: "#/s/gamma" });
    await waitFor(() => expect(savedStates).toEqual([{ route: "#/s/gamma" }]));
    expect(shownWithoutNotice()).toBe(true);
  });

  /** The page's frame, shown with no "navigated away" notice. */
  const shownWithoutNotice = (view: ReturnType<typeof render>, frame: HTMLIFrameElement) =>
    view.queryByText(/This artifact navigated away/) == null &&
    view.queryByTestId("artifact-frame") === frame;

  /** Runs `body` on the fake clock (testFakeClock.ts), then back on real timers. */
  async function onFakeClock(body: () => Promise<void>) {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  test("checks the document answers keep its frame open past the check deadline", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    bootFrameDocument(frame);
    await onFakeClock(async () => {
      fireEvent.load(frame);
      fireEvent.load(frame);
      await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS + 1);
    });
    expect(shownWithoutNotice(view, frame)).toBe(true);
  });

  // The document's leave never came: the artifact's own code blocked it before navigating, or
  // its renderer died. Only the bound document can answer, so the frame still closes.
  test("a frame whose document misses a check closes at the deadline; loads do not extend it", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const artifact = bootFrameDocument(frame);
    fireEvent.load(frame);
    await deliverFrameMessages();
    artifact.kill();
    await onFakeClock(async () => {
      // The destination's load, then the same page reloading itself.
      fireEvent.load(frame);
      await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 1000);
      fireEvent.load(frame);
      await advanceClock(999);
      expect(shownWithoutNotice(view, frame)).toBe(true);
      await advanceClock(1);
    });
    expect(await view.findByText(/This artifact navigated away/)).toBeTruthy();
    expect(view.queryByTestId("artifact-frame") == null).toBe(true);
  });

  test("the document's leave closes its frame at once", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    bootFrameDocument(frame).dispatch("pagehide");
    await deliverFrameMessages();
    expect(view.queryByText(/This artifact navigated away/) != null).toBe(true);
    expect(view.queryByTestId("artifact-frame") == null).toBe(true);
  });

  // A page the frame navigated to keeps the frame's window, and may know the nonce.
  test("only the document's own port reaches the host, and only it hears the host", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const windowPosts: unknown[] = [];
    frame.contentWindow!.postMessage = ((message: unknown) => {
      windowPosts.push(message);
    }) as Window["postMessage"];
    const artifact = bootFrameDocument(frame);
    const nonce = /nonce: "([0-9a-f]+)"/.exec(frame.getAttribute("srcdoc")!)![1];
    const forged = new MessageChannel();
    const forgedReceived: unknown[] = [];
    forged.port1.onmessage = (event) => forgedReceived.push(event.data);
    postFromFrameWindow(frame, { xumFrameDocument: 1, type: "open", nonce }, [forged.port2]);
    postFromFrameWindow(frame, { xumArtifact: 1, type: "send", text: "From the window" });
    forged.port1.postMessage({ xumArtifact: 1, type: "send", text: "Over a forged port" });
    // Each load sends a check, and annotate mode goes to the frame: all to the document's port.
    fireEvent.load(frame);
    fireEvent.load(frame);
    const panel = view.getByTestId("artifacts-panel");
    fireEvent.keyDown(panel, { key: "c" });
    await deliverFrameMessages();
    // Annotate mode is kept per workspace: leave it off for the other tests.
    fireEvent.keyDown(panel, { key: "c" });
    expect(view.queryByTestId("artifact-send-strip") == null).toBe(true);
    expect(forgedReceived).toEqual([]);
    expect(windowPosts).toEqual([]);
    const types = artifact.received.map((message) => (message as { type?: unknown }).type);
    expect(types.filter((type) => type === "check")).toHaveLength(2);
    expect(types).toContain("annotate");

    await artifact.post({ xumArtifact: 1, type: "send", text: "From the document" });
    const strip = await view.findByTestId("artifact-send-strip");
    expect(strip.textContent).toContain("From the document");
    forged.port1.close();
  });

  test("a theme change reaches the document over its port, never the frame's window", async () => {
    const client = createTestApiClient({});
    const frameIn = (theme: "dark" | "light") => (
      <ThemeProvider forcedTheme={theme}>
        <APIProvider client={client}>
          <SandboxedArtifactFrame
            workspaceId={null}
            path="page.html"
            kind="html"
            content="<p>hi</p>"
          />
        </APIProvider>
      </ThemeProvider>
    );
    const view = render(frameIn("dark"));
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const windowPosts: unknown[] = [];
    frame.contentWindow!.postMessage = ((message: unknown) => {
      windowPosts.push(message);
    }) as Window["postMessage"];
    const artifact = bootFrameDocument(frame);
    view.rerender(frameIn("light"));
    await deliverFrameMessages();
    expect(windowPosts).toEqual([]);
    expect(artifact.received).toContainEqual(
      expect.objectContaining({ xumArtifact: 1, type: "theme", theme: "light" })
    );
  });

  // The frame's first load usually reaches the host before the document's open announcement,
  // so a theme or annotate change made before the bind must still reach the document.
  test("the document gets the current theme and annotate mode when its channel binds", async () => {
    const client = createTestApiClient({});
    const frameIn = (theme: "dark" | "light", annotating: boolean) => (
      <ThemeProvider forcedTheme={theme}>
        <APIProvider client={client}>
          <SandboxedArtifactFrame
            workspaceId={null}
            path="page.html"
            kind="html"
            content="<p>hi</p>"
            onAnnotate={annotating ? () => undefined : undefined}
          />
        </APIProvider>
      </ThemeProvider>
    );
    const view = render(frameIn("dark", false));
    // happy-dom has fired the srcdoc's one load by now, ahead of the bind, as browsers do.
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    view.rerender(frameIn("light", true));
    const artifact = bootFrameDocument(frame);
    await deliverFrameMessages();
    expect(shownWithoutNotice(view, frame)).toBe(true);
    expect(artifact.received).toContainEqual(
      expect.objectContaining({ xumArtifact: 1, type: "theme", theme: "light" })
    );
    expect(artifact.received).toContainEqual({ xumArtifact: 1, type: "annotate", enabled: true });
  });

  test("an open announcement from any other window binds nothing", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const nonce = /nonce: "([0-9a-f]+)"/.exec(frame.getAttribute("srcdoc")!)![1];
    // The app window itself, with the right nonce, ahead of the frame's document.
    const forged = new MessageChannel();
    const event = new window.Event("message");
    Object.defineProperty(event, "data", { value: { xumFrameDocument: 1, type: "open", nonce } });
    Object.defineProperty(event, "source", { value: window });
    Object.defineProperty(event, "ports", { value: [forged.port2] });
    act(() => {
      window.dispatchEvent(event);
    });
    forged.port1.postMessage({ xumArtifact: 1, type: "setState", state: "forged" });
    await bootFrameDocument(frame).post({ xumArtifact: 1, type: "setState", state: "document" });
    await waitFor(() => expect(savedStates).toEqual(["document"]));
    forged.port1.close();
  });

  test("Reload and new content bind a fresh channel; an old document reaches nothing", async () => {
    const states: unknown[] = [];
    const interactions = {
      initialState: null,
      requestSend: () => undefined,
      setState: (state: unknown) => states.push(state),
    };
    const frameFor = (content: string) => (
      <SandboxedArtifactFrame
        workspaceId={null}
        path="page.html"
        kind="html"
        content={content}
        interactions={interactions}
      />
    );
    const view = render(frameFor("<p>one</p>"), { wrapper: Wrapper });
    const first = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const before = bootFrameDocument(first);
    before.dispatch("pagehide");
    fireEvent.click(await view.findByRole("button", { name: "Reload" }));
    const reloaded = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const afterReload = bootFrameDocument(reloaded);
    await before.post({ xumArtifact: 1, type: "setState", state: "before reload" });
    await afterReload.post({ xumArtifact: 1, type: "setState", state: "after reload" });
    expect(states).toEqual(["after reload"]);

    const reloadedSrcDoc = reloaded.getAttribute("srcdoc");
    view.rerender(frameFor("<p>two</p>"));
    const rewrittenFrame = await waitFor(() => {
      const frame = view.getByTestId("artifact-frame");
      expect(frame.getAttribute("srcdoc") !== reloadedSrcDoc).toBe(true);
      return frame as HTMLIFrameElement;
    });
    const rewritten = bootFrameDocument(rewrittenFrame);
    await afterReload.post({ xumArtifact: 1, type: "setState", state: "old content" });
    await rewritten.post({ xumArtifact: 1, type: "setState", state: "new content" });
    expect(states).toEqual(["after reload", "new content"]);
  });

  test("a styled page's reported canvas color replaces the white backdrop", async () => {
    const html = "<style>body { background: #100f0f }</style><p>hi</p>";
    const view = renderArtifact("page.html", { "page.html": ok("page.html", html) });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const postBackdrop = (target: HTMLIFrameElement, color: string | null) =>
      postFromFrameDocument(target, { xumArtifact: 1, type: "backdrop", color });
    // Until the page reports, the pane shows through: no white flash while a dark page loads.
    expect(frame.className).not.toContain("bg-white");
    expect(frame.style.backgroundColor).toBe("");
    // The bind sends the theme, which the bridge answers with its own backdrop report.
    bootFrameDocument(frame);
    await deliverFrameMessages();

    await postBackdrop(frame, "rgb(16, 15, 15)");
    expect(frame.style.backgroundColor).toBe("rgb(16, 15, 15)");
    // A canvas that is not opaque (legacy or modern alpha syntax), or none, falls back to white.
    // The page paints a translucent canvas over that backing, so the same color there would
    // double its alpha.
    for (const notOpaque of [
      "rgba(0, 0, 0, 0)",
      "rgb(16 15 15 / 0)",
      "rgba(255, 0, 0, 0.5)",
      "color(srgb 1 0 0 / 0.5)",
    ]) {
      await postBackdrop(frame, "rgb(16, 15, 15)");
      await postBackdrop(frame, notOpaque);
      expect(frame.style.backgroundColor).toBe("");
      expect(frame.className).toContain("bg-white");
    }
    await postBackdrop(frame, "rgb(16, 15, 15)");
    await postBackdrop(frame, null);
    expect(frame.style.backgroundColor).toBe("");
    expect(frame.className).toContain("bg-white");

    // Only a plain computed color passes: CSS.supports alone also takes these.
    for (const color of [
      "var(--color-danger)",
      "inherit",
      "currentcolor",
      "light-dark(red, blue)",
    ]) {
      await postBackdrop(frame, color);
      expect(frame.style.backgroundColor).toBe("");
    }

    // A reloaded frame keeps the last color until its new document reports, so no white flash.
    await postBackdrop(frame, "rgb(16, 15, 15)");
    frameDocumentOf(frame).dispatch("pagehide");
    fireEvent.click(await view.findByRole("button", { name: "Reload" }));
    const reloaded = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    expect(reloaded.style.backgroundColor).toBe("rgb(16, 15, 15)");
    await postBackdrop(reloaded, null);
    expect(reloaded.style.backgroundColor).toBe("");
  });

  test("a frame's own messages can exit fullscreen but never enter it", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const panel = view.getByTestId("artifacts-panel");
    // The artifact's script can post this on load, with no key press: honoring it as a toggle
    // moved the viewer into the dialog, remounted the frame, and the next load toggled back.
    const postFromFrame = (frame: HTMLElement, key: "F" | "Escape") =>
      postFromFrameDocument(frame as HTMLIFrameElement, {
        xumArtifact: 1,
        type: "key",
        key,
        shiftKey: key === "F",
      });

    await postFromFrame(await view.findByTestId("artifact-frame"), "F");
    // Booleans: a failing toBeNull would print the whole happy-dom node.
    expect(view.queryByRole("dialog") == null).toBe(true);

    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog");
    const frames = await view.findAllByTestId("artifact-frame");
    await postFromFrame(frames[frames.length - 1], "F");
    await waitFor(() => expect(view.queryByRole("dialog") == null).toBe(true));
  });

  test("Escape from inside the frame leaves annotate mode before it closes fullscreen", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const panel = view.getByTestId("artifacts-panel");
    const postEscape = (frame: HTMLElement) =>
      postFromFrameDocument(frame as HTMLIFrameElement, {
        xumArtifact: 1,
        type: "key",
        key: "Escape",
        shiftKey: false,
      });
    const latestFrame = async () => {
      const frames = await view.findAllByTestId("artifact-frame");
      return frames[frames.length - 1];
    };
    const annotatePressed = () =>
      view
        .getAllByRole("button", { name: /^(Annotate|Stop annotating)$/ })
        .at(-1)!
        .getAttribute("aria-pressed");

    // In the sidebar.
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(panel, { key: "c" });
    expect(annotatePressed()).toBe("true");
    await postEscape(await latestFrame());
    expect(annotatePressed()).toBe("false");

    // In fullscreen: the first Escape leaves annotate mode and keeps the dialog open.
    fireEvent.keyDown(panel, { key: "c" });
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog");
    await postEscape(await latestFrame());
    expect(annotatePressed()).toBe("false");
    expect(view.queryByRole("dialog") == null).toBe(false);
    // The next one closes fullscreen.
    await postEscape(await latestFrame());
    await waitFor(() => expect(view.queryByRole("dialog") == null).toBe(true));
  });

  test("C from inside the frame toggles annotate mode only during the user's gesture there", async () => {
    let activation = { isActive: false };
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => activation,
    });
    try {
      const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
      const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
      await view.findByRole("button", { name: "Annotate" });
      const postC = () =>
        postFromFrameDocument(frame, { xumArtifact: 1, type: "key", key: "C", shiftKey: false });
      const annotatePressed = () =>
        view
          .getByRole("button", { name: /^(Annotate|Stop annotating)$/ })
          .getAttribute("aria-pressed");

      // The artifact's script posting C by itself (no focus in the frame, no activation).
      await postC();
      expect(annotatePressed()).toBe("false");
      // Focus in the frame alone is not enough: it stays there long after the click.
      act(() => frame.focus());
      await postC();
      expect(annotatePressed()).toBe("false");

      // The user's key press in the frame: focus there and activation live.
      activation = { isActive: true };
      await postC();
      expect(annotatePressed()).toBe("true");
      await postC();
      expect(annotatePressed()).toBe("false");
    } finally {
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
  });

  test("a chord posted by a frame is replayed only during the user's key press in the shown frame", async () => {
    let activation = { isActive: false };
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => activation,
    });
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const replayed: string[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === frame) replayed.push(event.key);
    };
    window.addEventListener("keydown", onKeyDown, true);
    // The host builds the replayed event with the global constructor, which the DOM harness lacks.
    const globalKeyboardEvent = globalThis.KeyboardEvent;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    try {
      const postChord = (chord: "sidebar" | "agentInterface" | "peek") =>
        postFromFrameDocument(frame, {
          xumArtifact: 1,
          type: "sidebarKey",
          chord,
          ctrlKey: true,
          metaKey: false,
        });
      const sidebarKey = KEYBINDS.TOGGLE_RIGHT_SIDEBAR.key;
      // The page's script can move focus into its frame (window.focus()) and post the chord from
      // a timer: without the user's activation that must not collapse the sidebar.
      act(() => frame.focus());
      await postChord("sidebar");
      expect(replayed).toEqual([]);

      activation = { isActive: true };
      await postChord("sidebar");
      expect(replayed).toEqual([sidebarKey]);
      // Only the main pane's status page forwards its chords: here the page's script posted them.
      await postChord("agentInterface");
      await postChord("peek");
      expect(replayed).toEqual([sidebarKey]);

      // A frame that stopped rendering keeps focus in the browser; that focus does not count.
      frame.parentElement!.style.display = "none";
      expect(document.activeElement).toBe(frame);
      await postChord("sidebar");
      expect(replayed).toEqual([sidebarKey]);
    } finally {
      globalThis.KeyboardEvent = globalKeyboardEvent;
      window.removeEventListener("keydown", onKeyDown, true);
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
  });

  test("warns above HTML artifacts only when agent-browser is known to be missing", async () => {
    const warning = "Not checked by the agent: agent-browser is not available on this runtime.";
    for (const value of [true, null]) {
      agentBrowserAvailable = value;
      capabilityRequests = 0;
      const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
      await view.findByTestId("artifact-frame");
      await waitFor(() => expect(capabilityRequests).toBeGreaterThan(0));
      // Let the answer render before asserting the warning stays absent.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.queryByText(warning)).toBeNull();
      cleanup();
    }

    agentBrowserAvailable = false;
    const html = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    expect(await html.findByText(warning)).toBeTruthy();
    expect(await html.findByTestId("artifact-frame")).toBeTruthy();
    cleanup();

    const markdown = renderArtifact("notes.md", { "notes.md": ok("notes.md", "# Notes") });
    expect(await markdown.findByText("Notes")).toBeTruthy();
    expect(markdown.queryByText(warning)).toBeNull();
  });

  test("an agent-browser answer for one workspace never shows for another", async () => {
    // ws-a answers false; ws-b's request fails, which must read as unknown, not ws-a's false.
    const client = createTestApiClient({
      artifacts: {
        capabilities: (input: { workspaceId: string }) =>
          input.workspaceId === "ws-a"
            ? Promise.resolve({ agentBrowserAvailable: false })
            : Promise.reject(new Error("unreachable")),
      },
    } satisfies TestApiOverrides<APIClient>);
    const hook = renderHook(
      (props: { workspaceId: string }) => useAgentBrowserAvailable(props.workspaceId),
      {
        initialProps: { workspaceId: "ws-a" },
        wrapper: (props: { children: ReactNode }) => (
          <APIProvider client={client}>{props.children}</APIProvider>
        ),
      }
    );
    await waitFor(() => expect(hook.result.current).toBe(false));
    hook.rerender({ workspaceId: "ws-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hook.result.current).toBeNull();
  });

  test("resolves relative Markdown images through the artifacts API", async () => {
    const view = renderArtifact("notes/report.md", {
      "notes/report.md": ok("notes/report.md", "# R\n\n![chart](img/c.png)"),
      "notes/img/c.png": ok("notes/img/c.png", "iVBORw0KGgo=", "base64"),
    });
    const image = await view.findByRole("img", { name: "chart" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    // Asset reads carry the per-asset cap, so the backend refuses oversize assets up front.
    expect(readInputs).toContainEqual({
      path: "notes/img/c.png",
      maxBytes: ARTIFACT_ASSET_LIMITS.maxAssetBytes,
    });
    // The reader keeps its identity, so the image is read once, not in a render loop.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readRequests.filter((path) => path === "notes/img/c.png")).toHaveLength(1);
  });

  test("zooms an image with keyboard shortcuts while its viewport has focus", async () => {
    const view = renderArtifact("img/c.png", {
      "img/c.png": ok("img/c.png", "iVBORw0KGgo=", "base64"),
    });
    fireEvent.load(await view.findByRole("img", { name: "img/c.png" }));
    const viewport = view.getByLabelText("Image viewport");
    fireEvent.keyDown(viewport, { key: "1" });
    expect(await view.findByText(/^100%/)).toBeTruthy();
    // Shift+= is "+": both zoom in.
    fireEvent.keyDown(viewport, { key: "+", code: "Equal", shiftKey: true });
    expect(await view.findByText(/^125%/)).toBeTruthy();
    fireEvent.keyDown(viewport, { key: "-", code: "Minus" });
    expect(await view.findByText(/^100%/)).toBeTruthy();
    fireEvent.keyDown(viewport, { key: "0" });
    expect(await view.findByText(/^Fit/)).toBeTruthy();
  });

  test("zooming out of a fitted image never enlarges it past the fit scale", async () => {
    const view = renderArtifact("img/huge.png", {
      "img/huge.png": ok("img/huge.png", "iVBORw0KGgo=", "base64"),
    });
    const image = await view.findByRole("img", { name: "img/huge.png" });
    // 10000px image in a 400px viewport: fit scale 0.04, below the 10% minimum zoom.
    const viewport = view.getByLabelText("Image viewport");
    Object.defineProperty(viewport, "clientWidth", { value: 400 });
    Object.defineProperty(viewport, "clientHeight", { value: 400 });
    Object.defineProperty(image, "naturalWidth", { value: 10000 });
    Object.defineProperty(image, "naturalHeight", { value: 10000 });
    fireEvent.load(image);
    expect(await view.findByText(/10000×10000/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Zoom out" }));
    expect(view.getByText(/^Fit/)).toBeTruthy();
    expect(view.queryByText(/^10%/)).toBeNull();
  });

  test("renders patches, including hunks whose header counts are wrong", async () => {
    // The header claims 5 old lines but the hunk has 3: jsdiff rejects it, the fallback does not.
    const patch = [
      "diff --git a/src/q.ts b/src/q.ts",
      "--- a/src/q.ts",
      "+++ b/src/q.ts",
      "@@ -1,5 +1,3 @@",
      " keep",
      "-old line",
      "+new line",
      " end",
    ].join("\n");
    const view = renderArtifact("fix.patch", { "fix.patch": ok("fix.patch", patch) });
    expect(await view.findByText("src/q.ts")).toBeTruthy();
    expect(view.queryByText(/No diff hunks found/)).toBeNull();
  });

  test("shows patches over the line cap as raw text instead of highlighted diffs", async () => {
    const lines = Array.from({ length: DIFF_ARTIFACT_MAX_LINES + 1 }, (_, i) => `+line ${i}`);
    const patch = [
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines,
    ].join("\n");
    const view = renderArtifact("big.patch", { "big.patch": ok("big.patch", patch) });
    expect(await view.findByText(/Too many diff lines to highlight/)).toBeTruthy();
    expect(view.getByText(/\+line 5000/)).toBeTruthy();
    // DiffRenderer's file header is absent; the name only appears inside the raw text.
    expect(view.queryByText("src/big.ts")).toBeNull();
  });

  test("offers Download for previewable files and Copy path for over-cap files", async () => {
    const view = renderArtifact("a.txt", {
      "a.txt": ok("a.txt", "alpha"),
      "huge.log": {
        status: "too_large",
        path: "huge.log",
        kind: "text",
        size: 20,
        modifiedMs: 1,
        maxBytes: 10,
      },
    });
    expect(await view.findByText("alpha")).toBeTruthy();
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Download artifact" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "j" });
    expect(await view.findByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Download artifact" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  test("does not download text whose bytes were not valid UTF-8", async () => {
    // The backend decodes text with replacement characters (U+FFFD); re-encoding that string
    // would save different bytes than the file on disk, silently.
    const view = renderArtifact("legacy.csv", { "legacy.csv": ok("legacy.csv", "caf\uFFFD,1") });
    expect(await view.findByText(/caf/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Download artifact" }).hasAttribute("disabled")).toBe(
      true
    );
  });
});
