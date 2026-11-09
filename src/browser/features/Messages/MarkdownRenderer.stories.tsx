import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_TITLEBAR_HEIGHT_PX } from "@/browser/hooks/useDesktopTitlebar";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { windowDragsAtEach, withDesktopApi } from "@/browser/stories/helpers/windowDrag";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { expectNoDiagramInkOutsideBox } from "@/browser/stories/storyPlayHelpers";
import { MERMAID_DIAGRAM_ZOOM_KEY } from "@/common/constants/storage";
import { SIDE_INSET_VIEWPORT } from "@/constants/layout";
import { MERMAID_PAGE_DIAGRAM_SELECTOR } from "@/constants/mermaid";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { UserMessageContent } from "./UserMessageContent";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/MarkdownRenderer",
  component: MarkdownRenderer,
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;

type Story = StoryObj<typeof meta>;

function AssistantMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden">
        <MarkdownRenderer content={props.content} />
      </div>
    </div>
  );
}

function UserMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden px-4 py-3">
        <UserMessageContent content={props.content} variant="sent" />
      </div>
    </div>
  );
}

const TABLE_CONTENT = `Here are markdown table examples:

## Simple table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
| Value D  | Value E  | Value F  |

## Alignment table

| Left | Center | Right |
|:-----|:------:|------:|
| L    | C      | R     |
| Text | Text   | Text  |

## Code in table cells

| Feature | Status | Notes |
|---------|--------|-------|
| \`markdown\` | ✅ Done | Full GFM |
| **Bold** | ✅ Done | Works |`;

const CODE_BLOCK_CONTENT = `Single-line block:

\`\`\`bash
npm install mux
\`\`\`

Multi-line block:

\`\`\`typescript
import { verifyToken } from "../auth/jwt";

export async function getUser(req: Request, res: Response) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.json({ ok: true });
}
\`\`\``;

const BLOCKQUOTE_CONTENT = `Simple quote:

> This is a simple blockquote.

Quote with inline formatting:

> **Important:** Inline \`code\`, **bold**, and *italic* should render correctly.

Nested quote:

> Outer quote
>
> > Inner quote
>
> Outer quote again.`;

const LONG_LINE_CONTENT = `Long lines should stay inside the message container.

\`\`\`
const reallyLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix, argumentSeven, argumentEight, argumentNine, argumentTen);
\`\`\`

This is a very long paragraph without manual line breaks that should wrap within the message content area instead of forcing horizontal overflow in the surrounding layout.`;

/** Markdown tables */
export const Tables: Story = {
  render: () => <AssistantMarkdownCanvas content={TABLE_CONTENT} />,
};

/** Code blocks with both single-line and multi-line examples */
export const CodeBlocks: Story = {
  render: () => <AssistantMarkdownCanvas content={CODE_BLOCK_CONTENT} />,
};

/** Blockquotes with nested and inline-formatted content */
export const Blockquotes: Story = {
  render: () => <AssistantMarkdownCanvas content={BLOCKQUOTE_CONTENT} />,
};

/** Long-line rendering in user message markdown content */
export const LongLines: Story = {
  render: () => <UserMarkdownCanvas content={LONG_LINE_CONTENT} />,
};

const mermaidFence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

const WIDE_FLOWCHART_CONTENT = mermaidFence(
  "flowchart LR\nA[Request]-->B[Parse]-->C[Plan]-->D[Build]-->E[Test]-->F[Ship]"
);

