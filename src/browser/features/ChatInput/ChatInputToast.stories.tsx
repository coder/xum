import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { ChatInputToast } from "./ChatInputToast";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ChatInputToast",
  component: ChatInputToast,
  // Kept out of Pixel snapshots (the repo's snapshot budget is full); the play below checks the
  // narrow layout.
  parameters: { ...lightweightMeta.parameters, pixel: PIXEL_DISABLED },
  args: { onDismiss: fn(), wrap: false, toast: null },
} satisfies Meta<typeof ChatInputToast>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A long message in wide glyphs on a phone (a plugin hook notice wraps to many lines): the message
 * scrolls inside the toast, and the dismiss button stays on screen (Codex PRRT_kwDOPxxmWM6rRJDd).
 * The text is longer than any notice, so the check holds at every test-runner window height.
 */
export const LongNoticeOnPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  args: {
    toast: {
      id: "plugin-hook-notice",
      type: "error",
      title: "guard",
      message: "検査に失敗しました。".repeat(200),
    },
  },
  render: (args) => (
    // The test-runner applies no viewport: force the phone width here.
    <div className="bg-background w-[375px] p-2">
      <ChatInputToast {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const toast = within(canvasElement).getByRole("alert");
    // The message is capped at 40vh: the whole toast fits in half the window.
    await expect(toast.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
    const dismiss = within(toast).getByRole("button", { name: "Dismiss" });
    await expect(dismiss.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    const message = within(toast).getByText(/検査に失敗しました/);
    await expect(message.scrollHeight).toBeGreaterThan(message.clientHeight);
  },
};
