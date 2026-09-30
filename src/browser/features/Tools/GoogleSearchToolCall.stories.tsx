import type { ReactNode } from "react";
import { waitFor, within } from "@storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { GoogleSearchToolCall } from "@/browser/features/Tools/GoogleSearchToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  SAMPLE_GOOGLE_SEARCH_QUERIES,
  SAMPLE_SEARCH_SUGGESTIONS_HTML,
} from "@/browser/features/Tools/GoogleSearchToolCall.fixtures";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/GoogleSearch",
  component: GoogleSearchToolCall,
} satisfies Meta<typeof GoogleSearchToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function GallerySection(props: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.label}
      </div>
      {props.children}
    </section>
  );
}

// Gallery composite: folds completed-expanded, executing, failed, and single-query
// collapsed variants into a single snapshot to keep the snapshot budget low
// (same pattern as AttachFileToolCall's Gallery).
export const Gallery: Story = {
  render: () => (
    <div className="bg-background p-6">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <GallerySection label="Completed with suggestions (expanded via play)">
          <GoogleSearchToolCall
            args={{ queries: SAMPLE_GOOGLE_SEARCH_QUERIES }}
            result={{ search_suggestions: SAMPLE_SEARCH_SUGGESTIONS_HTML }}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Executing (expanded via play)">
          <GoogleSearchToolCall
            args={{ queries: SAMPLE_GOOGLE_SEARCH_QUERIES.slice(0, 2) }}
            status="executing"
          />
        </GallerySection>
        <GallerySection label="Failed (expanded via play)">
          <GoogleSearchToolCall
            args={{ queries: [SAMPLE_GOOGLE_SEARCH_QUERIES[0] ?? ""] }}
            result={{ success: false, error: "Search quota exceeded" }}
            status="failed"
          />
        </GallerySection>
        <GallerySection label="Single query, collapsed">
          <GoogleSearchToolCall
            args={{ queries: [SAMPLE_GOOGLE_SEARCH_QUERIES[0] ?? ""] }}
            result={{ search_suggestions: SAMPLE_SEARCH_SUGGESTIONS_HTML }}
            status="completed"
          />
        </GallerySection>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Expand the first three instances (completed, executing, failed); keep the
    // last one collapsed to also snapshot the collapsed header state.
    const headers = canvas.getAllByText("Google Search");
    headers[0]?.click();
    headers[1]?.click();
    headers[2]?.click();
    await waitFor(() => canvas.getByText("Suggested searches"));
    await waitFor(() => canvas.getByText("Searching"));
    await waitFor(() => canvas.getByText("Search quota exceeded"));
  },
};
