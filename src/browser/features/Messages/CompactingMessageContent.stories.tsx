import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ReactNode } from "react";
import { StreamingBarrierView } from "@/browser/features/Messages/ChatBarrier/StreamingBarrierView";
import { CompactingMessageContent } from "@/browser/features/Messages/CompactingMessageContent";
import { CompactionBackground } from "@/browser/features/Messages/CompactionBackground";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/Compaction",
  component: CompactingMessageContent,
} satisfies Meta<typeof CompactingMessageContent>;

export default meta;

type Story = StoryObj<typeof meta>;

const STREAMING_SUMMARY =
  "## Conversation Summary\n\nThe user requested help refactoring the codebase. Key changes made:\n\n- Restructured component hierarchy for better separation of concerns\n- Extracted shared utilities into dedicated modules\n- Improved type safety across API boundaries";

function CompactionStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl space-y-3">{props.children}</div>
    </div>
  );
}

function CompactingCard(props: { content: string }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-[var(--color-border-medium)] p-4">
      <CompactionBackground />
      <div className="relative z-10">
        <CompactingMessageContent>
          <MarkdownRenderer content={props.content} />
        </CompactingMessageContent>
      </div>
    </div>
  );
}

/** Streaming compaction with shimmer effect - tests GPU-accelerated animation */
export const StreamingCompaction: Story = {
  render: () => (
    <CompactionStoryShell>
      <CompactingCard content={STREAMING_SUMMARY} />
    </CompactionStoryShell>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the compaction shimmer effect during streaming. The shimmer uses GPU-accelerated CSS transforms instead of background-position animations to prevent frame drops.",
      },
    },
  },
};

/** Streaming compaction with configure hint - shows when no compaction model is set */
export const StreamingCompactionWithConfigureHint: Story = {
  render: () => (
    <CompactionStoryShell>
      <StreamingBarrierView
        statusText="Compacting conversation..."
        cancelText="hit Esc to cancel"
        hintElement={
          <span className="text-muted text-[11px]">
            No compaction model set —{" "}
            <button
              type="button"
              className="text-link cursor-pointer underline underline-offset-2"
              onClick={fn()}
            >
              configure
            </button>
          </span>
        }
      />
      <CompactingCard content="## Conversation Summary\n\nSummarizing the conversation..." />
    </CompactionStoryShell>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Shows the "configure" hint link in the streaming barrier during compaction when no custom compaction model is set. Clicking it opens Settings → Models.',
      },
    },
  },
};
