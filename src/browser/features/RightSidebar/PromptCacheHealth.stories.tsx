import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";

import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import type { TurnCacheHealth } from "@/common/utils/tokens/cacheHealth";
import { PromptCacheHealth } from "./PromptCacheHealth";

const MINUTE = 60_000;
// The table shows absolute times, so a fixed timestamp keeps snapshots stable.
const now = STABLE_TIMESTAMP;

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
  // Play contracts only: the Pixel file budget is full, and RightSidebar's
  // CostsTabWithCacheCreate already snapshots this section inside the real Costs tab.
  parameters: { ...lightweightMeta.parameters, pixel: PIXEL_DISABLED },
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

/** Pixel's phone viewport width. */
const PHONE_WIDTH_PX = 390;

export const PhoneWidth: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  // The Storybook test runner ignores `globals.viewport` and plays at desktop size, so the
  // wrapper itself pins the phone width for the overflow check below.
  render: (args) => (
    <div
      data-testid="phone-width-frame"
      className="bg-background text-light font-primary p-2 text-[13px]"
      style={{ width: PHONE_WIDTH_PX }}
    >
      <PromptCacheHealth {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("phone-width-frame");
    const table = canvas.getByTestId("prompt-cache-turns");
    await expect(frame.getBoundingClientRect().width).toBe(PHONE_WIDTH_PX);
    // No right-edge overflow: neither the table nor its frame scrolls sideways.
    await expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
  },
};
