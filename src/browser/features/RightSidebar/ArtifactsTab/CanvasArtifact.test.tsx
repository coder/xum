// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createTestApiClient } from "@/browser/testUtils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { CanvasArtifact } from "./CanvasArtifact";
import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_CHART_SERIES,
  chartSeries,
  parseCanvas,
  resolveJsonPointer,
} from "./canvasSpec";
import type { JsonValue } from "./jsonData";

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

let files: Record<string, ArtifactReadResult> = {};
let readPaths: string[] = [];

function Wrapper(props: { children: ReactNode }) {
  // One client per mount, as in the app: a fresh client on every rerender would re-run every
  // effect that depends on the API and hide missing reload dependencies.
  const [api] = useState(() =>
    createTestApiClient({
      artifacts: {
        read: (input: { workspaceId: string; path: string }) => {
          readPaths.push(input.path);
          const file = files[input.path];
          return Promise.resolve(
            file
              ? { success: true as const, data: file }
              : { success: false as const, error: `Artifact not found: ${input.path}` }
          );
        },
      },
    })
  );
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={api}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

function canvas(blocks: unknown[]): string {
  return JSON.stringify({ $xum: "canvas", blocks });
}

describe("parseCanvas", () => {
  test("keeps valid blocks and marks unknown or malformed ones per block", () => {
    const parsed = parseCanvas(
      canvas([{ type: "stat", label: "Runs", value: 3 }, { type: "widget" }, { type: "chart" }, 7])
    );
    expect(parsed.ok && parsed.blocks).toEqual([
      { type: "stat", label: "Runs", value: 3 },
      { type: "unsupported", blockType: "widget" },
      { type: "invalid", blockType: "chart" },
      { type: "unsupported", blockType: "" },
    ]);
  });

  test("rejects invalid JSON and documents that are not canvases", () => {
    expect(parseCanvas("{oops")).toEqual({ ok: false, reason: "not_json" });
    expect(parseCanvas(JSON.stringify({ $xum: "table", blocks: [] }))).toEqual({
      ok: false,
      reason: "not_canvas",
    });
  });
});

describe("chartSeries", () => {
  test("plots at most CANVAS_MAX_CHART_SERIES series and counts the rest", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `s${i}`);
    expect(chartSeries(many)).toEqual({
      series: many.slice(0, CANVAS_MAX_CHART_SERIES),
      total: 10_000,
    });
    expect(chartSeries("v")).toEqual({ series: ["v"], total: 1 });
  });
});

describe("resolveJsonPointer", () => {
  const document: JsonValue = { "a/b": { "m~n": [1, { x: 2 }], "~1": "tilde-one" }, "": 5 };

  test("follows RFC 6901 tokens, escapes and array indexes", () => {
    expect(resolveJsonPointer(document, "")).toEqual({ ok: true, value: document });
    expect(resolveJsonPointer(document, "/a~1b/m~0n/1/x")).toEqual({ ok: true, value: 2 });
    // "~01" decodes to the key "~1", not to "~/".
    expect(resolveJsonPointer(document, "/a~1b/~01")).toEqual({ ok: true, value: "tilde-one" });
    expect(resolveJsonPointer(document, "/")).toEqual({ ok: true, value: 5 });
  });

  test("reports missing targets and malformed pointers", () => {
    for (const pointer of [
      "/missing",
      "/a~1b/m~0n/2",
      "/a~1b/m~0n/01",
      "/a~1b/m~0n/-",
      "/a~2",
      "x",
    ]) {
      expect(resolveJsonPointer(document, pointer).ok).toBe(false);
    }
  });
});

