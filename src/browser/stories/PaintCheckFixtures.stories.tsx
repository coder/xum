import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { PAINT_CHECK_WAIT_EVENT } from "@/constants/mermaid";
import { lightweightMeta, PIXEL_DISABLED } from "./meta.js";

/**
 * Stories that exercise four guards of the paint-check runner (.storybook/test-runner.ts): the
 * diagram wait, the error marker, the viewport check and the paint-outside check. Each story
 * trips one guard, or is valid on purpose, so only `make test-storybook-paint-fixtures` runs them,
 * and it requires each one to fail with its expected message (or to pass). Without them, deleting
 * a guard from the runner would leave every real paint-check story green.
 *
 * Not covered: the runner's count of drawn diagrams against frames (a frame that never draws and
 * shows no error marker). A story for it would wait the runner's whole render timeout on every CI
 * run.
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
 * MUST FAIL with "never overlaps the viewport". The diagram renders, and nothing outside its box
 * changes when it is hidden, so only the runner's viewport check can fail this story.
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
