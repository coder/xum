import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { PAINT_CHECK_WAIT_EVENT } from "@/constants/mermaid";
import { lightweightMeta, PIXEL_DISABLED } from "./meta.js";

/**
 * Stories that exercise the paint-check guards of .storybook/test-runner.ts. Every story here
 * is valid or broken on purpose, so only `make test-storybook-paint-fixtures` runs them, and it
 * requires each one to fail with its expected message (or to pass). Without them, deleting a
 * guard from the runner would leave every real paint-check story green.
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
 * MUST PASS. The play ends before the diagram exists, and the diagram mounts only once the runner
 * has started to wait for it, so the story passes only when the runner waits and keeps polling.
 * A timer would not do: on a loaded host the diagram could mount before the runner looks.
 */
export const DiagramMountsWhenTheRunnerWaits: Story = {
  render: () => (
    <MountWhenRunnerWaits>
      <Page content={[GOOD_CHART, TEXT_AFTER].join("\n\n")} />
    </MountWhenRunnerWaits>
  ),
};