describe("CanvasArtifact", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    files = {};
    readPaths = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderCanvas(
    content: string,
    interactions?: { requestSend: (t: string, d?: unknown) => void }
  ) {
    return render(
      <CanvasArtifact
        content={content}
        path="reports/q3.canvas.json"
        workspaceId="ws-canvas"
        interactions={interactions}
      />,
      { wrapper: Wrapper }
    );
  }

  test("shows the source for a file that is not a canvas", () => {
    const content = JSON.stringify({ $xum: "nope" });
    const view = renderCanvas(content);
    expect(view.getByText(content)).toBeTruthy();
    expect(view.queryByTestId("canvas-artifact")).toBeNull();
  });

  test("renders unsupported blocks as a notice next to the supported ones", () => {
    const view = renderCanvas(
      canvas([{ type: "stat", label: "Latency", value: "142 ms" }, { type: "widget" }])
    );
    expect(view.getByText("142 ms")).toBeTruthy();
    expect(view.getByText("Unsupported block: widget")).toBeTruthy();
  });

  test("reads contained refs only, and reports escaping, external and missing ones", async () => {
    files["reports/data/s.json"] = ok(
      "reports/data/s.json",
      JSON.stringify({ series: [{ q: "Q1", v: 1 }] })
    );
    const view = renderCanvas(
      canvas([
        { type: "chart", kind: "bar", data: "data/s.json#/series", x: "q", y: "v", title: "Good" },
        { type: "chart", kind: "line", data: "data/s.json#/nope", x: "q", y: "v" },
        { type: "chart", kind: "bar", data: "../../secret.json#/x", x: "q", y: "v" },
        { type: "image", src: "https://tracker.example/p.png" },
        { type: "diff", patch: "../../etc/passwd" },
      ])
    );
    expect(view.getByText("Reference leaves the artifacts folder: ../../secret.json")).toBeTruthy();
    expect(view.getByText("Reference leaves the artifacts folder: ../../etc/passwd")).toBeTruthy();
    expect(
      view.getByText(
        "Only files in the artifacts folder can be referenced: https://tracker.example/p.png"
      )
    ).toBeTruthy();
    expect(await view.findByText("Nothing at JSON pointer /nope")).toBeTruthy();
    expect(view.getByText("Good")).toBeTruthy();
    // Both charts share one read of the contained file; nothing else is requested.
    expect(readPaths).toEqual(["reports/data/s.json"]);
  });

  test("a panel refresh re-reads referenced files and shows their new data", async () => {
    files["reports/data/s.json"] = ok(
      "reports/data/s.json",
      JSON.stringify({ series: [{ q: "Q1", v: 1 }] })
    );
    const content = canvas([
      { type: "chart", kind: "bar", data: "data/s.json#/series", x: "q", y: "v", title: "Q" },
    ]);
    const element = (reloadToken: number) => (
      <CanvasArtifact
        content={content}
        path="reports/q3.canvas.json"
        workspaceId="ws-canvas"
        reloadToken={reloadToken}
      />
    );
    const view = render(element(0), { wrapper: Wrapper });
    expect(await view.findByText("Q")).toBeTruthy();
    // The agent rewrites the data file; the canvas file itself is unchanged.
    files["reports/data/s.json"] = ok("reports/data/s.json", JSON.stringify({ other: [] }));
    view.rerender(element(1));
    expect(await view.findByText("Nothing at JSON pointer /series")).toBeTruthy();
    expect(readPaths).toEqual(["reports/data/s.json", "reports/data/s.json"]);
  });

  test("a chart with too many series says how many it plots", () => {
    const y = Array.from({ length: 10_000 }, (_, i) => `s${i}`);
    const view = renderCanvas(
      canvas([{ type: "chart", kind: "line", data: [{ q: 1 }], x: "q", y }])
    );
    expect(view.getByText(`Showing first ${CANVAS_MAX_CHART_SERIES} of 10000 series`)).toBeTruthy();
  });

  test("renders at most CANVAS_MAX_BLOCKS blocks and says how many it left out", () => {
    const blocks = Array.from({ length: CANVAS_MAX_BLOCKS + 25 }, (_, i) => ({
      type: "markdown",
      text: `block-${i}`,
    }));
    const view = renderCanvas(canvas(blocks));
    expect(view.getByText(`block-${CANVAS_MAX_BLOCKS - 1}`)).toBeTruthy();
    expect(view.queryByText(`block-${CANVAS_MAX_BLOCKS}`)).toBeNull();
    expect(
      view.getByText(`Showing the first ${CANVAS_MAX_BLOCKS} blocks; 25 more are not shown.`)
    ).toBeTruthy();
  });

  test("buttons only exist with interactions and send only when clicked", () => {
    const content = canvas([
      { type: "button", label: "Rerun", send: "rerun the report", data: { quarter: "Q3" } },
    ]);
    const readOnly = renderCanvas(content);
    expect(readOnly.queryByRole("button", { name: "Rerun" })).toBeNull();
    cleanup();

    const requestSend = mock((_text: string, _data?: unknown) => undefined);
    const view = renderCanvas(content, { requestSend });
    const button = view.getByRole("button", { name: "Rerun" });
    expect(requestSend).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(requestSend.mock.calls).toEqual([["rerun the report", { quarter: "Q3" }]]);
  });
});
