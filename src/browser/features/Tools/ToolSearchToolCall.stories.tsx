import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolSearchToolCall } from "@/browser/features/Tools/ToolSearchToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/ToolSearch",
  component: ToolSearchToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Excluded because the repo-wide Pixel snapshot budget is at its ceiling.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof ToolSearchToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const MATCHES = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository with title, body, and labels.",
  },
  {
    name: "github_search_issues",
    description: "Search issues and pull requests across repositories using GitHub's query syntax.",
  },
  {
    name: "github_add_issue_comment",
    description: "Add a comment to an existing GitHub issue.",
  },
];

/** Executing: query visible, no result yet. */
export const Pending: Story = {
  args: {
    args: { query: "create github issue" },
    status: "executing",
  },
};

/** Completed with matches (expanded to show names + descriptions). */
export const Matches: Story = {
  args: {
    args: { query: "create github issue" },
    status: "completed",
    defaultExpanded: true,
    result: {
      query: "create github issue",
      matches: MATCHES,
      totalDeferred: 24,
    },
  },
};

/** Completed with zero matches (expanded to show the empty-state copy). */
export const ZeroMatches: Story = {
  args: {
    args: { query: "quantum flux capacitor" },
    status: "completed",
    defaultExpanded: true,
    result: {
      query: "quantum flux capacitor",
      matches: [],
      totalDeferred: 24,
    },
  },
};

/** Failed call (expanded to show the error box). */
export const Failed: Story = {
  args: {
    args: { query: "create github issue" },
    status: "failed",
    defaultExpanded: true,
    result: {
      success: false,
      error: "Tool execution aborted",
    },
  },
};

/** Narrow (~375px) container: match count hides, query truncates. */
export const NarrowContainer: Story = {
  args: {
    args: { query: "a fairly long tool discovery query that should truncate" },
    status: "completed",
    result: {
      query: "a fairly long tool discovery query that should truncate",
      matches: MATCHES,
      totalDeferred: 24,
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 280 }}>
        <Story />
      </div>
    ),
  ],
};
