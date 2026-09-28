import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta, PIXEL_DUAL_THEME } from "@/browser/stories/meta.js";
import { TranscriptHydrationSkeleton } from "./TranscriptHydrationSkeleton";

// Typed as bare `Meta` (not `Meta<typeof TranscriptHydrationSkeleton>`): the
// component takes no props, so the component-generic form conflicts with the
// spread of `lightweightMeta` (whose decorators are typed for arbitrary args).
const meta = {
  ...lightweightMeta,
  title: "App/Chat/TranscriptHydrationSkeleton",
  component: TranscriptHydrationSkeleton,
  render: () => (
    // Mirror the transcript's centered max-width column so the skeleton's line
    // widths read the same as real messages will.
    <div className="bg-background min-h-screen overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <TranscriptHydrationSkeleton workspaceId="story-workspace" />
      </div>
    </div>
  ),
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Shimmer placeholder shown while a workspace's transcript hydrates. Mimics a few
 * conversation turns (short user bubble + assistant prose lines) and fades toward
 * the bottom, so the loading state reads as "messages are arriving" rather than a
 * generic centered spinner.
 */
export const Default: Story = {
  parameters: { pixel: { matrix: PIXEL_DUAL_THEME } },
};
