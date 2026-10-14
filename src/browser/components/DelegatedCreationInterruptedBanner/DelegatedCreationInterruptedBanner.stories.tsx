import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { DelegatedCreationInterruptedNotice } from "./DelegatedCreationInterruptedBanner";

const client = createMockORPCClient();

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/DelegatedCreationInterruptedBanner",
  component: DelegatedCreationInterruptedNotice,
  // Kept out of Pixel snapshots (the repo's snapshot budget is full); the Phone play below still
  // checks the narrow layout, and the PR carries desktop and 390 px screenshots of the real app.
  parameters: { ...lightweightMeta.parameters, pixel: PIXEL_DISABLED },
  args: {
    workspaceId: "orphan",
    workspace: { name: "fix-login-redirect" },
    confirm: fn(() => Promise.resolve(false)),
    removeWorkspace: fn(() => Promise.resolve({ success: true })),
  },
  render: (args) => (
    <APIProvider client={client}>
      <div className="bg-background flex min-h-[180px] items-start p-4">
        <div className="w-full max-w-3xl">
          <DelegatedCreationInterruptedNotice {...args} />
        </div>
      </div>
    </APIProvider>
  ),
} satisfies Meta<typeof DelegatedCreationInterruptedNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A delegated workspace whose creating task died before its setup finished (#4983). */
export const Default: Story = {};

/** The actions wrap instead of overflowing on a phone. */
export const Phone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: (args) => (
    <APIProvider client={client}>
      {/* The test-runner applies no viewport: force the phone width here. */}
      <div className="bg-background w-[390px] p-2">
        <DelegatedCreationInterruptedNotice {...args} />
      </div>
    </APIProvider>
  ),
  play: async ({ canvasElement }) => {
    const banner = canvasElement.querySelector<HTMLElement>(
      '[data-component="DelegatedCreationInterruptedBanner"]'
    );
    await expect(banner).not.toBeNull();
    await expect(banner!.scrollWidth).toBeLessThanOrEqual(banner!.clientWidth);
    await expect(
      within(canvasElement).getByRole("button", { name: "Remove workspace…" })
    ).toBeVisible();
  },
};
