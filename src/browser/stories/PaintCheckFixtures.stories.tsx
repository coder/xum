import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { MermaidPendingFrame } from "@/browser/features/Messages/MermaidPendingFrame";
import { PAINT_CHECK_WAIT_EVENT } from "@/constants/mermaid";
import { lightweightMeta, PIXEL_DISABLED } from "./meta.js";

/**
 * Stories that exercise the guards of the paint-check runner (.storybook/test-runner.ts). Each
 * story trips a guard, or is valid on purpose, so only `make test-storybook-paint-fixtures` runs
 * them, and it requires each one to fail with its expected message (or to pass). Without them,
 * deleting a guard from the runner would leave every real paint-check story green.
 *
 * Only the guards named here are claimed: a guard that no story below names has no fixture. Each
 * one, with the story that turns red when it is disabled:
 * - A diagram that fails to render (the error marker): BrokenChartNextToGoodChart.
 * - A frame that never draws (every frame needs a drawing): DiagramNextToAFrameThatNeverDraws.
 * - The wait polls until a diagram mounts: DiagramMountsWhenTheRunnerWaits.
 * - Ink outside the diagram's box at rest: DiagramPaintsOutsideItsBox.
 * - Hiding the diagram changes no pixel inside its box at rest (the unseen check):
 *   DiagramOutsideTheViewport, DiagramInHiddenParent, DiagramUnderAnOverlay, DiagramClippedAway.
 * - The scrolled view of the unseen check counts the pixels that a diagram below the viewport
 *   changes: DiagramBelowTheFoldSeenWhenScrolled.
 * - The scrolled view does not count a diagram that nobody sees: DiagramBelowTheFoldInHiddenParent.
 *
 * The fixture run sets a short render timeout for the runner (PAINT_CHECK_RENDER_TIMEOUT_ENV in
 * src/constants/mermaid.ts), so the story whose frame never draws does not wait the runner's whole
 * default.
 *
 * - "!test" keeps them out of the default `make test-storybook` run.
 * - The paint-fixture tag lets `--includeTags` pick them, and the WebKit step excludes it.
 * - PIXEL_DISABLED keeps them out of Pixel snapshots and the snapshot budget.
 * - The paint-check tag is the one the runner's postVisit reads. Storybook reads tags only from
 *   string literals, so do not spread or share this array.
 */
const meta = {
  ...lightweightMeta,
  title: "Tests/PaintCheckFixtures",
  component: MarkdownRenderer,
  tags: ["!test", "paint-check", "paint-fixture"],
  parameters: { ...lightweightMeta.parameters, pixel: PIXEL_DISABLED },
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;

type Story = StoryObj<typeof meta>;

const GOOD_CHART = ["```mermaid", "flowchart LR", "  A[Start] --> B[Done]", "```"].join("\n");
// The same chart that Mermaid.test.tsx uses for a parse error.
const BROKEN_CHART = ["```mermaid", "graph TD", "A-->", "```"].join("\n");
// The runner compares a diagram with the page around it, so it needs text after the diagram.
const TEXT_AFTER = "This paragraph follows the diagrams, so there is page below them to compare.";

function Page(props: { content: string; style?: React.CSSProperties }) {
  return (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600, ...props.style }}>
        <MarkdownRenderer content={props.content} />
      </div>
    </div>
  );
}

/** Mounts its children when the runner starts to wait for a diagram, not before. */
function MountWhenRunnerWaits(props: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const mount = () => setMounted(true);
    window.addEventListener(PAINT_CHECK_WAIT_EVENT, mount);
    return () => window.removeEventListener(PAINT_CHECK_WAIT_EVENT, mount);
  }, []);
  return mounted ? props.children : null;
}

/**
 * MUST FAIL with "must show a rendered Mermaid diagram". A diagram that fails to render replaces
 * its whole frame with an error block, so the good chart alone satisfies "every frame has a
 * drawing". Only the runner's error-marker check can fail this story.
 */
export const BrokenChartNextToGoodChart: Story = {
  render: () => <Page content={[GOOD_CHART, BROKEN_CHART, TEXT_AFTER].join("\n\n")} />,
};

/**
 * MUST FAIL with "must show a rendered Mermaid diagram". One diagram draws. The other frame is the
 * pending placeholder that Mermaid shows before it draws, and it never draws or shows an error
 * marker, as when a render never finishes. The runner waits until every frame has a drawing, so
 * only its count of drawn diagrams against frames can fail this story: a wait that stopped at the
 * first drawing would pass it.
 */
