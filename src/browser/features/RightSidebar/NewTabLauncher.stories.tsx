import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "@storybook/test";
import { NewTabLauncher } from "./NewTabLauncher";
import { PIXEL_DISABLED } from "@/browser/stories/meta.js";

const meta = {
  title: "Features/RightSidebar/NewTabLauncher",
  component: NewTabLauncher,
  parameters: {
    layout: "fullscreen",
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  // The test runner ignores viewport globals; keep the layout narrow there too.
  decorators: [
    (Story) => (
      <div style={{ width: 375, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    tools: ["costs", "review", "instructions", "goal", "workflows", "timeline", "output"],
    onOpenTool: fn(),
    onOpenTerminal: fn(),
    onOpenSideChat: fn(),
    creatingSideChat: false,
    autoFocus: false,
    onAutoFocusConsumed: fn(),
  },
} satisfies Meta<typeof NewTabLauncher>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SideChatRow: Story = {
  // The composite sidebar scene covers appearance; retain the pinned phone/keyboard contract.
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("button", { name: "Side chat" });
    const terminal = canvas.getByRole("button", { name: "Terminal" });
    // Same list and keyboard navigation as every other launcher action, not a separate tip.
    await expect(row.parentElement).toBe(terminal.parentElement);
    terminal.focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(row).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onOpenSideChat).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{ArrowUp}");
    await expect(terminal).toHaveFocus();
    await userEvent.click(row);
    await expect(args.onOpenSideChat).toHaveBeenCalledTimes(2);
    const container = canvasElement.firstElementChild!;
    await expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    // The runner ignores globals, but local/Pixel phone viewports must hide keyboard hints.
    if (window.innerWidth <= 768) await expect(row.querySelector("kbd")).not.toBeVisible();
  },
};
