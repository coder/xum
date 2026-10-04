import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { LegacyPlanImportNotice } from "./LegacyPlanImportBanner";

const client = createMockORPCClient();

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/LegacyPlanImportBanner",
  component: LegacyPlanImportNotice,
  // Kept out of Pixel snapshots (the repo's snapshot budget is full); the Phone play below checks
  // the narrow layout, and the PR carries screenshots of the real app.
  parameters: { ...lightweightMeta.parameters, pixel: PIXEL_DISABLED },
  args: {
    workspaceId: "older-ssh-row",
    legacyPlanPath: "/home/dev/.mux/plans/checkout-service/feature-login-x7k2.md",
    onSettled: fn(),
  },
  render: (args) => (
    <APIProvider client={client}>
      <div className="bg-background flex min-h-[160px] items-start p-4">
        <div className="w-full max-w-3xl">
          <LegacyPlanImportNotice {...args} />
        </div>
      </div>
    </APIProvider>
  ),
} satisfies Meta<typeof LegacyPlanImportNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An SSH workspace from before #5174 whose only plan is at the shared pre-#5174 path. */
export const Default: Story = {};

/** The long host path wraps instead of overflowing on a phone. */
export const Phone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  render: (args) => (
    <APIProvider client={client}>
      {/* The test-runner applies no viewport: force the phone width here. */}
      <div className="bg-background w-[375px] p-2">
        <LegacyPlanImportNotice {...args} />
      </div>
    </APIProvider>
  ),
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>(
      '[data-component="LegacyPlanImportBanner"]'
    );
    await expect(row).not.toBeNull();
    await expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth);
    await expect(within(canvasElement).getByRole("button", { name: "Import plan" })).toBeVisible();
  },
};