// A state diagram that Pele lays out at about 2089x1372 px even for a phone-wide column: far
// larger than any frame it sits in. On iPhone Safari it painted over the paragraphs below it.
const STATE_DIAGRAM_CONTENT =
  mermaidFence(`---
title: "label_low_risk.py: from the checks to the one line it prints"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: work
    lg1: pass
    lg2: refuse
    lg3: bad
    lg4: Breaks EveryEndPrintsALine or NoSilentLabel or OldLabelLossIsSaid or RatingIsCorrected
    lg5: Path to the EveryEndPrintsALine or NoSilentLabel or OldLabelLossIsSaid or RatingIsCorrected bug
  }
  class lg0 blue
  class lg1 teal
  class lg2 yellow
  class lg3 pink
  class lg4 breaks
  class lg5 bugPath
  s0: Checking the pull request and its report
  s1: Refused, taking its label off
  s2: Checking again, then adding the label
  s3: Taking off the label it had before
  s4: Refused, writing the line and any correction
  s5: Killed with no line, the old label is gone
  s6: Killed with no line
  s7: Waiting for the run of the label and its report
  s8: Refused
  s9: Posting the rating, then checking once more
  s10: Refused, the line says the label can still be on
  s11: Killed with no line, its label can be on
  s12: Passed, printing LABELED
  s13: Labeled
  s14: Killed with no line, the rating stands
  [*] --> s0
  s0 --> s1: a check, a call, the deadline or a signal refuses
  s0 --> s2: the checks pass
  s0 --> s3: the checks pass [the label is on already]
  s2 --> s1: a check, a call, the deadline or a signal refuses
  s2 --> s2: the checks pass again
  s3 --> s1: a check, a call, the deadline or a signal refuses
  s3 --> s2: the old label comes off
  s2 --> s7: the label goes on
  s1 --> s4: it tries to take the label off
  s1 --> s5: a signal comes during the read of the old label
  s1 --> s6: a signal comes during the read of the old label
  s4 --> s8: it prints REFUSED
  s4 --> s6: a signal comes between two calls
  s1 --> s1: it reads the old label if it must
  s7 --> s1: a check, a call, the deadline or a signal refuses
  s7 --> s7: the run of the label and its report pass
  s4 --> s5: a signal comes between two calls
  s7 --> s9: the run of the label and its report pass
  s4 --> s10: it prints REFUSED
  s4 --> s11: a signal comes between two calls
  s9 --> s1: a check, a call, the deadline or a signal refuses
  s9 --> s9: the rating posts and the pull request is as rated
  s9 --> s12: the rating posts and the pull request is as rated
  s12 --> s13: it prints LABELED
  s12 --> s11: a signal comes between two calls
  s4 --> s14: a signal comes between two calls
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 blue
  class s0 bugPath
  class s1 yellow
  class s1 bugPath
  class s2 blue
  class s2 bugPath
  class s3 blue
  class s3 bugPath
  class s4 yellow
  class s4 bugPath
  class s5 pink
  class s5 breaks
  class s5 bugPath
  class s6 pink
  class s6 breaks
  class s7 blue
  class s7 bugPath
  class s8 yellow
  class s9 blue
  class s9 bugPath
  class s10 yellow
  class s11 pink
  class s11 breaks
  class s11 bugPath
  class s12 blue
  class s12 bugPath
  class s13 teal
  class s14 pink
  class s14 breaks`) +
  "\n\nThis paragraph follows the diagram. On iPhone Safari the diagram painted over text like it.";

// Mirror Pixel's named viewports so each story's globals pin the width that CI snapshots.
const MERMAID_VIEWPORTS = {
  options: {
    phone390: { name: "Phone 390", styles: { width: "390px", height: "844px" }, type: "mobile" },
    laptop1200: {
      name: "Laptop 1200",
      styles: { width: "1200px", height: "900px" },
      type: "desktop",
    },
    sideInset: {
      name: "Side inset",
      styles: {
        width: `${SIDE_INSET_VIEWPORT.width}px`,
        height: `${SIDE_INSET_VIEWPORT.height}px`,
      },
      type: "mobile",
    },
  },
};

const PHONE_COLUMN_WIDTH = 358;
const LAPTOP_COLUMN_WIDTH = 768;

// The column has a fixed width because the test runner plays every story at desktop width.
function MermaidColumn(props: { content: string; width: number }) {
  return (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: props.width }}>
        <MarkdownRenderer content={props.content} />
      </div>
    </div>
  );
}

/**
 * Where a diagram sits: the SVG's box, the frame around it, and the size Pele measured for the
 * drawing (the viewBox). The three disagree when an engine sizes the box from intrinsic
 * dimensions instead of from explicit pixels (iPhone Safari).
 */
interface DiagramGeometry {
  svg: DOMRect;
  container: HTMLElement;
  frame: DOMRect;
  drawing: { width: number; height: number };
}

const DIALOG_SVG = ".mermaid-modal > svg.pele";

function measureDiagram(
  canvasElement: HTMLElement,
  selector = MERMAID_PAGE_DIAGRAM_SELECTOR
): DiagramGeometry {
  const svg = canvasElement.querySelector<SVGSVGElement>(selector);
  if (!svg) throw new Error("The diagram has not rendered yet");
  const container = svg.parentElement!;
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(" ").map(Number);
  if (!(width > 0 && height > 0)) throw new Error("The diagram has no viewBox");
  return {
    svg: svg.getBoundingClientRect(),
    container,
    frame: container.parentElement!.getBoundingClientRect(),
    drawing: { width, height },
  };
}

