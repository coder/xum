import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";

import { lightweightMeta } from "@/browser/stories/meta.js";
import type { TurnCacheHealth } from "@/common/utils/tokens/cacheHealth";
import { PromptCacheHealth } from "./PromptCacheHealth";

const MINUTE = 60_000;
// Relative to render time so the "Nm ago" labels stay stable across snapshot runs.
const now = Date.now();

const TURNS: TurnCacheHealth[] = [
  {
    messageId: "turn-4",
    timestamp: now - 2.5 * MINUTE,
    readRatio: 0.96,
    cacheWriteTokens: 3_200,
    rewriteCostUsd: 0.0128,
    coldStart: false,
  },
  {
    messageId: "turn-3",
    timestamp: now - 7.5 * MINUTE,
    readRatio: 0.91,
    cacheWriteTokens: 8_400,
    rewriteCostUsd: 0.0336,
    coldStart: false,
  },
  {
    // A 1h-TTL cache expired after a long pause: the whole prefix was rewritten.
    messageId: "turn-2",
    timestamp: now - 72.5 * MINUTE,
    readRatio: 0.02,
    cacheWriteTokens: 118_000,
    rewriteCostUsd: 0.472,
    coldStart: true,
  },
  {
    messageId: "turn-1",
    timestamp: now - 75.5 * MINUTE,
    readRatio: 0.88,
    cacheWriteTokens: 12_000,
    rewriteCostUsd: 0.048,
    coldStart: false,
  },
];

const SESSION = {
  readRatio: 0.71,
  cacheWriteTokens: 141_600,
  rewriteCostUsd: 0.5664,
  coldStart: false,
};

const meta = {
  ...lightweightMeta,
  title: "Features/RightSidebar/PromptCacheHealth",
  component: PromptCacheHealth,
  args: { session: SESSION, turns: TURNS },
} satisfies Meta<typeof PromptCacheHealth>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Costs tab section at a typical right-sidebar width. */
export const SidebarWidth: Story = {
  render: (args) => (
    <div className="bg-background text-light font-primary w-[350px] p-4 text-[13px]">
      <PromptCacheHealth {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("row")).toHaveLength(TURNS.length + 1);
    await expect(canvas.getAllByText("cold")).toHaveLength(1);
  },
};

export const PhoneWidth: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { viewports: ["phone"] },
    },
  },
  render: (args) => (
    <div className="bg-background text-light font-primary w-full p-2 text-[13px]">
      <PromptCacheHealth {...args} />
    </div>
  ),
};
