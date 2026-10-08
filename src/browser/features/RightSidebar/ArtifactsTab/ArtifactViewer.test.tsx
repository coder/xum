// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { ARTIFACT_ASSET_LIMITS } from "./artifactAssets";
import { buildArtifactCsp } from "./artifactCsp";
import { DIFF_ARTIFACT_MAX_LINES } from "./DiffArtifact";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ARTIFACT_TABLE_MAX_COLUMNS, ARTIFACT_TABLE_MAX_ROWS } from "./DataTable";
import { JSON_TREE_MAX_NODES } from "./jsonData";
import { useAgentBrowserAvailable } from "./useAgentBrowserAvailable";

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

function Wrapper(props: { children: ReactNode }) {
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      // No versions or pinned files: these tests cover the live renderers.
      getState: () =>
        Promise.resolve({ success: true as const, data: { version: 0, state: null } }),
      listVersions: (input: { workspaceId: string; path: string }) =>
        Promise.resolve({
          success: true as const,
          data: { artifactId: input.path, path: input.path, pin: null, versions: [] },
        }),
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
    const frameWindow = frame.contentWindow;
    fireEvent.load(frame);
    // The second load is a navigation (location.href, a clicked link).
    fireEvent.load(frame);
    expect(await view.findByText(/This artifact navigated away/)).toBeTruthy();
    expect(view.queryByTestId("artifact-frame")).toBeNull();
    // Whatever the old window posts now is ignored (F would toggle fullscreen).
    act(() => {
      const event = new window.Event("message");
      Object.defineProperty(event, "data", {
        value: { xumArtifact: 1, type: "key", key: "F", shiftKey: false },
      });
      Object.defineProperty(event, "source", { value: frameWindow });
      window.dispatchEvent(event);
    });
    expect(view.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    expect(await view.findByTestId("artifact-frame")).toBeTruthy();
  });

  test("a frame's own messages can exit fullscreen but never enter it", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const panel = view.getByTestId("artifacts-panel");
    // The artifact's script can post this on load, with no key press: honoring it as a toggle
    // moved the viewer into the dialog, remounted the frame, and the next load toggled back.
    const postFromFrame = (frame: HTMLElement, key: "F" | "Escape") =>
      act(() => {
        const event = new window.Event("message");
        Object.defineProperty(event, "data", {
          value: { xumArtifact: 1, type: "key", key, shiftKey: key === "F" },
        });
        Object.defineProperty(event, "source", {
          value: (frame as HTMLIFrameElement).contentWindow,
        });
        window.dispatchEvent(event);
      });

    postFromFrame(await view.findByTestId("artifact-frame"), "F");
    // Booleans: a failing toBeNull would print the whole happy-dom node.
    expect(view.queryByRole("dialog") == null).toBe(true);

    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog");
    const frames = await view.findAllByTestId("artifact-frame");
    postFromFrame(frames[frames.length - 1], "F");
    await waitFor(() => expect(view.queryByRole("dialog") == null).toBe(true));
  });

  test("Escape from inside the frame leaves annotate mode before it closes fullscreen", async () => {
    const view = renderArtifact("page.html", { "page.html": ok("page.html", "<p>hi</p>") });
    const panel = view.getByTestId("artifacts-panel");
    const postEscape = (frame: HTMLElement) =>
      act(() => {
        const event = new window.Event("message");
        Object.defineProperty(event, "data", {
          value: { xumArtifact: 1, type: "key", key: "Escape", shiftKey: false },
        });
        Object.defineProperty(event, "source", {
          value: (frame as HTMLIFrameElement).contentWindow,
        });
        window.dispatchEvent(event);
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
    postEscape(await latestFrame());
    expect(annotatePressed()).toBe("false");

    // In fullscreen: the first Escape leaves annotate mode and keeps the dialog open.
    fireEvent.keyDown(panel, { key: "c" });
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog");
    postEscape(await latestFrame());
    expect(annotatePressed()).toBe("false");
    expect(view.queryByRole("dialog") == null).toBe(false);
    // The next one closes fullscreen.
    postEscape(await latestFrame());
    await waitFor(() => expect(view.queryByRole("dialog") == null).toBe(true));
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