/** The box and the zoom step are whole pixels, so they differ from the exact values by this much. */
const PIXEL_TOLERANCE = 1.5;

/** The box is the drawing scaled by one factor, up to the rounding of each side to a pixel. */
async function expectBoxKeepsDrawingProportions({ svg, drawing }: DiagramGeometry) {
  const lowestScale = Math.max(
    (svg.width - 0.5) / drawing.width,
    (svg.height - 0.5) / drawing.height
  );
  const highestScale = Math.min(
    (svg.width + 0.5) / drawing.width,
    (svg.height + 0.5) / drawing.height
  );
  await expect(lowestScale).toBeLessThanOrEqual(highestScale + 1e-6);
}

/** The boxes a reader sees agree: nothing paints outside the frame that holds the diagram. */
async function expectDiagramInsideFrame(geometry: DiagramGeometry) {
  const { svg, container, frame } = geometry;
  // The drawing fills its box instead of sitting letterboxed or stretched inside it.
  await expectBoxKeepsDrawingProportions(geometry);
  // The box lies inside the area the container can scroll, so a wide diagram pans inside its frame.
  const containerBox = container.getBoundingClientRect();
  const left = svg.left - containerBox.left + container.scrollLeft;
  const top = svg.top - containerBox.top + container.scrollTop;
  await expect(left).toBeGreaterThanOrEqual(-0.5);
  await expect(top).toBeGreaterThanOrEqual(-0.5);
  await expect(left + svg.width).toBeLessThanOrEqual(container.scrollWidth + 0.5);
  await expect(top + svg.height).toBeLessThanOrEqual(container.scrollHeight + 0.5);
  // The frame is at least as tall as the box, so the text below the frame is not painted over.
  await expect(svg.top).toBeGreaterThanOrEqual(frame.top - 0.5);
  await expect(svg.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
  await expect(frame.height).toBeGreaterThanOrEqual(svg.height);
}

/** Waits until the diagram has rendered at the column's width and every box agrees. */
async function waitForDiagram(
  canvasElement: HTMLElement,
  expectation?: (geometry: DiagramGeometry) => Promise<void>
) {
  await waitFor(
    async () => {
      const geometry = measureDiagram(canvasElement);
      await expectDiagramInsideFrame(geometry);
      await expectation?.(geometry);
    },
    { timeout: 10_000 }
  );
  return measureDiagram(canvasElement);
}

/** The +/- buttons resize the box by one zoom step, and − undoes +. */
async function expectZoomResizesBox(canvasElement: HTMLElement) {
  const controls = within(canvasElement);
  const before = measureDiagram(canvasElement).svg;
  await userEvent.click(controls.getByRole("button", { name: "+" }));
  await waitFor(() =>
    expect(measureDiagram(canvasElement).svg.width).toBeGreaterThan(before.width)
  );
  const grown = measureDiagram(canvasElement);
  await expect(Math.abs(grown.svg.width - before.width * 1.1)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  await expectDiagramInsideFrame(grown);
  await expectNoDiagramInkOutsideBox();

  await userEvent.click(controls.getByRole("button", { name: "−" }));
  await waitFor(() =>
    expect(Math.abs(measureDiagram(canvasElement).svg.width - before.width)).toBeLessThanOrEqual(
      PIXEL_TOLERANCE
    )
  );
}

/** Zoom is shared by every diagram and persists, so each play starts and ends at 100%. */
async function playAtDefaultZoom(play: () => Promise<void>) {
  updatePersistedState(MERMAID_DIAGRAM_ZOOM_KEY, 1);
  try {
    await play();
  } finally {
    updatePersistedState(MERMAID_DIAGRAM_ZOOM_KEY, 1);
  }
}

/** Below 640 px a left-to-right flowchart turns top-to-bottom and drops the height cap. */
export const MermaidPhone: Story = {
  // Storybook reads tags only from string literals, so every Mermaid story repeats this one.
  tags: ["paint-check"],
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: { matrix: { viewports: ["phone"] } } },
  render: () => <MermaidColumn content={WIDE_FLOWCHART_CONTENT} width={PHONE_COLUMN_WIDTH} />,
  play: async ({ canvasElement, parameters, globals }) => {
    // The pinned Pixel variant and the local viewport must stay paired, or this story
    // snapshots the wide layout.
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });

    await playAtDefaultZoom(async () => {
      await waitForDiagram(canvasElement, async ({ svg, drawing }) => {
        // A tall layout, drawn at its measured size instead of shrunk to the height cap.
        await expect(svg.height).toBeGreaterThan(svg.width);
        await expect(Math.abs(svg.height - drawing.height)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
      });
      await expectZoomResizesBox(canvasElement);
    });
  },
};