export const DiagramNextToAFrameThatNeverDraws: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600 }}>
        <MarkdownRenderer content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
        <MermaidPendingFrame />
      </div>
    </div>
  ),
};

/**
 * MUST FAIL with "must change pixels inside its box". The diagram renders, and nothing outside its
 * box changes when it is hidden, so only the runner's viewport check can fail this story. The box
 * lies off the viewport, so hiding the diagram changes no pixel the runner can see.
 */
export const DiagramOutsideTheViewport: Story = {
  render: () => (
    <Page
      content={[GOOD_CHART, TEXT_AFTER].join("\n\n")}
      style={{ position: "relative", left: -5000 }}
    />
  ),
};

/**
 * MUST FAIL with "paint only inside its box". The frame is built by hand, not drawn by Mermaid: the
 * runner reads only the frame, its svg and the page around them. Its second shape sits 120 px below
 * the svg's box, and the frame has neither the clip nor the paint containment of a real
 * .mermaid-container, as when iPhone Safari painted a diagram outside its frame. The runner hides
 * the svg and finds ink outside its box that went away with it.
 */
export const DiagramPaintsOutsideItsBox: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600 }}>
        <div className="mermaid-container" style={{ overflow: "visible", contain: "none" }}>
          <svg width={240} height={80} style={{ width: 240, height: 80, overflow: "visible" }}>
            <rect width={240} height={80} style={{ fill: "var(--color-accent)" }} />
            <rect y={200} width={240} height={40} style={{ fill: "var(--color-danger)" }} />
          </svg>
        </div>
        <p>{TEXT_AFTER}</p>
      </div>
    </div>
  ),
};

/**
 * MUST FAIL with "must change pixels inside its box", as do the other stories that lay out a
 * diagram inside the viewport that no one can see. Nothing outside its box changes when the runner
 * hides it, so only the viewport check can fail the story. This one sits in a parent with
 * visibility: hidden. The text after the diagram gives the runner a page to compare.
 */
export const DiagramInHiddenParent: Story = {
  render: () => (
    <Page content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} style={{ visibility: "hidden" }} />
  ),
};

/**
 * MUST FAIL like DiagramInHiddenParent. An overlay in the page's own colour covers the diagram
 * and the text after it.
 */
export const DiagramUnderAnOverlay: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600, position: "relative" }}>
        <MarkdownRenderer content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            background: "var(--color-background)",
          }}
        />
      </div>
    </div>
  ),
};

/**
 * MUST FAIL like DiagramInHiddenParent. A parent of height 0 with overflow: hidden clips the
 * diagram away.
 */
export const DiagramClippedAway: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600 }}>
        <div style={{ height: 0, overflow: "hidden" }}>
          <MarkdownRenderer content={GOOD_CHART} />
        </div>
        <p>{TEXT_AFTER}</p>
      </div>
    </div>
  ),
};

/**
 * MUST FAIL like DiagramInHiddenParent. A tall spacer puts the diagram below the viewport, so the
 * runner also scrolls it into view to compare, and the hidden parent keeps it unseen there too. The
 * at-rest view fails this story with the same message, so it does not show that the scrolled view
 * runs (DiagramBelowTheFoldSeenWhenScrolled does). It turns red when the scrolled view credits a
 * diagram that no pixel shows.
 */
export const DiagramBelowTheFoldInHiddenParent: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600 }}>
        <div style={{ height: 1500 }} />
        <div style={{ visibility: "hidden" }}>
          <MarkdownRenderer content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
        </div>
      </div>
    </div>
  ),
};

/**
 * MUST PASS. The same page as DiagramBelowTheFoldInHiddenParent, but the diagram is visible. A tall
 * spacer puts it below the viewport, so hiding it at rest changes no pixel the runner can see, and
 * only the runner's scrolled view can pass the story. The text after the diagram gives that view a
 * page to compare. Disabling the scrolled view, or dropping its pixels from the count, fails it.
 */
export const DiagramBelowTheFoldSeenWhenScrolled: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: 600 }}>
        <div style={{ height: 1500 }} />
        <MarkdownRenderer content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
      </div>
    </div>
  ),
};

/**
 * MUST PASS. The story has no play, and its diagram mounts only once the runner has started to
 * wait for it, so the story passes only when the runner waits and keeps polling. A timer would not
 * do: on a loaded host the diagram could mount before the runner looks.
 */
export const DiagramMountsWhenTheRunnerWaits: Story = {
  render: () => (
    <MountWhenRunnerWaits>
      <Page content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
    </MountWhenRunnerWaits>
  ),
};