/** At 640 px and wider the same flowchart keeps its left-to-right layout. */
export const MermaidLaptop: Story = {
  tags: ["paint-check"],
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: { matrix: { viewports: ["laptop"] } } },
  render: () => <MermaidColumn content={WIDE_FLOWCHART_CONTENT} width={LAPTOP_COLUMN_WIDTH} />,
  play: async ({ canvasElement }) => {
    await playAtDefaultZoom(async () => {
      await waitForDiagram(canvasElement, async ({ svg, container }) => {
        await expect(svg.width).toBeGreaterThan(svg.height);
        await expect(svg.height).toBeLessThanOrEqual(300 + PIXEL_TOLERANCE);
        await expect(svg.width).toBeLessThanOrEqual(container.clientWidth + PIXEL_TOLERANCE);
      });
      await expectZoomResizesBox(canvasElement);
    });
  },
};

/** A diagram far wider than a phone keeps its measured size and pans inside its frame. */
export const MermaidStatePhone: Story = {
  tags: ["paint-check"],
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: PIXEL_DISABLED },
  render: () => <MermaidColumn content={STATE_DIAGRAM_CONTENT} width={PHONE_COLUMN_WIDTH} />,
  play: async ({ canvasElement }) => {
    await playAtDefaultZoom(async () => {
      await waitForDiagram(canvasElement, async ({ svg, container, drawing }) => {
        await expect(Math.abs(svg.width - drawing.width)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
        await expect(svg.width).toBeGreaterThan(container.clientWidth);
      });
      await expectZoomResizesBox(canvasElement);
    });
  },
};

/** The same diagram in a laptop-wide column shrinks to fit the width and the height cap. */
export const MermaidStateLaptop: Story = {
  tags: ["paint-check"],
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: PIXEL_DISABLED },
  render: () => <MermaidColumn content={STATE_DIAGRAM_CONTENT} width={LAPTOP_COLUMN_WIDTH} />,
  play: async ({ canvasElement }) => {
    await playAtDefaultZoom(async () => {
      await waitForDiagram(canvasElement, async ({ svg, container, drawing }) => {
        await expect(svg.height).toBeLessThanOrEqual(300 + PIXEL_TOLERANCE);
        await expect(svg.width).toBeLessThan(drawing.width);
        await expect(svg.width).toBeLessThanOrEqual(container.clientWidth + PIXEL_TOLERANCE);
      });
      await expectZoomResizesBox(canvasElement);
    });
  },
};

const PHONE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1200, height: 900 };

/** The layout viewport, which the dialog's fixed overlay normally fills. */
function layoutViewport() {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
}

/** The part of the page an element shows: the intersection of every box that clips it. */
function visibleAreaOf(element: Element) {
  const viewport = layoutViewport();
  let area = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflow === "visible") continue;
    const box = ancestor.getBoundingClientRect();
    const left = box.left + ancestor.clientLeft;
    const top = box.top + ancestor.clientTop;
    area = {
      left: Math.max(area.left, left),
      top: Math.max(area.top, top),
      right: Math.min(area.right, left + ancestor.clientWidth),
      bottom: Math.min(area.bottom, top + ancestor.clientHeight),
    };
  }
  return area;
}

/**
 * The expand dialog shows the whole diagram: it lies inside what the dialog shows, and it is
 * as large as the room the dialog leaves it allows on its tighter axis, so it is not shrunk
 * more than it must be. The room is the measured content box of the diagram's container.
 */
async function expectDialogShowsWholeDiagram(canvasElement: HTMLElement) {
  await waitFor(
    async () => {
      const geometry = measureDiagram(canvasElement, DIALOG_SVG);
      const { svg: box, container, drawing } = geometry;
      const room = { width: container.clientWidth, height: container.clientHeight };
      const area = visibleAreaOf(canvasElement.querySelector(DIALOG_SVG)!);
      await expect(box.left).toBeGreaterThanOrEqual(area.left - 0.5);
      await expect(box.top).toBeGreaterThanOrEqual(area.top - 0.5);
      await expect(box.right).toBeLessThanOrEqual(area.right + 0.5);
      await expect(box.bottom).toBeLessThanOrEqual(area.bottom + 0.5);
      await expectBoxKeepsDrawingProportions(geometry);
      await expect(box.width).toBeLessThan(drawing.width);
      const fillsWidth = Math.abs(box.width - room.width) <= PIXEL_TOLERANCE;
      const fillsHeight = Math.abs(box.height - room.height) <= PIXEL_TOLERANCE;
      await expect(fillsWidth || fillsHeight).toBe(true);
    },
    { timeout: 10_000 }
  );
}

/** Opens the expand dialog on the state chart, checks it, and closes it again. */
async function playDialog(
  canvasElement: HTMLElement,
  viewport: { width: number; height: number },
  whileOpen?: (close: HTMLElement) => Promise<void>
) {
  // The test runner pins this size before it plays the story (.storybook/test-runner.ts).
  await expect(layoutViewport()).toEqual(viewport);
  await playAtDefaultZoom(async () => {
    await waitForDiagram(canvasElement);
    const controls = within(canvasElement);
    await userEvent.click(controls.getByRole("button", { name: "⤢" }));
    await expectDialogShowsWholeDiagram(canvasElement);
    const close = controls.getByRole("button", { name: "Close" });
    await whileOpen?.(close);
    await userEvent.click(close);
    await waitFor(() => expect(canvasElement.querySelector(".mermaid-modal")).toBeNull());
  });
}

/** On a phone, far narrower than the diagram, the expand dialog still shows all of it. */
export const MermaidStateDialogPhone: Story = {
  tags: ["paint-check"],
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: PIXEL_DISABLED },
  render: () => <MermaidColumn content={STATE_DIAGRAM_CONTENT} width={PHONE_COLUMN_WIDTH} />,
  play: ({ canvasElement }) => playDialog(canvasElement, PHONE_VIEWPORT),
};

/**
 * On Windows and Linux the desktop app draws the native window controls over the top right of its
 * title bar, and the bar moves the window. The Close button must start below it, and must not
 * sit in a drag region.
 */
async function expectCloseBelowTitleBar(close: HTMLElement) {
  const box = close.getBoundingClientRect();
  // The stand-in bar is a drag region, so the check below can tell a button inside it.
  await expect(windowDragsAtEach([{ x: box.right - 1, y: 1 }])).toEqual([true]);
  await expect(box.top).toBeGreaterThanOrEqual(DESKTOP_TITLEBAR_HEIGHT_PX);
  const corners = [
    { x: box.left + 1, y: box.top + 1 },
    { x: box.right - 1, y: box.top + 1 },
    { x: box.left + 1, y: box.bottom - 1 },
    { x: box.right - 1, y: box.bottom - 1 },
    { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
  ];
  await expect(windowDragsAtEach(corners)).toEqual(corners.map(() => false));
}

/** In the desktop app the expand dialog's Close button clears the title bar. */
export const MermaidStateDialogDesktop: Story = {
  tags: ["paint-check"],
  beforeEach: withDesktopApi({
    platform: "linux",
    isRosetta: false,
    getIsRosetta: () => Promise.resolve(false),
  }),
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: PIXEL_DISABLED },
  render: () => (
    <>
      <div
        className="titlebar-drag"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: DESKTOP_TITLEBAR_HEIGHT_PX,
        }}
      />
      <MermaidColumn content={STATE_DIAGRAM_CONTENT} width={LAPTOP_COLUMN_WIDTH} />
    </>
  ),
  play: ({ canvasElement }) =>
    playDialog(canvasElement, DESKTOP_VIEWPORT, expectCloseBelowTitleBar),
};

/**
 * A play cannot set env(safe-area-inset-*), so in Chromium the test runner sets a right inset with
 * CDP and checks the dialog against it (.storybook/test-runner.ts). WebKit plays it with no inset.
 */
export const MermaidStateDialogSideInset: Story = {
  tags: ["paint-check"],
  globals: { viewport: { value: "sideInset", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: PIXEL_DISABLED },
  render: () => <MermaidColumn content={STATE_DIAGRAM_CONTENT} width={340} />,
  play: ({ canvasElement }) => playDialog(canvasElement, SIDE_INSET_VIEWPORT),
};
